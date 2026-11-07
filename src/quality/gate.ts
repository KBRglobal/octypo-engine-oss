/**
 * The bridge between the pure scorer and Gate 2.
 *
 * Kept out of `score-article.ts` so the scorer itself stays free of gatekeeper
 * vocabulary and can be reused by the admin QA endpoint, a backfill script, or
 * a test, without dragging the approval pipeline along with it.
 */

import type {
  ArticleApprovalInput,
  ApprovalDecision,
  CorrectionInstruction,
  QualityIssue,
} from "../octypo/gatekeeper/types.js";
import { schemaGenerator } from "../octypo/aeo.js";
import type { FAQ } from "../octypo/types.js";
import { SITE_URL } from "../config/domain.js";
import { formatQualityReport } from "./score-article.js";
import type { ArticleQualityInput, ArticleQualityReport, QualityBlock } from "./types.js";

/**
 * Everything the deterministic scorer needs that `ArticleApprovalInput` does
 * not carry today. Supplying none of it is safe — the affected criteria report
 * "skipped" rather than inventing a verdict — but a caller that supplies it
 * gets the full eight-criterion gate.
 */
export interface ArticleQualityContext {
  primaryKeyword?: string | null;
  heroImage?: string | null;
  heroImageAlt?: string | null;
  structuredData?: unknown;
  publishedSlugs?: string[] | null;
  targetWordCount?: { min: number; max: number } | null;
  /** The RSS summary or document text the article was written from. */
  sourceMaterial?: string | string[] | null;
  siteUrl?: string | null;
  slug?: string | null;
  sourceUrls?: string[] | null;
  primarySources?: Array<{ url: string; checkedAt: string }> | null;
  now?: Date;
}

/** The columns of a `contents` row the review context is built from. */
export interface ReviewableContent {
  id: string;
  title: string;
  slug?: string | null;
  metaDescription?: string | null;
  summary?: string | null;
  heroImage?: string | null;
  heroImageAlt?: string | null;
  primaryKeyword?: string | null;
  faq?: FAQ[] | null;
  publishedAt?: Date | null;
  writerId?: string | null;
}

/**
 * The scorer's context for a stored article: what publish will actually put
 * on the page, not what the writer left in the row.
 *
 * `seoSchema` is not the page's JSON-LD: the commercial writer stores its audit
 * payload there (null when every gate is clean) and publish overwrites the
 * column with freshly generated Article + BreadcrumbList markup. Reading the
 * column at review time therefore failed the structured-data criterion for
 * every clean commercial article — a blocking failure, so each one was
 * revised, rejected and parked in review while nothing reached the site. The
 * schema is generated here exactly as publish generates it, and the hero and
 * keyword columns ride along so those criteria score instead of skipping.
 */
export function qualityContextFromContent(content: ReviewableContent): ArticleQualityContext {
  const writer = typeof content.writerId === "string" ? content.writerId.trim() : "";
  const structuredData = schemaGenerator.generateFullSchema({
    title: content.title,
    description: content.metaDescription || content.summary || "",
    slug: content.slug || content.id,
    heroImage: content.heroImage ?? null,
    faqs: content.faq ?? [],
    authorName: writer && writer !== "[object Object]" ? writer : undefined,
    publishedAt: content.publishedAt ?? new Date(),
  });
  return {
    structuredData,
    slug: content.slug ?? null,
    heroImage: content.heroImage ?? null,
    heroImageAlt: content.heroImageAlt ?? null,
    primaryKeyword: content.primaryKeyword ?? null,
    siteUrl: SITE_URL ?? null,
  };
}

/** Reads a field the declared input type does not have but the row may carry. */
function loose<T>(source: unknown, key: string): T | undefined {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return value === undefined ? undefined : (value as T);
}

export function qualityInputFromApproval(
  input: ArticleApprovalInput,
  context: ArticleQualityContext = {}
): ArticleQualityInput {
  return {
    title: input.title,
    metaTitle: input.metaTitle,
    metaDescription: input.metaDescription,
    // The approval input is built from the `contents` row in more than one
    // place; where a caller passes the row through, these fields are already
    // there, so read them opportunistically before falling back to context.
    primaryKeyword: context.primaryKeyword ?? loose<string>(input, "primaryKeyword") ?? null,
    blocks: (input.blocks ?? []) as QualityBlock[],
    // Left undefined (criterion skipped) when the caller never wired it; the
    // orchestrator passes "" for a row without one so that case fails.
    answerCapsule: input.answerCapsule ?? loose<string>(input, "answerCapsule"),
    heroImage: context.heroImage ?? loose<string>(input, "heroImage") ?? null,
    heroImageAlt: context.heroImageAlt ?? loose<string>(input, "heroImageAlt") ?? null,
    structuredData: context.structuredData ?? loose<unknown>(input, "seoSchema") ?? null,
    publishedSlugs: context.publishedSlugs ?? null,
    targetWordCount: context.targetWordCount ?? null,
    sourceMaterial: context.sourceMaterial ?? loose<string>(input, "sourceMaterial") ?? null,
    siteUrl: context.siteUrl ?? null,
    slug: context.slug ?? loose<string>(input, "slug"),
    sourceUrls: context.sourceUrls,
    primarySources: context.primarySources ?? null,
    now: context.now,
  };
}

const CATEGORY_BY_CRITERION: Record<string, QualityIssue["category"]> = {
  "keyword-placement": "seo",
  "keyword-density": "seo",
  "meta-lengths": "seo",
  "structured-data": "aeo",
  "hero-image": "structure",
  "internal-links": "structure",
  "word-count": "structure",
  "fabricated-stats": "accuracy",
  "answer-capsule": "aeo",
};

export function qualityIssues(report: ArticleQualityReport): QualityIssue[] {
  return report.criteria
    .filter(criterion => criterion.status === "fail")
    .map(criterion => ({
      category: CATEGORY_BY_CRITERION[criterion.id] ?? "structure",
      severity: criterion.blocking ? ("critical" as const) : ("major" as const),
      description: `${criterion.label}: ${criterion.details.join(" ")}`,
      location: criterion.label,
      suggestion: criterion.details[0] ?? "Fix the issue described above.",
    }));
}

export function qualityCorrections(report: ArticleQualityReport): CorrectionInstruction[] {
  return report.criteria
    .filter(criterion => criterion.status === "fail")
    .map(criterion => ({
      section: criterion.label,
      issue: criterion.details.join(" "),
      instruction: criterion.details.join(" "),
      priority: criterion.blocking ? ("must_fix" as const) : ("should_fix" as const),
    }));
}

/**
 * What the deterministic gate does to an LLM verdict of "approve".
 *
 * Once the writer has used up its revision budget, asking for another revision
 * would queue a revision job that re-reviews and fails again — an unbounded
 * loop of paid LLM calls. "reject" in this codebase leaves the article as a
 * draft and stops processing, which is exactly "held, not published", so that
 * is the terminal hold.
 */
export function applyQualityGate(
  llmDecision: ApprovalDecision,
  report: ArticleQualityReport,
  revisionCount: number,
  maxRevisionsAllowed: number
): ApprovalDecision {
  if (llmDecision !== "approve" || report.passed) return llmDecision;
  if (revisionCount < maxRevisionsAllowed) return "revise";
  return advisoryAfterRounds(report) ? "approve" : "reject";
}

/**
 * Findings that are editorial polish, not integrity: where the keyword sits,
 * how long the capsule or meta description is, link count, word count. They
 * are fixed by editor rounds while rounds remain. Once the rounds are spent
 * they must not hold an article the reviewer approved: a client who pays per
 * article got none for a week because a capsule was 39 words instead of 40
 * Integrity findings (invented numbers,
 * missing primary sources, unreadable slug, stale title, no hero image,
 * keyword stuffing) never relax.
 */
const ADVISORY_AFTER_ROUNDS: ReadonlySet<string> = new Set([
  "keyword-placement",
  "answer-capsule",
  "meta-lengths",
  "internal-links",
  "word-count",
  "serp-alignment",
  "structured-data",
]);

export function advisoryAfterRounds(report: ArticleQualityReport, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.QUALITY_ADVISORY_AFTER_ROUNDS === "false") return false;
  if (report.score < report.threshold) return false;
  return report.blockingFailures.length > 0 && report.blockingFailures.every((id) => ADVISORY_AFTER_ROUNDS.has(id));
}

/** The breakdown, rendered for the editor note attached to a held article. */
export function qualityEditorNote(report: ArticleQualityReport): string {
  return `Deterministic quality gate\n${formatQualityReport(report)}`;
}
