/**
 * Criterion 9: SERP alignment — does the page look like what a searcher clicks?
 *
 * Three cheap, deterministic observations drawn from the SEO-consultant audit:
 * an H1 shaped as a question or carrying a number wins the click; a meta title
 * that shares no vocabulary with the H1 reads as bait-and-switch; a meta
 * description about a different topic loses the SERP snippet entirely.
 *
 * A GRADE, never a gate: `blocking` is always false. None of these shapes is a
 * correctness defect — an article with a declarative H1 can still be the right
 * article — so the criterion informs the operator without ever holding a draft.
 */

import type { ArticleStructure } from "../extract.js";
import { normalizedTokens } from "../text.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build, round2, skipped } from "./result.js";

const LABEL = "SERP alignment";

/** Question openers: a first word from this set marks a question-form H1. */
const QUESTION_WORDS = new Set([
  "how", "what", "why", "when", "which", "who", "where",
  "is", "are", "do", "does", "can", "should",
]);

/** Content tokens: letters/digits, length >= 3, normalized like the audits. */
function contentTokens(text: string): Set<string> {
  return new Set(normalizedTokens(text).filter(t => t.length >= 3));
}

/** Overlap coefficient: |A ∩ B| / min(|A|, |B|). Zero when either side is empty. */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  return inter / Math.min(a.size, b.size);
}

/** Question-form ("?" or a question-word opener) or carries a digit. */
function h1ShapeOk(h1: string): boolean {
  if (/[?\u061F\uFF1F]/.test(h1) || /\p{N}/u.test(h1)) return true;
  // The raw first word, punctuation stripped — a question word buried
  // mid-sentence does not make the heading a question.
  const first = normalizedTokens(h1)[0] ?? "";
  return QUESTION_WORDS.has(first);
}

export function scoreSerpAlignment(
  input: ArticleQualityInput,
  _structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const h1 = (input.h1 ?? input.title ?? "").trim();
  const title = (input.title ?? "").trim();
  if (!h1 && !title) {
    return skipped(
      config,
      "serp-alignment",
      LABEL,
      "Neither an H1 nor a title was supplied, so SERP alignment could not be checked."
    );
  }

  const metaTitle = (input.metaTitle ?? input.title ?? "").trim();
  const metaDescription = (input.metaDescription ?? "").trim();

  const h1Tokens = contentTokens(h1);
  const titleAndH1 = new Set([...contentTokens(title), ...h1Tokens]);

  const titleOverlap = round2(overlapCoefficient(contentTokens(metaTitle), h1Tokens));
  const descriptionOverlap = round2(
    overlapCoefficient(contentTokens(metaDescription), titleAndH1)
  );

  const checks = {
    h1Shape: h1ShapeOk(h1),
    titleAgreement: titleOverlap >= 0.3,
    descriptionAgreement: descriptionOverlap >= 0.2,
  };

  const details: string[] = [];
  if (!checks.h1Shape) {
    details.push(
      "H1 is declarative and digit-free — a question form or a concrete number wins the SERP click."
    );
  }
  if (!checks.titleAgreement) {
    details.push(
      `Meta title and H1 share too little vocabulary (overlap ${titleOverlap}, needs ≥ 0.3) — the SERP promise and the page disagree.`
    );
  }
  if (!checks.descriptionAgreement) {
    details.push(
      `Meta description barely overlaps the title/H1 (overlap ${descriptionOverlap}, needs ≥ 0.2) — it reads as a different topic.`
    );
  }

  const passedCount = Object.values(checks).filter(Boolean).length;

  return build(config, {
    id: "serp-alignment",
    label: LABEL,
    status: passedCount === 3 ? "pass" : "fail",
    score: passedCount / 3,
    // A grade, not a gate — by design this criterion can never hold an article.
    blocking: false,
    details:
      details.length === 0
        ? ["H1 shape and title/description vocabulary all align with the search intent."]
        : details,
    evidence: { ...checks, titleOverlap, descriptionOverlap },
  });
}
