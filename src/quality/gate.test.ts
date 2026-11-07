import { describe, it, expect, vi, beforeEach } from "vitest";

import { advisoryAfterRounds, applyQualityGate, qualityContextFromContent, qualityInputFromApproval, qualityIssues } from "./gate.js";
import { scoreArticle } from "./score-article.js";
import { publishFixRounds } from "../octypo/publish-policy.js";
import {
  goodArticle,
  fabricatedStatArticle,
  PUBLISHED_SLUGS,
  SOURCE_MATERIAL,
} from "./__fixtures__/articles.js";
import type { ArticleApprovalInput } from "../octypo/gatekeeper/types.js";

// Gate 2 calls out to whichever LLM engine is healthy. The point of these tests
// is the gate, not the model, so the registry is replaced with a stub that
// always returns a glowing review — the case that matters, because that is
// exactly when a silent defect gets published.
const generateWithEngine = vi.fn();

vi.mock("../services/engine-registry.js", () => ({
  EngineRegistry: {
    // No fast tier in this test: the review then falls through to the normal
    // queue, which is exactly what an install without ANTHROPIC_API_KEY does.
    getFastEngine: () => null,
    getNextByProviderPreference: () => ({ id: "stub", isHealthy: true }),
    getNextFromQueue: () => ({ id: "stub", isHealthy: true }),
    reportSuccess: () => {},
    reportError: () => {},
  },
  generateWithEngine: (...args: unknown[]) => generateWithEngine(...args),
}));

const GLOWING_REVIEW = JSON.stringify({
  overallQuality: 95,
  aeoScore: 90,
  decision: "approve",
  issues: [],
  corrections: [],
  publicationReady: true,
  reasoning: "Excellent piece.",
  editorNotes: "Ship it.",
});

function approvalInput(overrides: Partial<ArticleApprovalInput> = {}): ArticleApprovalInput {
  return {
    contentId: "content-1",
    title: goodArticle.title,
    metaTitle: goodArticle.metaTitle ?? "",
    metaDescription: goodArticle.metaDescription ?? "",
    summary: "A deposit deduction has to be evidenced.",
    blocks: (goodArticle.blocks ?? []) as unknown[],
    wordCount: 567,
    writerId: "writer-1",
    ...overrides,
  };
}

const context = {
  primaryKeyword: goodArticle.primaryKeyword,
  heroImage: goodArticle.heroImage,
  heroImageAlt: goodArticle.heroImageAlt,
  structuredData: goodArticle.structuredData,
  publishedSlugs: PUBLISHED_SLUGS,
  targetWordCount: goodArticle.targetWordCount,
  sourceMaterial: SOURCE_MATERIAL,
  siteUrl: goodArticle.siteUrl,
};

describe("applyQualityGate", () => {
  const passing = scoreArticle(goodArticle);
  const failing = scoreArticle(fabricatedStatArticle);

  it("leaves a passing article approved", () => {
    expect(applyQualityGate("approve", passing, 0, 2)).toBe("approve");
  });

  it("holds a failing article the reviewer wanted to approve", () => {
    expect(applyQualityGate("approve", failing, 0, 2)).toBe("revise");
  });

  it("never turns a hold into a publish", () => {
    expect(applyQualityGate("revise", passing, 0, 2)).toBe("revise");
    expect(applyQualityGate("reject", passing, 0, 2)).toBe("reject");
  });

  it("stops asking for revisions once the budget is spent, instead of looping", () => {
    // A "revise" here would queue another revision job, which re-reviews, fails
    // again and revises again — unbounded paid LLM calls.
    expect(applyQualityGate("approve", failing, 2, 2)).toBe("reject");
    expect(applyQualityGate("approve", failing, 5, 2)).toBe("reject");
  });

  it("publishes an approved article whose only blockers are editorial polish once the rounds are spent", () => {
    const polish = {
      ...passing,
      passed: false,
      blockingFailures: ["answer-capsule", "keyword-placement"] as typeof passing.blockingFailures,
    };
    expect(applyQualityGate("approve", polish, 0, 2)).toBe("revise");
    expect(applyQualityGate("approve", polish, 2, 2)).toBe("approve");
  });

  it("never relaxes an integrity blocker, a score under the threshold, or the off switch", () => {
    const integrity = { ...passing, passed: false, blockingFailures: ["fabricated-stats"] as typeof passing.blockingFailures };
    expect(applyQualityGate("approve", integrity, 2, 2)).toBe("reject");
    const mixed = { ...passing, passed: false, blockingFailures: ["answer-capsule", "slug-readable"] as typeof passing.blockingFailures };
    expect(applyQualityGate("approve", mixed, 2, 2)).toBe("reject");
    const low = { ...passing, passed: false, score: passing.threshold - 1, blockingFailures: ["answer-capsule"] as typeof passing.blockingFailures };
    expect(applyQualityGate("approve", low, 2, 2)).toBe("reject");
    const polish = { ...passing, passed: false, blockingFailures: ["answer-capsule"] as typeof passing.blockingFailures };
    expect(advisoryAfterRounds(polish, { QUALITY_ADVISORY_AFTER_ROUNDS: "false" })).toBe(false);
  });
});

describe("qualityInputFromApproval", () => {
  it("carries explicit context through", () => {
    const input = qualityInputFromApproval(approvalInput(), context);
    expect(input.primaryKeyword).toBe("deposit deduction");
    expect(input.publishedSlugs).toEqual(PUBLISHED_SLUGS);
    expect(scoreArticle(input).passed).toBe(true);
  });

  it("picks up fields a caller passed through from the contents row", () => {
    const withRowFields = {
      ...approvalInput(),
      primaryKeyword: "deposit deduction",
      heroImage: goodArticle.heroImage,
      heroImageAlt: goodArticle.heroImageAlt,
      seoSchema: goodArticle.structuredData,
    } as unknown as ArticleApprovalInput;
    const input = qualityInputFromApproval(withRowFields);
    expect(input.primaryKeyword).toBe("deposit deduction");
    expect(input.heroImage).toBe(goodArticle.heroImage);
    expect(input.structuredData).toBe(goodArticle.structuredData);
  });

  it("skips rather than fails the criteria it has no data for", () => {
    const report = scoreArticle(qualityInputFromApproval(approvalInput()));
    const skipped = report.criteria.filter(c => c.status === "skipped").map(c => c.id);
    expect(skipped).toContain("keyword-placement");
    expect(skipped).toContain("keyword-density");
  });
});

describe("Gate 2 wiring", () => {
  beforeEach(() => {
    generateWithEngine.mockReset();
    generateWithEngine.mockResolvedValue(GLOWING_REVIEW);
    delete process.env.QUALITY_GATE_ENABLED;
    delete process.env.QUALITY_GATE_THRESHOLD;
    delete process.env.PUBLISH_FIX_ROUNDS;
  });

  async function review(input: ArticleApprovalInput, ctx: object, revisionCount = 0) {
    const { Gate2Approver } = await import("../octypo/gatekeeper/gate2-approver.js");
    return new Gate2Approver().review(input, revisionCount, ctx);
  }

  it("publishes a good article the reviewer approved", async () => {
    const result = await review(approvalInput(), context);
    expect(result.decision).toBe("approve");
    expect(result.publicationReady).toBe(true);
    expect(result.qualityReport?.passed).toBe(true);
  });

  it("holds an article with a fabricated statistic even when the reviewer loves it", async () => {
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context
    );
    expect(result.decision).not.toBe("approve");
    expect(result.publicationReady).toBe(false);
    expect(result.qualityReport?.blockingFailures).toContain("fabricated-stats");
  });

  it("tells the editor exactly why it was held", async () => {
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context
    );
    expect(result.editorNotes).toMatch(/Deterministic quality gate/);
    expect(result.editorNotes).toContain("68%");
    expect(result.reasoning).toMatch(/deterministic quality gate/i);
    expect(qualityIssues(result.qualityReport!).some(i => i.severity === "critical")).toBe(true);
  });

  it("hands the writer correction instructions naming the defect", async () => {
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context
    );
    expect(result.corrections?.length).toBeGreaterThan(0);
    expect(result.revisionPrompt).toContain("68%");
  });

  it("holds terminally once the revision budget is spent", async () => {
    // The reviewer approved, so the gate's own extra rounds count too.
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context,
      2 + publishFixRounds()
    );
    expect(result.decision).toBe("reject");
    expect(result.publicationReady).toBe(false);
  });

  it("gives a reviewer-approved article extra rounds for mechanical findings", async () => {
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context,
      2
    );
    expect(result.decision).toBe("revise");
  });

  it("rejects at the plain budget when the extra rounds are switched off", async () => {
    process.env.PUBLISH_FIX_ROUNDS = "0";
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context,
      2
    );
    expect(result.decision).toBe("reject");
    expect(result.publicationReady).toBe(false);
  });

  it("can be switched off without touching code", async () => {
    process.env.QUALITY_GATE_ENABLED = "false";
    const result = await review(
      approvalInput({ blocks: (fabricatedStatArticle.blocks ?? []) as unknown[] }),
      context
    );
    expect(result.decision).toBe("approve");
    expect(result.qualityReport).toBeUndefined();
  });

  it("takes its threshold from the environment", async () => {
    process.env.QUALITY_GATE_THRESHOLD = "101";
    const result = await review(approvalInput(), context);
    expect(result.decision).not.toBe("approve");
    expect(result.qualityReport?.threshold).toBe(101);
  });

  it("does not hold an article the scorer has no data to judge", async () => {
    // An unwired caller must not have every article silently held; the
    // criteria that lack input report "skipped" and the rest still score.
    const result = await review(
      approvalInput(),
      { structuredData: goodArticle.structuredData, heroImage: goodArticle.heroImage, heroImageAlt: goodArticle.heroImageAlt, publishedSlugs: PUBLISHED_SLUGS, targetWordCount: goodArticle.targetWordCount }
    );
    expect(result.decision).toBe("approve");
  });
});

describe("qualityContextFromContent — the scorer judges what publish will put on the page", () => {
  const row = {
    id: "c1",
    title: "How much it costs to rent a mobile LED screen for a day",
    slug: "led-screen-daily-price",
    metaDescription: "A single day runs from 4,000 to 15,000 depending on the unit.",
    summary: null,
    heroImage: "https://cdn.example/hero.webp",
    heroImageAlt: "A mobile LED screen on a street at dusk with people walking past",
    primaryKeyword: "led screen rental price",
    // The commercial writer keeps its audit payload here — null when clean.
    seoSchema: null,
    faq: [],
    publishedAt: null,
    writerId: "commercial",
  };

  it("builds the publish-time JSON-LD rather than reading the writer's audit column", () => {
    const ctx = qualityContextFromContent(row);
    const entries = ctx.structuredData as Record<string, unknown>[];
    const article = entries.find((e) => e["@type"] === "Article");
    expect(article).toBeDefined();
    expect(article?.headline).toBe(row.title);
    expect(article?.description).toBe(row.metaDescription);
    expect(article?.author).toBeTruthy();
    expect(article?.datePublished).toBeTruthy();
  });

  it("hands the scorer the row's hero image, alt text and keyword", () => {
    const ctx = qualityContextFromContent(row);
    expect(ctx.heroImage).toBe(row.heroImage);
    expect(ctx.heroImageAlt).toBe(row.heroImageAlt);
    expect(ctx.primaryKeyword).toBe(row.primaryKeyword);
  });

  it("that schema passes the structured-data criterion", () => {
    const ctx = qualityContextFromContent(row);
    const report = scoreArticle({ ...goodArticle, structuredData: ctx.structuredData });
    const criterion = report.criteria.find((c) => c.id === "structured-data");
    expect(criterion?.status).toBe("pass");
  });
});
