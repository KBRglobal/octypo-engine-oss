/**
 * The scorer: one pure function, nine criteria, one verdict.
 *
 * Pure on purpose. It reads no database, no clock and no network, so an editor
 * looking at a held article can re-run it, get the identical breakdown, fix the
 * named defect and watch the same function pass — which is the only way a
 * quality gate ever earns the right to stop a publish.
 */

import { loadQualityGateConfig } from "./config.js";
import { scoreAnswerCapsule } from "./criteria/answer-capsule.js";
import { scoreFabricatedStats } from "./criteria/fabricated-stats.js";
import { scoreHeroImage } from "./criteria/hero-image.js";
import { scoreInternalLinks } from "./criteria/internal-links.js";
import { scoreKeywordDensity, scoreKeywordPlacement } from "./criteria/keyword.js";
import { scoreMetaLengths } from "./criteria/meta-lengths.js";
import { scoreSerpAlignment } from "./criteria/serp-alignment.js";
import { scoreSlugReadable } from "./criteria/slug-readable.js";
import { scoreSourcePrimary } from "./criteria/source-primary.js";
import { scoreStructuredData } from "./criteria/structured-data.js";
import { scoreTitleFreshness } from "./criteria/title-freshness.js";
import { scoreWordCount } from "./criteria/word-count.js";
import { extractStructure } from "./extract.js";
import type {
  ArticleQualityInput,
  ArticleQualityReport,
  CriterionId,
  QualityGateConfig,
} from "./types.js";

export function scoreArticle(
  input: ArticleQualityInput,
  overrides: Partial<QualityGateConfig> = {}
): ArticleQualityReport {
  const config = loadQualityGateConfig(overrides);
  const structure = extractStructure(input);

  const criteria = [
    scoreKeywordPlacement(input, structure, config),
    scoreKeywordDensity(input, structure, config),
    scoreMetaLengths(input, config),
    scoreStructuredData(input, structure, config),
    scoreHeroImage(input, config),
    scoreInternalLinks(input, structure, config),
    scoreWordCount(input, structure, config),
    scoreFabricatedStats(input, structure, config),
    scoreSerpAlignment(input, structure, config),
    scoreAnswerCapsule(input, config),
    scoreTitleFreshness(input, config),
    scoreSourcePrimary(input, structure, config),
    scoreSlugReadable(input, config),
  ];

  // Skipped criteria drop out of both sides of the fraction. Scoring an
  // unchecked criterion as zero would punish an article for its caller's
  // missing context; scoring it as full marks would hide the gap.
  const scored = criteria.filter(c => c.status !== "skipped");
  const totalWeight = scored.reduce((sum, c) => sum + c.weight, 0);
  const earned = scored.reduce((sum, c) => sum + c.weight * c.score, 0);
  const score = totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100);

  const blockingFailures = criteria.filter(c => c.blocking).map(c => c.id as CriterionId);
  const passed = blockingFailures.length === 0 && score >= config.threshold;

  return {
    score,
    threshold: config.threshold,
    passed,
    blockingFailures,
    criteria,
    summary: summarise(score, config.threshold, passed, criteria),
  };
}

function summarise(
  score: number,
  threshold: number,
  passed: boolean,
  criteria: ArticleQualityReport["criteria"]
): string {
  if (passed) return `Quality ${score}/100 — passes the ${threshold} threshold.`;
  const blocking = criteria.filter(c => c.blocking).map(c => c.label);
  if (blocking.length > 0) {
    return `Quality ${score}/100 — held on blocking failure: ${blocking.join(", ")}.`;
  }
  const failed = criteria.filter(c => c.status === "fail").map(c => c.label);
  return `Quality ${score}/100 — below the ${threshold} threshold. Failing: ${failed.join(", ") || "none"}.`;
}

/** A flat, human-readable rendering of the breakdown, for logs and editor UI. */
export function formatQualityReport(report: ArticleQualityReport): string {
  const lines = [report.summary];
  for (const criterion of report.criteria) {
    const mark = criterion.status === "pass" ? "PASS" : criterion.status === "fail" ? "FAIL" : "SKIP";
    lines.push(`[${mark}] ${criterion.label}${criterion.blocking ? " (blocking)" : ""}`);
    for (const detail of criterion.details) lines.push(`       ${detail}`);
  }
  return lines.join("\n");
}
