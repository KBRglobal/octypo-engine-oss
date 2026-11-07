/**
 * The integration point: does the engine's own state ever claim success for a
 * remote write that did not happen?
 *
 * Everything below the publish path is mocked — this test is only about the
 * ordering rule in publish.ts, which is the one rule that cannot be verified
 * from inside an adapter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Record<string, unknown>[] = [];
const row = {
  title: "Deposit rules",
  slug: "deposit-rules",
  metaDescription: "meta",
  summary: "summary",
  heroImage: "https://cdn.test/hero.png",
  heroImageAlt: "Keys",
  blocks: [{ id: "t", type: "text", data: { content: "<p>Body</p>" } }],
  writerId: "w_1",
  answerCapsule: "In short.",
  faq: [],
  category: "guide",
  excerpt: "excerpt",
  tags: ["deposits"],
};

vi.mock("../db.js", () => {
  const select = () => ({
    from: () => ({
      leftJoin: () => ({ where: async () => [row] }),
      where: async () => [{ id: "c_1", status: "scheduled" }],
    }),
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          updates.push(values);
          return [{ id: "c_1", slug: "deposit-rules", ...values }];
        },
      }),
    }),
  });
  return { db: { select, update } };
});

vi.mock("../lib/indexing.js", () => ({ submitToIndexNow: async () => undefined }));
vi.mock("../lib/site-notify.js", () => ({ notifyBlog: async () => true, notifySiteDeploy: async () => true }));

const resolveTargets = vi.fn();
const deliverArticle = vi.fn();
vi.mock("../publishing/index.js", () => ({ resolveTargets, deliverArticle }));

const { publishContentById } = await import("./publish.js");

beforeEach(() => {
  updates.length = 0;
  resolveTargets.mockReset();
  deliverArticle.mockReset();
});

describe("publishContentById with remote targets", () => {
  it("publishes locally, untouched, when no target is configured", async () => {
    resolveTargets.mockReturnValue([]);

    const result = await publishContentById("c_1");

    expect(result.ok).toBe(true);
    expect(updates.some((u) => u.status === "published")).toBe(true);
    expect(deliverArticle).not.toHaveBeenCalled();
  });

  it("marks the article published only after every target accepted it", async () => {
    resolveTargets.mockReturnValue([{ id: "wordpress:x", kind: "wordpress" }]);
    deliverArticle.mockResolvedValue({ ok: true, retryable: false, results: [], degraded: [] });

    const result = await publishContentById("c_1");

    expect(result.ok).toBe(true);
    expect(updates.some((u) => u.status === "published")).toBe(true);
  });

  // The rule this whole file exists for.
  it("does NOT mark the article published when a target failed", async () => {
    resolveTargets.mockReturnValue([{ id: "wordpress:x", kind: "wordpress" }]);
    deliverArticle.mockResolvedValue({
      ok: false,
      retryable: true,
      results: [],
      degraded: [],
    });

    const result = await publishContentById("c_1");

    expect(result).toMatchObject({ ok: false, reason: "target_failed", retryable: true });
    // The claim may flip to 'publishing' and restore to 'scheduled', but the
    // row must NEVER reach 'published' — no read API can serve an article
    // WordPress never received, and the scheduler retries next tick.
    expect(updates.some((u) => u.status === "published")).toBe(false);
  });

  it("passes the article's real content to the targets, not a summary of it", async () => {
    resolveTargets.mockReturnValue([{ id: "wordpress:x", kind: "wordpress" }]);
    deliverArticle.mockResolvedValue({ ok: true, retryable: false, results: [], degraded: [] });

    await publishContentById("c_1");

    const [source] = deliverArticle.mock.calls[0];
    expect(source).toMatchObject({
      id: "c_1",
      title: "Deposit rules",
      slug: "deposit-rules",
      category: "guide",
      tags: ["deposits"],
      heroImage: "https://cdn.test/hero.png",
      state: "published",
    });
    expect(source.blocks).toHaveLength(1);
    // The JSON-LD handed to a target must be the one built for this publish,
    // with the real publication date — not whatever was on the row before.
    expect(Array.isArray(source.seoSchema)).toBe(true);
    expect(source.publishedAt).toBeInstanceOf(Date);
  });

  it("reports a permanent target failure as not worth retrying", async () => {
    resolveTargets.mockReturnValue([{ id: "wordpress:x", kind: "wordpress" }]);
    deliverArticle.mockResolvedValue({ ok: false, retryable: false, results: [], degraded: [] });

    const result = await publishContentById("c_1");
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
