/**
 * Criterion 10: the answer capsule — the paragraph an answer engine quotes
 * and the first thing a reader sees.
 *
 * Measured in words. The editor's standard is 40-60: below that it is a
 * teaser rather than an answer, above it is an introduction. Blocking, because
 * the capsule is the one paragraph the site puts above the fold on every
 * article and it cannot be compensated by a strong body.
 */

import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build, skipped } from "./result.js";

const LABEL = "Answer capsule length";

export function countWords(text: string): number {
  return text
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(token => /[\p{L}\p{N}]/u.test(token)).length;
}

export function scoreAnswerCapsule(
  input: ArticleQualityInput,
  config: QualityGateConfig
): CriterionResult {
  if (input.answerCapsule === undefined) {
    return skipped(config, "answer-capsule", LABEL, "No answer capsule was supplied to the scorer.");
  }
  const capsule = (input.answerCapsule ?? "").trim();
  const words = countWords(capsule);
  const { capsuleWordsMin: min, capsuleWordsMax: max } = config;

  if (!capsule) {
    return build(config, {
      id: "answer-capsule",
      label: LABEL,
      status: "fail",
      score: 0,
      blocking: true,
      details: ["The answer capsule is missing."],
      evidence: { words: 0, min, max },
    });
  }

  if (words < min || words > max) {
    // Partial credit for being near the band, so a 38-word capsule scores
    // higher than a 12-word one even though both are held.
    const distance = words < min ? min - words : words - max;
    return build(config, {
      id: "answer-capsule",
      label: LABEL,
      status: "fail",
      score: Math.max(0, 1 - distance / min),
      blocking: true,
      details: [
        words < min
          ? `The answer capsule is ${words} words — it must be at least ${min} to answer the question rather than tease it.`
          : `The answer capsule is ${words} words — the maximum is ${max}; keep it quotable in one breath.`,
      ],
      evidence: { words, min, max },
    });
  }

  return build(config, {
    id: "answer-capsule",
    label: LABEL,
    status: "pass",
    score: 1,
    details: [`Answer capsule is ${words} words.`],
    evidence: { words, min, max },
  });
}
