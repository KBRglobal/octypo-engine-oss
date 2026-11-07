import { describe, it, expect } from "vitest";

import { scoreArticle } from "../score-article.js";
import { extractStructure } from "../extract.js";
import { loadQualityGateConfig } from "../config.js";
import type { ArticleQualityInput } from "../types.js";
import { goodArticle } from "../__fixtures__/articles.js";
import { scoreSerpAlignment } from "./serp-alignment.js";

const config = loadQualityGateConfig();

function run(input: ArticleQualityInput) {
  return scoreSerpAlignment(input, extractStructure(input), config);
}

/** A minimal input where every alignment check passes. */
const aligned: ArticleQualityInput = {
  title: "How Much Does LED Screen Rental Cost?",
  h1: "How Much Does LED Screen Rental Cost in 2026?",
  metaTitle: "LED Screen Rental Cost: Full Price Guide",
  metaDescription:
    "LED screen rental cost starts from a fixed day rate. What the price includes, what drives it, and how to compare quotes.",
};

describe("serp-alignment — H1 shape", () => {
  it("passes a question-form H1", () => {
    const c = run({ ...aligned, h1: "How much does led screen rental cost" });
    expect(c.evidence).toMatchObject({ h1Shape: true });
  });

  it("passes an H1 that carries a ? even mid-sentence question form", () => {
    const c = run({ ...aligned, h1: "LED screen rental: what does it cost?" });
    expect(c.evidence).toMatchObject({ h1Shape: true });
  });

  it("passes a non-Latin H1 with its own question mark", () => {
    const c = run({
      title: "كم تكلفة استئجار شاشة عرض",
      h1: "كم تكلفة استئجار شاشة عرض متنقلة؟",
      metaTitle: "كم تكلفة استئجار شاشة عرض",
      metaDescription: "كم تكلفة استئجار شاشة عرض متنقلة للفعاليات: السعر وما يشمله وما يؤثر فيه.",
    });
    expect(c.evidence).toMatchObject({ h1Shape: true });
    expect(c.status).toBe("pass");
  });

  it("passes an H1 that contains a number", () => {
    const c = run({ ...aligned, h1: "7 Rules of LED Screen Rental Cost" });
    expect(c.evidence).toMatchObject({ h1Shape: true });
  });

  it("fails a declarative, digit-free H1 and never blocks on it", () => {
    const input = {
      ...aligned,
      h1: "LED Screen Rental Cost Explained For Buyers",
    };
    const c = run(input);
    expect(c.evidence).toMatchObject({ h1Shape: false });
    expect(c.status).toBe("fail");
    expect(c.blocking).toBe(false);
    const report = scoreArticle(input);
    expect(report.blockingFailures).not.toContain("serp-alignment");
  });
});

describe("serp-alignment — token agreement", () => {
  it("passes fully-agreeing title, h1 and meta description on all three checks", () => {
    const c = run(aligned);
    expect(c.status).toBe("pass");
    expect(c.score).toBe(1);
    expect(c.evidence).toMatchObject({
      h1Shape: true,
      titleAgreement: true,
      descriptionAgreement: true,
    });
  });

  it("fails the agreement check when the meta description is about a different topic", () => {
    const c = run({
      ...aligned,
      metaDescription:
        "Choosing a wedding venue near the beach with catering options and free parking spaces available all summer season.",
    });
    expect(c.evidence).toMatchObject({ descriptionAgreement: false });
    expect(c.status).toBe("fail");
    expect(c.blocking).toBe(false);
  });

  it("fails the title agreement when the meta title shares no tokens with the h1", () => {
    const c = run({ ...aligned, metaTitle: "Wedding Venue Catering Options Guide" });
    expect(c.evidence).toMatchObject({ titleAgreement: false });
    expect(c.status).toBe("fail");
  });

  it("scores passedChecks/3", () => {
    const c = run({
      ...aligned,
      h1: "LED Screen Rental Cost Explained For Buyers", // shape fails
    });
    expect(c.score).toBeCloseTo(2 / 3, 5);
  });
});

describe("serp-alignment — skip and integration", () => {
  it("skips when h1 and title are both absent", () => {
    const c = run({ title: "", h1: null, metaTitle: null, metaDescription: null });
    expect(c.status).toBe("skipped");
  });

  it("appears in the scoreArticle report", () => {
    const report = scoreArticle(goodArticle);
    expect(report.criteria.some(c => c.id === "serp-alignment")).toBe(true);
  });

  it("never gates: an article failing only serp-alignment still passes above threshold", () => {
    const input: ArticleQualityInput = {
      ...goodArticle,
      // Break only the serp-alignment shape: declarative digit-free H1 whose
      // tokens still agree with the meta title (keyword intact).
      title: "Deposit Deduction Rules For Every Tenant Moving Out",
      h1: "Deposit Deduction Rules For Every Tenant Moving Out",
    };
    const report = scoreArticle(input);
    const serp = report.criteria.find(c => c.id === "serp-alignment");
    expect(serp?.status).toBe("fail");
    expect(serp?.blocking).toBe(false);
    expect(report.blockingFailures).not.toContain("serp-alignment");
  });
});
