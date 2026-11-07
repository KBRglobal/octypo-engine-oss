/**
 * An editor's correction to a live article must reach the customer's site.
 *
 * The first live batch on a git-delivered site showed the gap: Studio edits
 * updated the engine row, POST /publish short-circuited ("already published"),
 * and the site kept the old text. Re-delivery is the publish payload again,
 * with the ORIGINAL publication date, pushed through the same targets.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const publishedAt = new Date("2026-09-11T10:00:00Z");
let row: Record<string, unknown>;

vi.mock("../db.js", () => {
  const select = () => ({
    from: () => ({
      leftJoin: () => ({ where: async () => [row] }),
    }),
  });
  return { db: { select } };
});

vi.mock("../lib/indexing.js", () => ({ submitToIndexNow: async () => undefined }));
vi.mock("../lib/site-notify.js", () => ({ notifyBlog: async () => true, notifySiteDeploy: async () => true }));

const resolveTargets = vi.fn();
const deliverArticle = vi.fn();
vi.mock("../publishing/index.js", () => ({ resolveTargets, deliverArticle }));

const { redeliverPublishedContent } = await import("./publish.js");

beforeEach(() => {
  resolveTargets.mockReset();
  deliverArticle.mockReset();
  row = {
    id: "c_1",
    status: "published",
    publishedAt,
    title: "Deposit rules",
    slug: "deposit-rules",
    metaDescription: "meta",
    summary: "summary",
    heroImage: "https://cdn.test/hero.png",
    heroImageAlt: "Keys",
    blocks: [{ id: "t", type: "text", data: { content: "<p>Corrected body</p>" } }],
    writerId: "w_1",
    answerCapsule: "In short.",
    seoSchema: [{ "@type": "Article" }],
    faq: [],
    category: "guide",
    excerpt: "excerpt",
    tags: ["deposits"],
    sourceUrl: "https://example.com/news",
  };
});

describe("redeliverPublishedContent", () => {
  it("pushes the edited article through the targets with its original publication date", async () => {
    resolveTargets.mockReturnValue([{ id: "astro-git:x", kind: "astro-git" }]);
    deliverArticle.mockResolvedValue({ ok: true, retryable: false, results: [], degraded: [] });

    const result = await redeliverPublishedContent("c_1");

    expect(result).toMatchObject({ ok: true });
    const [source] = deliverArticle.mock.calls[0];
    expect(source).toMatchObject({
      id: "c_1",
      slug: "deposit-rules",
      state: "published",
      publishedAt,
      answerCapsule: "In short.",
      sourceUrl: "https://example.com/news",
    });
    expect(source.blocks[0].data.content).toContain("Corrected body");
  });

  it("does nothing for an article that is not live", async () => {
    row.status = "in_review";
    resolveTargets.mockReturnValue([{ id: "astro-git:x", kind: "astro-git" }]);

    const result = await redeliverPublishedContent("c_1");

    expect(result).toMatchObject({ ok: false, reason: "not_published" });
    expect(deliverArticle).not.toHaveBeenCalled();
  });

  it("is a no-op without targets", async () => {
    resolveTargets.mockReturnValue([]);

    const result = await redeliverPublishedContent("c_1");

    expect(result).toMatchObject({ ok: true });
    expect(deliverArticle).not.toHaveBeenCalled();
  });

  it("reports a failed target instead of pretending the site updated", async () => {
    resolveTargets.mockReturnValue([{ id: "astro-git:x", kind: "astro-git" }]);
    deliverArticle.mockResolvedValue({ ok: false, retryable: true, results: [], degraded: [] });

    const result = await redeliverPublishedContent("c_1");

    expect(result).toMatchObject({ ok: false, reason: "target_failed", retryable: true });
  });
});
