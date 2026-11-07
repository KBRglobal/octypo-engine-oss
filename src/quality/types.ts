/**
 * Types for the deterministic article quality scorer.
 *
 * Deterministic, not LLM-judged: the same article must always produce the same
 * verdict. A publishing gate that changes its mind between runs is worse than
 * no gate at all — a customer paying €799/month cannot be told "the reviewer
 * felt differently today", and a failure a human cannot reproduce cannot be
 * fixed.
 */

export type CriterionId =
  | "keyword-placement"
  | "keyword-density"
  | "meta-lengths"
  | "structured-data"
  | "hero-image"
  | "internal-links"
  | "word-count"
  | "fabricated-stats"
  | "serp-alignment"
  | "answer-capsule"
  | "title-freshness"
  | "source-primary"
  | "slug-readable";

/**
 * "skipped" is deliberately distinct from "pass". A criterion whose input was
 * never supplied has not been satisfied — it has not been *checked*. Collapsing
 * the two would let an unwired caller silently earn a perfect score.
 */
export type CriterionStatus = "pass" | "fail" | "skipped";

export interface CriterionResult {
  id: CriterionId;
  label: string;
  status: CriterionStatus;
  /** How much of this criterion the article satisfied, 0..1. */
  score: number;
  weight: number;
  /**
   * A blocking failure holds the article regardless of the total score, because
   * some defects (broken JSON-LD, an invented statistic) are not compensable by
   * doing well elsewhere.
   */
  blocking: boolean;
  /** Plain-language reasons. This is what a human reads to know WHY it failed. */
  details: string[];
  evidence?: Record<string, unknown>;
}

export interface ArticleQualityReport {
  /** Weighted 0-100 over the criteria that were actually checked. */
  score: number;
  threshold: number;
  passed: boolean;
  blockingFailures: CriterionId[];
  criteria: CriterionResult[];
  /** One-line verdict, safe to put in a log line or an editor's UI. */
  summary: string;
}

export interface QualityBlock {
  type: string;
  id?: string;
  data?: Record<string, unknown> | null;
}

export interface QualityFaq {
  question: string;
  answer: string;
}

export interface WordCountRange {
  min: number;
  max: number;
}

export interface ArticleQualityInput {
  title: string;
  /** Defaults to `title`: the blog renders the article title as the page H1. */
  h1?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  primaryKeyword?: string | null;
  blocks?: QualityBlock[] | null;
  heroImage?: string | null;
  heroImageAlt?: string | null;
  /**
   * The direct answer shown above the fold. `undefined` = not supplied
   * (criterion skipped); null or empty = supplied and missing (fails).
   */
  answerCapsule?: string | null;
  /** Derived from the `faq` blocks when omitted. */
  faqs?: QualityFaq[] | null;
  /** The stored `seoSchema`: a JSON string, one object, or an array of them. */
  structuredData?: unknown;
  /** Slugs that genuinely exist and are published, for internal-link checking. */
  publishedSlugs?: string[] | null;
  targetWordCount?: WordCountRange | null;
  /** RSS summary / uploaded document text the article was written from. */
  sourceMaterial?: string | string[] | null;
  /** Tenant host, so an absolute link back to the same site counts as internal. */
  siteUrl?: string | null;
  /** The article's URL slug. `undefined` = not supplied (criterion skipped). */
  slug?: string | null;
  /**
   * Every source URL the article cites. `undefined` = not supplied (skipped);
   * an empty array = supplied and missing, which fails.
   */
  sourceUrls?: string[] | null;
  /**
   * Official pages that were actually opened while writing, with when. The
   * evidence behind any "not yet announced" claim in the text.
   */
  primarySources?: Array<{ url: string; checkedAt: string }> | null;
  /** The clock the date-sensitive criteria use. Defaults to the real one. */
  now?: Date;
}

export interface QualityGateConfig {
  /** Weighted score an article must reach to be publishable. */
  threshold: number;
  /** When false the report is still produced, but it never holds an article. */
  enabled: boolean;
  metaTitleMax: number;
  metaDescriptionMin: number;
  metaDescriptionMax: number;
  /** Keyword density band, in percent of visible prose words. */
  keywordDensityMin: number;
  keywordDensityMax: number;
  /** Density above this is stuffing so severe it blocks on its own. */
  keywordDensityBlockAbove: number;
  minInternalLinks: number;
  /** Word band for the answer capsule — the editor's standard, blocking. */
  capsuleWordsMin: number;
  capsuleWordsMax: number;
  defaultWordCount: WordCountRange;
  weights: Record<CriterionId, number>;
}
