/**
 * Criterion 7: length against the article's own target.
 *
 * Counted from the prose rather than trusting the stored `wordCount`, which is
 * written by the writer step and never re-derived — if a revision truncated the
 * body, the stored number would still describe the article that no longer
 * exists.
 */

import type { ArticleStructure } from "../extract.js";
import { wordCount } from "../text.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Word count";

export function scoreWordCount(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const range = input.targetWordCount ?? config.defaultWordCount;
  const actual = wordCount(structure.prose);
  const evidence = { actual, min: range.min, max: range.max };

  if (actual >= range.min && actual <= range.max) {
    return build(config, {
      id: "word-count",
      label: LABEL,
      status: "pass",
      score: 1,
      details: [`${actual} words, inside the ${range.min}–${range.max} target.`],
      evidence,
    });
  }

  const tooShort = actual < range.min;
  return build(config, {
    id: "word-count",
    label: LABEL,
    status: "fail",
    score: tooShort
      ? Math.max(0, actual / Math.max(1, range.min))
      : Math.max(0, 1 - (actual - range.max) / Math.max(1, range.max)),
    details: [
      tooShort
        ? `${actual} words is too short — the target is ${range.min}–${range.max}.`
        : `${actual} words is too long — the target is ${range.min}–${range.max}.`,
    ],
    evidence,
  });
}
