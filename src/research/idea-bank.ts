/**
 * Plans a year of articles before the first one is written.
 *
 * With only RSS, the engine is reactive: it writes about whatever happened to
 * appear in a feed, which leaves holes in the topic space and no way to tell a
 * customer what they are buying. A bank built at install turns that into a
 * plan — the clusters are covered deliberately, each idea owns exactly one
 * phrase, and the daily job becomes "take the next idea".
 *
 * Everything in this file is deterministic. Which phrases become ideas, what
 * kind of article each one is, which are pillars and what order they are
 * written in are all decided from the evidence, so the plan can be inspected,
 * argued with, and reproduced. Titling is the one part a model does, and it is
 * separate for exactly that reason.
 */

import type { KeywordMetrics } from "./keyword-data.js";
import type { CompetitionSignal } from "./keywords.js";

/** The writer personas an idea can be assigned to; ids from writers.config.ts. */
export type ArticleType =
  | "news-reporter"
  | "analyst"
  | "how-to-writer"
  | "reviewer"
  | "trends-writer"
  | "storyteller"
  | "listicle-writer"
  | "deep-dive-researcher";

export interface ClusterInput {
  /** Topic slug this cluster corresponds to. */
  slug: string;
  name: string;
  /** Candidate phrases for the cluster, best first. */
  keywords: KeywordMetrics[];
  /**
   * The topic seed's SERP competition observations, when the cluster was
   * researched live. Absent for config-only topics — ranking then behaves
   * exactly as it did before competition awareness existed.
   */
  competition?: CompetitionSignal;
}

export interface PlannedIdea {
  title: string;
  targetKeyword: string;
  dedupeKey: string;
  cluster: string;
  articleType: ArticleType;
  isPillar: boolean;
  searchVolume: number | null;
  priority: number;
  evidence: Record<string, unknown>;
}

/**
 * One idea per phrase. Normalising here rather than at the database is what
 * makes a rebuild top the bank up instead of doubling it: the same phrase
 * written with different spacing, case or a plural "s" is the same article.
 */
export function dedupeKeyFor(keyword: string): string {
  return keyword
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
    .sort()
    .join(" ");
}

/**
 * What kind of article a phrase is asking for.
 *
 * Read off the phrase itself, because that is what the searcher actually typed:
 * somebody searching "how to" wants steps, and somebody searching "best" wants
 * a comparison. Guessing this with a model would cost a call per idea and be
 * less predictable than the words already in front of us.
 */
export function articleTypeFor(keyword: string): ArticleType {
  const phrase = ` ${keyword.toLowerCase()} `;
  const has = (...needles: string[]) => needles.some((n) => phrase.includes(n));

  if (has(" how to ", " how do ", " how can ", " guide ", " tutorial ", " steps ")) return "how-to-writer";
  if (has(" best ", " top ", " cheapest ", " alternatives ", " ideas ", " examples ", " types "))
    return "listicle-writer";
  if (has(" vs ", " versus ", " compared ", " comparison ", " review ", " which ")) return "reviewer";
  if (has(" cost ", " price ", " pricing ", " rates ", " roi ", " worth it ", " budget ")) return "analyst";
  if (has(" trends ", " 2025 ", " 2026 ", " 2027 ", " future ", " forecast ", " statistics "))
    return "trends-writer";
  if (has(" what is ", " what are ", " why ", " meaning ", " explained ", " definition "))
    return "deep-dive-researcher";
  if (has(" case study ", " story ", " journey ", " lessons ")) return "storyteller";
  return "news-reporter";
}

/** A readable title when no model is available to write one. */
export function fallbackTitle(keyword: string, type: ArticleType): string {
  const phrase = keyword.trim().replace(/\s+/g, " ");
  const capitalised = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  switch (type) {
    case "how-to-writer":
      return /^how\b/i.test(phrase) ? capitalised : `How to approach ${phrase}`;
    case "listicle-writer":
      return `${capitalised}: what to consider`;
    case "reviewer":
      return `${capitalised}, compared`;
    case "analyst":
      return `${capitalised}: what the numbers say`;
    case "trends-writer":
      return `${capitalised}: where it is heading`;
    case "deep-dive-researcher":
      return `${capitalised}, explained`;
    case "storyteller":
      return capitalised;
    default:
      return capitalised;
  }
}

export interface PlanOptions {
  /** How many ideas the bank should hold in total. */
  target: number;
  /** Pillars per cluster — the anchors everything else links back to. */
  pillarsPerCluster?: number;
  /** Phrases already in the bank; a rebuild must not re-plan them. */
  existingKeys?: Iterable<string>;
}

/** The multipliers a score carried, kept for the idea's evidence. */
interface ScoreBreakdown {
  score: number;
  /** Advertiser-competition demotion factor, only when it was applied. */
  competitionMultiplier?: number;
  /** SERP saturation (exactTitleMatches/sampleSize), only when it demoted. */
  saturation?: number;
  /** The saturation demotion factor, only when it was applied. */
  saturationMultiplier?: number;
}

/**
 * Rank a phrase within its cluster.
 *
 * Volume leads when a provider gave us one, because that is the only real
 * measure of demand. Without volume the order falls back to the order the
 * cluster supplied — which is the search-evidence ranking — rather than to a
 * number invented here.
 *
 * Competition demotes, with a DOCUMENTED formula so the plan can be argued
 * with (never invented difficulty scores — only reported observations):
 *
 *   base       = log10(searchVolume + 1) * 1000     (or the positional fallback)
 *   advertiser = base × (1 − 0.3 × competition)     when per-keyword advertiser
 *                competition (0–1) is non-null — a phrase the whole ad market
 *                bids on is expensive to win organically too.
 *   saturation = × (1 − 0.5 × exactTitleMatches/sampleSize)
 *                only for HEAD TERMS (≤ 2 words) in a cluster whose SERP shows
 *                saturation ≥ 0.5 with distinctHosts ≥ 8 — the head term the
 *                whole SERP already answers verbatim is the hopeless one;
 *                long-tail variants are untouched and rise naturally.
 *
 * With no competition data at all, the result is identical to the historical
 * volume-only score, digit for digit.
 */
function scoreOf(
  metrics: KeywordMetrics,
  positionInCluster: number,
  clusterCompetition?: CompetitionSignal
): ScoreBreakdown {
  // Log-ish scale: the gap between 10 and 100 searches matters more than the
  // gap between 10,000 and 10,090.
  const base =
    metrics.searchVolume !== null
      ? Math.log10(metrics.searchVolume + 1) * 1000
      : Math.max(0, 500 - positionInCluster);

  const breakdown: ScoreBreakdown = { score: 0 };
  let score = base;

  if (metrics.competition !== null) {
    breakdown.competitionMultiplier = 1 - 0.3 * metrics.competition;
    score *= breakdown.competitionMultiplier;
  }

  const words = metrics.keyword.trim().split(/\s+/).filter(Boolean).length;
  if (clusterCompetition && clusterCompetition.sampleSize > 0 && words <= 2) {
    const saturation = clusterCompetition.exactTitleMatches / clusterCompetition.sampleSize;
    if (saturation >= 0.5 && clusterCompetition.distinctHosts >= 8) {
      breakdown.saturation = saturation;
      breakdown.saturationMultiplier = 1 - 0.5 * saturation;
      score *= breakdown.saturationMultiplier;
    }
  }

  breakdown.score = Math.round(score);
  return breakdown;
}

/**
 * Build the plan.
 *
 * Ideas are taken round-robin across clusters rather than cluster by cluster,
 * so a bank cut short at any point is still balanced across the topic space
 * instead of being three clusters deep and nine clusters empty.
 */
export function planIdeas(clusters: ClusterInput[], options: PlanOptions): PlannedIdea[] {
  const { target, pillarsPerCluster = 1, existingKeys = [] } = options;
  if (target <= 0) return [];

  const seen = new Set<string>(existingKeys);
  const queues = clusters
    .map((cluster) => {
      const ranked = cluster.keywords
        .map((metrics, index) => {
          const breakdown = scoreOf(metrics, index, cluster.competition);
          return { metrics, breakdown, score: breakdown.score };
        })
        .sort((a, b) => b.score - a.score || a.metrics.keyword.localeCompare(b.metrics.keyword));
      return { cluster, ranked, taken: 0 };
    })
    .filter((queue) => queue.ranked.length > 0);

  const planned: PlannedIdea[] = [];
  let exhausted = false;

  while (planned.length < target && !exhausted) {
    exhausted = true;
    for (const queue of queues) {
      if (planned.length >= target) break;

      // Skip past anything already planned or already in the bank.
      let next = queue.ranked.shift();
      while (next && seen.has(dedupeKeyFor(next.metrics.keyword))) {
        next = queue.ranked.shift();
      }
      if (!next) continue;

      exhausted = false;
      const keyword = next.metrics.keyword.trim();
      const key = dedupeKeyFor(keyword);
      seen.add(key);

      const isPillar = queue.taken < pillarsPerCluster;
      const articleType = isPillar ? "deep-dive-researcher" : articleTypeFor(keyword);
      queue.taken += 1;

      planned.push({
        title: fallbackTitle(keyword, articleType),
        targetKeyword: keyword,
        dedupeKey: key,
        cluster: queue.cluster.slug,
        articleType,
        isPillar,
        searchVolume: next.metrics.searchVolume,
        // Pillars are written first: everything in the cluster links back to
        // them, and a link to an article that does not exist yet is a dead one.
        priority: next.score + (isPillar ? 100_000 : 0),
        evidence: {
          clusterName: queue.cluster.name,
          score: next.score,
          competition: next.metrics.competition,
          cpc: next.metrics.cpc,
          // The applied demotions, spread in only when they actually fired,
          // so an uncontested plan's evidence keeps its historical shape.
          ...(next.breakdown.competitionMultiplier !== undefined
            ? { competitionMultiplier: next.breakdown.competitionMultiplier }
            : {}),
          ...(next.breakdown.saturation !== undefined
            ? {
                saturation: next.breakdown.saturation,
                saturationMultiplier: next.breakdown.saturationMultiplier,
              }
            : {}),
        },
      });
    }
  }

  return planned.sort((a, b) => b.priority - a.priority);
}

/** How far a bank goes at a given publishing pace. */
export function coverageMonths(ideaCount: number, articlesPerMonth: number): number {
  if (articlesPerMonth <= 0) return 0;
  return Number((ideaCount / articlesPerMonth).toFixed(1));
}
