/**
 * What happens to a scheduled article the editorial quality gate refuses?
 *
 * The gate is deterministic against the corpus, so a blocked article cannot
 * pass on the next tick by itself. Restoring it to `scheduled` made the
 * publisher claim, audit and release the same row every 60 seconds forever,
 * left it permanently overdue (the fleet monitor then reported "the publisher
 * is not running" while it was running the whole time), and showed nobody in
 * the Studio that anything needed fixing. A blocked article is parked as
 * `in_review`, the same way a permanent delivery failure is.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Record<string, unknown>[] = [];
const row = {
  title: "Asbestos in older buildings",
  slug: "asbestos-older-buildings",
  metaDescription: "meta",
  summary: "summary",
  heroImage: "https://cdn.test/hero.webp",
  heroImageAlt: "An inspector checking a ceiling panel in an older apartment",
  blocks: [{ id: "t", type: "text", data: { content: "<p>Body</p>" } }],
  writerId: "w_1",
  answerCapsule: "In short.",
  faq: [],
  category: "guide",
  excerpt: "excerpt",
  tags: ["safety"],
};

vi.mock("../db.js", () => {
  const select = () => ({
    from: () => ({
      leftJoin: () => ({ where: async () => [row] }),
      where: async () => [{ id: "c_1", status: "scheduled" }],
    }),
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      const where = () => {
        updates.push(values);
        const result = Promise.resolve([{ id: "c_1", slug: row.slug, ...values }]);
        return Object.assign(result, {
          returning: async () => [{ id: "c_1", slug: row.slug, ...values }],
        });
      };
      return { where };
    },
  });
  return { db: { select, update } };
});

vi.mock("../lib/indexing.js", () => ({ submitToIndexNow: async () => undefined }));
vi.mock("../lib/site-notify.js", () => ({ notifyBlog: async () => true, notifySiteDeploy: async () => true }));
vi.mock("../publishing/index.js", () => ({ resolveTargets: () => [], deliverArticle: vi.fn() }));

const auditContentAgainstCorpus = vi.fn();
vi.mock("./content-quality.js", () => ({ auditContentAgainstCorpus }));

const { publishContentById } = await import("./publish.js");

beforeEach(() => {
  updates.length = 0;
  auditContentAgainstCorpus.mockReset();
});

describe("publishContentById when the editorial quality gate blocks", () => {
  it("parks the article in review instead of handing it back to the scheduler", async () => {
    auditContentAgainstCorpus.mockResolvedValue([
      {
        code: "CORPUS_STRUCTURE",
        message: "The meaningful heading sequence duplicates another article.",
        matchedSlugs: ["another-article"],
      },
    ]);

    const result = await publishContentById("c_1");

    expect(result).toMatchObject({ ok: false, reason: "content_quality" });
    const parked = updates.find((u) => u.status === "in_review");
    expect(parked).toBeDefined();
    // A stale slot would keep it out of the auto-slotter after a later approve.
    expect(parked?.scheduledFor).toBeNull();
    expect(updates.some((u) => u.status === "scheduled")).toBe(false);
    expect(updates.some((u) => u.status === "published")).toBe(false);
  });

  it("still publishes when the gate has nothing to say", async () => {
    auditContentAgainstCorpus.mockResolvedValue([]);

    const result = await publishContentById("c_1");

    expect(result.ok).toBe(true);
    expect(updates.some((u) => u.status === "published")).toBe(true);
    expect(updates.some((u) => u.status === "in_review")).toBe(false);
  });
});
