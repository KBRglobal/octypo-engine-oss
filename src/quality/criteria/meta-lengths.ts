/**
 * Criterion 3: the two strings a searcher actually reads before clicking.
 *
 * Measured in characters, not words: truncation in the SERP is a pixel budget
 * approximated by a character count, and a title cut mid-word is the cheapest
 * quality defect there is to prevent.
 */

import { endsLikeSentence } from "../../lib/sentence-cut.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Meta title and description length";

export function scoreMetaLengths(
  input: ArticleQualityInput,
  config: QualityGateConfig
): CriterionResult {
  const metaTitle = (input.metaTitle ?? "").trim();
  const metaDescription = (input.metaDescription ?? "").trim();
  const details: string[] = [];

  let titleOk = true;
  if (!metaTitle) {
    titleOk = false;
    details.push("Meta title is missing.");
  } else if (metaTitle.length > config.metaTitleMax) {
    titleOk = false;
    details.push(
      `Meta title is ${metaTitle.length} characters — the limit is ${config.metaTitleMax}.`
    );
  }

  let descriptionOk = true;
  // A description cut mid-sentence went live on a customer page. Length is
  // advisory (Google publishes no limit); a fragment is not.
  let truncated = false;
  if (metaDescription && !endsLikeSentence(metaDescription)) {
    descriptionOk = false;
    truncated = true;
    details.push(
      `Meta description does not end with a full sentence ("…${metaDescription.slice(-40)}"). Never cut it by character count; use whole sentences.`
    );
  }
  if (!metaDescription) {
    descriptionOk = false;
    details.push("Meta description is missing.");
  } else if (metaDescription.length < config.metaDescriptionMin) {
    descriptionOk = false;
    details.push(
      `Meta description is ${metaDescription.length} characters — the minimum is ${config.metaDescriptionMin}.`
    );
  } else if (metaDescription.length > config.metaDescriptionMax) {
    descriptionOk = false;
    details.push(
      `Meta description is ${metaDescription.length} characters — the maximum is ${config.metaDescriptionMax}.`
    );
  }

  const passedCount = Number(titleOk) + Number(descriptionOk);
  if (passedCount === 2) {
    details.push(
      `Meta title ${metaTitle.length} chars, meta description ${metaDescription.length} chars.`
    );
  }

  return build(config, {
    id: "meta-lengths",
    label: LABEL,
    status: passedCount === 2 ? "pass" : "fail",
    score: passedCount / 2,
    blocking: truncated,
    details,
    evidence: {
      metaTitleLength: metaTitle.length,
      metaDescriptionLength: metaDescription.length,
      metaTitleOk: titleOk,
      metaDescriptionOk: descriptionOk,
    },
  });
}
