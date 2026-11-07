/**
 * Criteria 1 and 2: where the target keyword sits, and how often it appears.
 *
 * Both directions matter. An article that never states its own keyword ranks
 * for nothing; an article that states it thirty times reads like spam to a
 * person and like spam to a search engine, which is the failure mode a
 * "write SEO copy" prompt produces all by itself.
 */

import type { ArticleStructure } from "../extract.js";
import { containsPhrase, countPhrase, firstWords, wordCount } from "../text.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build, round2, skipped } from "./result.js";

const PLACEMENT_LABEL = "Target keyword placement";
const DENSITY_LABEL = "Keyword density";

export function scoreKeywordPlacement(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const keyword = (input.primaryKeyword ?? "").trim();
  if (!keyword) {
    return skipped(
      config,
      "keyword-placement",
      PLACEMENT_LABEL,
      "No target keyword was supplied, so placement could not be checked."
    );
  }

  const h1 = (input.h1 ?? input.title ?? "").trim();
  // Sub-headings are H2 by convention here; anything deeper still counts as a
  // sub-heading for the purpose of "the keyword appears in a section title".
  const subHeadings = structure.headings.filter(h => h.level >= 2).map(h => h.text);
  const opening = firstWords(structure.prose, 100);

  const checks = {
    inTitle: containsPhrase(input.title ?? "", keyword),
    inH1: containsPhrase(h1, keyword),
    inMetaDescription: containsPhrase(input.metaDescription ?? "", keyword),
    inFirst100Words: containsPhrase(opening, keyword),
    inAnyH2: subHeadings.some(h => containsPhrase(h, keyword)),
  };

  const missing: string[] = [];
  if (!checks.inTitle) missing.push(`Title does not contain "${keyword}".`);
  if (!checks.inH1) missing.push(`H1 does not contain "${keyword}".`);
  if (!checks.inMetaDescription) missing.push(`Meta description does not contain "${keyword}".`);
  if (!checks.inFirst100Words) missing.push(`"${keyword}" is absent from the first 100 words.`);
  if (!checks.inAnyH2) missing.push(`No H2 contains "${keyword}".`);

  const passedCount = Object.values(checks).filter(Boolean).length;
  const score = passedCount / 5;

  return build(config, {
    id: "keyword-placement",
    label: PLACEMENT_LABEL,
    status: missing.length === 0 ? "pass" : "fail",
    score,
    // Three or more misses means the article is not really about its keyword.
    // That is not an editing note, it is the wrong article.
    blocking: passedCount <= 2,
    details:
      missing.length === 0
        ? [`"${keyword}" is present in the title, H1, meta description, opening and an H2.`]
        : missing,
    evidence: { keyword, ...checks },
  });
}

export function scoreKeywordDensity(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const keyword = (input.primaryKeyword ?? "").trim();
  if (!keyword) {
    return skipped(
      config,
      "keyword-density",
      DENSITY_LABEL,
      "No target keyword was supplied, so density could not be checked."
    );
  }

  const totalWords = wordCount(structure.prose);
  const occurrences = countPhrase(structure.prose, keyword);
  const keywordWords = Math.max(1, wordCount(keyword));
  const densityPercent =
    totalWords === 0 ? 0 : round2(((occurrences * keywordWords) / totalWords) * 100);

  const { keywordDensityMin: min, keywordDensityMax: max } = config;
  const evidence = { keyword, occurrences, proseWordCount: totalWords, densityPercent };

  if (densityPercent >= min && densityPercent <= max) {
    return build(config, {
      id: "keyword-density",
      label: DENSITY_LABEL,
      status: "pass",
      score: 1,
      details: [`Density ${densityPercent}% over ${totalWords} prose words (band ${min}–${max}%).`],
      evidence,
    });
  }

  const tooLow = densityPercent < min;
  const score = tooLow ? densityPercent / min : Math.max(0, 1 - (densityPercent - max) / max);

  return build(config, {
    id: "keyword-density",
    label: DENSITY_LABEL,
    status: "fail",
    score,
    blocking: occurrences === 0 || densityPercent > config.keywordDensityBlockAbove,
    details: [
      tooLow
        ? `Density ${densityPercent}% is below the ${min}% floor — "${keyword}" appears ${occurrences} time(s) in ${totalWords} prose words.`
        : `Density ${densityPercent}% is above the ${max}% ceiling — "${keyword}" appears ${occurrences} times in ${totalWords} prose words, which reads as keyword stuffing.`,
    ],
    evidence,
  });
}
