import type { QualityGateConfig } from "./types.js";

/**
 * The scorer normalises over the criteria actually checked, so the weights are
 * relative shares rather than a fixed percentage sum ("serp-alignment" joined
 * after the original 100-point layout — re-slicing the older weights to keep a
 * round total would silently change every historical score for no gain).
 * Fabricated statistics carry the most weight because an
 * invented figure is the one defect that damages the customer rather than just
 * their ranking — everything else is recoverable by editing.
 *
 * Thresholds below were re-derived on 2026-08-21 from Google Search Central
 * directly, because most of the industry numbers turn out to be folklore:
 *
 * - Title length: Google states "there's no limit on how long a <title>
 *   element can be" and truncates to device width. The familiar 50-60 figure
 *   is third-party SERP measurement, not a Google rule. Advisory only.
 * - Meta description length: "There's no limit on how long a meta description
 *   can be." The 155/160 figures are likewise folklore. Advisory only.
 * - Keyword density: Google has NEVER published a density figure. The spam
 *   policy names unnatural repetition, with no percentage attached. We keep a
 *   high stuffing guard because "repeating so often that it sounds unnatural"
 *   is real, but the lower bound is gone — an article can be about its topic
 *   without hitting a quota, and Google's systems match synonyms.
 * - Word count: Google explicitly denies having a preferred length — "Are you
 *   writing to a particular word count because you've heard or read that
 *   Google has a preferred word count? (No, we don't.)" Advisory only.
 *
 * Blocking is therefore reserved for defects Google actually states: invented
 * facts, structured data that misrepresents the page, missing/duplicate
 * metadata, and keyword stuffing.
 */
export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  threshold: 70,
  enabled: true,
  // Advisory truncation hints, not rules. Google publishes no limit.
  metaTitleMax: 60,
  metaDescriptionMin: 70,
  metaDescriptionMax: 160,
  // No lower bound: requiring a keyword quota is folklore and pushes the writer
  // toward unnatural repetition — the actual spam signal.
  keywordDensityMin: 0,
  keywordDensityMax: 3.0,
  keywordDensityBlockAbove: 4.0,
  minInternalLinks: 3,
  // The editorial standard for the opening answer: long enough to actually
  // answer, short enough to be quoted whole by an answer engine.
  capsuleWordsMin: 40,
  capsuleWordsMax: 60,
  defaultWordCount: { min: 800, max: 2500 },
  weights: {
    "fabricated-stats": 20,
    "keyword-placement": 15,
    "structured-data": 15,
    "keyword-density": 10,
    "meta-lengths": 10,
    "hero-image": 10,
    "internal-links": 10,
    "word-count": 10,
    // A grade, never a gate — weighted with the lighter criteria.
    "serp-alignment": 8,
    "answer-capsule": 10,
    // Gates first, grades second: each of these is pass/fail and blocking,
    // so the weight only matters for the score of an article that passed.
    "title-freshness": 5,
    "source-primary": 10,
    "slug-readable": 5,
  },
};

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read once per call rather than at module load: the engine is long-lived and
 * an operator raising the bar should not have to restart every replica.
 */
export function loadQualityGateConfig(
  overrides: Partial<QualityGateConfig> = {}
): QualityGateConfig {
  return {
    ...DEFAULT_QUALITY_GATE_CONFIG,
    threshold: numberFromEnv("QUALITY_GATE_THRESHOLD", DEFAULT_QUALITY_GATE_CONFIG.threshold),
    enabled: process.env.QUALITY_GATE_ENABLED !== "false",
    capsuleWordsMin: numberFromEnv("QUALITY_CAPSULE_WORDS_MIN", DEFAULT_QUALITY_GATE_CONFIG.capsuleWordsMin),
    capsuleWordsMax: numberFromEnv("QUALITY_CAPSULE_WORDS_MAX", DEFAULT_QUALITY_GATE_CONFIG.capsuleWordsMax),
    ...overrides,
    weights: { ...DEFAULT_QUALITY_GATE_CONFIG.weights, ...(overrides.weights ?? {}) },
  };
}
