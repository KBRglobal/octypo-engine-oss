/**
 * Criterion 12: the source is a real page, and an "official" claim was checked.
 *
 * Two blocking rules:
 *
 * 1. No source may be an aggregator or a redirector (news.google.com and
 *    friends). Such a link names no publisher and a reader cannot verify it.
 *
 * 2. An article that says something has NOT been announced / published /
 *    confirmed officially is making a claim about the world today. That claim
 *    is honest only when the official page was actually opened today — so it
 *    requires a primary (non-news, non-social) source with a `checkedAt` on
 *    the same UTC day as `input.now`. Without that evidence the article is
 *    held, and the reviewer sees exactly why.
 *
 * `sourceUrls` undefined = not supplied (skipped). An empty array = supplied
 * and missing, which fails: a news article without a source is not publishable.
 */

import { CONTENT_LANGUAGE } from "../../config/domain.js";
import { isAggregatorUrl, looksLikeNewsOrSocialHost } from "../../lib/source-url.js";
import type { ArticleStructure } from "../extract.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build, skipped } from "./result.js";

const LABEL = "Primary source";

/**
 * Phrases that assert an absence of an official fact. Kept deliberately
 * literal: a false positive costs one human look, a false negative costs a
 * customer's credibility. The vocabulary is English; no list exists for other
 * languages, so on such a site this one rule is skipped (never a false hold)
 * and the evidence says so. The aggregator and missing-source rules above are
 * language-neutral and always run.
 */
export const ABSENCE_CLAIM_PATTERNS: RegExp[] = [
  /\b(?:not|hasn't|has not|haven't|have not|yet to be)\s+(?:been\s+)?(?:officially\s+)?(?:announced|confirmed|published|released|set)\b/i,
  /\bno\s+official\s+(?:date|dates|announcement|confirmation|word)\b/i,
];

export function findAbsenceClaims(prose: string): string[] {
  const hits: string[] = [];
  for (const re of ABSENCE_CLAIM_PATTERNS) {
    const m = re.exec(prose);
    if (m) hits.push(m[0]);
  }
  return hits;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export function scoreSourcePrimary(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  if (input.sourceUrls === undefined) {
    return skipped(config, "source-primary", LABEL, "No sources were supplied to the scorer.");
  }
  const sources = (input.sourceUrls ?? []).map(s => s.trim()).filter(Boolean);
  const now = input.now ?? new Date();
  const details: string[] = [];
  let ok = true;

  if (sources.length === 0) {
    ok = false;
    details.push("The article has no source URL. A reader must be able to open where the story came from.");
  }

  const aggregators = sources.filter(isAggregatorUrl);
  if (aggregators.length > 0) {
    ok = false;
    details.push(
      `Source is an aggregator link, not the publisher: ${aggregators.join(", ")}. Resolve it to the page that reported the story.`
    );
  }

  const claims = findAbsenceClaims(`${input.title ?? ""} ${input.answerCapsule ?? ""} ${structure.prose}`);
  const checks = input.primarySources ?? [];
  const freshPrimary = checks.filter(c => {
    if (!c.url || !c.checkedAt) return false;
    const at = new Date(c.checkedAt);
    return !Number.isNaN(at.getTime()) && sameUtcDay(at, now) && !isAggregatorUrl(c.url) && !looksLikeNewsOrSocialHost(c.url);
  });
  if (claims.length > 0 && freshPrimary.length === 0) {
    ok = false;
    details.push(
      `The article claims something is not yet official ("${claims[0]}") but no official page was checked today. ` +
        `Open the primary source (the organiser's or authority's own site) on the day of writing and record it, or drop the claim.`
    );
  } else if (claims.length > 0) {
    details.push(`Absence claim backed by a primary source checked today: ${freshPrimary[0].url}.`);
  }

  if (ok && details.length === 0) details.push(`${sources.length} source(s), all publisher pages.`);

  return build(config, {
    id: "source-primary",
    label: LABEL,
    status: ok ? "pass" : "fail",
    score: ok ? 1 : 0,
    blocking: true,
    details,
    evidence: {
      sources,
      aggregators,
      absenceClaims: claims,
      absenceClaimCheck: /^english$/i.test(CONTENT_LANGUAGE.trim()) ? "ran" : "skipped: no vocabulary for this language",
      primaryChecked: freshPrimary.map(c => c.url),
    },
  });
}
