/**
 * The hard gates added on 2026-09-15 after one live article showed every
 * defect at once (a stale season in the title, a Google News "source", a
 * transliterated slug, a description cut mid-sentence, no internal links).
 * Each rule is pinned here against the realistic fixture.
 */
import { describe, it, expect } from "vitest";

import { goodArticle, PUBLISHED_SLUGS } from "../__fixtures__/articles.js";
import { scoreArticle } from "../score-article.js";
import type { ArticleQualityReport, CriterionId } from "../types.js";

function criterion(report: ArticleQualityReport, id: CriterionId) {
  const found = report.criteria.find(c => c.id === id);
  if (!found) throw new Error(`criterion ${id} missing`);
  return found;
}

const now = new Date("2026-09-15T08:00:00Z");

describe("meta description completeness", () => {
  it("blocks a description that stops mid-sentence", () => {
    const report = scoreArticle({
      ...goodArticle,
      metaDescription: "A deposit deduction has to be evidenced, reasonable and tied to real damage, and the landlord must",
    });
    const c = criterion(report, "meta-lengths");
    expect(c.status).toBe("fail");
    expect(c.blocking).toBe(true);
    expect(report.blockingFailures).toContain("meta-lengths");
  });

  it("keeps a short-but-whole description advisory, not blocking", () => {
    const report = scoreArticle({ ...goodArticle, metaDescription: "Short but a whole sentence." });
    const c = criterion(report, "meta-lengths");
    expect(c.status).toBe("fail");
    expect(c.blocking).toBe(false);
  });
});

describe("internal links against the site's real pages", () => {
  it("blocks when the page list is known and the links do not reach it", () => {
    const report = scoreArticle({ ...goodArticle, publishedSlugs: ["something-else-entirely"] });
    const c = criterion(report, "internal-links");
    expect(c.status).toBe("fail");
    expect(c.blocking).toBe(true);
  });

  it("stays a grade when no page list was supplied", () => {
    const c = criterion(scoreArticle({ ...goodArticle, publishedSlugs: null }), "internal-links");
    expect(c.blocking).toBe(false);
  });

  it("passes the fixture against its own published set", () => {
    const c = criterion(scoreArticle({ ...goodArticle, publishedSlugs: PUBLISHED_SLUGS }), "internal-links");
    expect(c.status).toBe("pass");
  });
});

describe("the three new criteria ride in the report", () => {
  it("skip cleanly when their inputs are absent, so older callers still score", () => {
    const report = scoreArticle({ ...goodArticle, now, slug: undefined, sourceUrls: undefined });
    expect(criterion(report, "source-primary").status).toBe("skipped");
    expect(criterion(report, "slug-readable").status).toBe("skipped");
    expect(criterion(report, "title-freshness").status).toBe("pass");
    expect(report.passed).toBe(true);
  });

  it("hold the article when supplied and wrong", () => {
    const report = scoreArticle({
      ...goodArticle,
      now,
      title: "Deposit deduction rules 2024-2025",
      slug: "klalim-lnikoi-pikdon",
      sourceUrls: ["https://news.google.com/rss/articles/CBMiAAA?oc=5"],
    });
    expect(report.passed).toBe(false);
    expect(report.blockingFailures).toEqual(
      expect.arrayContaining(["title-freshness", "slug-readable", "source-primary"])
    );
  });
});
