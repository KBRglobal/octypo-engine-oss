/**
 * The install-time command: seeds in, a year of planned articles out.
 *
 * Two evidence sources, used for what each is actually good for. Live search
 * results say which phrases the market uses and who owns them; a keyword-data
 * provider, when the customer has one, says how many people search each phrase.
 * Neither is required — with only search results the bank is ranked on shared
 * vocabulary; with a provider it is ranked on demand. Nothing is invented when
 * both are missing, the bank is simply smaller.
 */

import { logger } from "../lib/logger.js";
import type { SearchClient } from "./brave.js";
import { searchClientFromEnv } from "./brave.js";
import { buildTopicBank, type ResearchedTopic } from "./topic-bank.js";
import {
  keywordDataProviderFromEnv,
  type KeywordDataProvider,
  type KeywordMetrics,
} from "./keyword-data.js";
import { planIdeas, coverageMonths, type ClusterInput, type PlannedIdea } from "./idea-bank.js";
import { existingDedupeKeys, storeIdeas } from "./bank-store.js";
import { titleIdeas } from "./idea-titles.js";
import { onlyBuyers } from "./bank-buyers.js";
import { keepRelevant, type RelevanceJudge } from "./keyword-relevance.js";

export interface BuildBankOptions {
  seeds: string[];
  /** How many ideas the bank should end up holding. */
  target: number;
  /** Articles per month the customer bought — used to report coverage. */
  articlesPerMonth?: number;
  keywordsPerCluster?: number;
  pillarsPerCluster?: number;
  country?: string;
  lang?: string;
  /** Store the plan. False returns the plan for review without writing it. */
  persist?: boolean;
}

export interface BuildBankResult {
  topics: ResearchedTopic[];
  ideas: PlannedIdea[];
  /** Ideas asked for versus ideas the evidence actually supported. */
  requested: number;
  produced: number;
  coverageMonths: number;
  usedKeywordProvider: boolean;
  /** Ideas whose headline the model wrote; the rest kept the fallback line. */
  titled: number;
  inserted?: number;
  skipped?: number;
}

/**
 * Merge the phrases a cluster knows about.
 *
 * The provider's ideas come first when there is one — they are drawn from real
 * query logs rather than from the wording of ten result snippets — with the
 * search-derived phrases appended for anything it missed.
 */
export async function clusterKeywords(
  topic: ResearchedTopic,
  provider: KeywordDataProvider | null,
  perCluster: number
): Promise<KeywordMetrics[]> {
  const fromSearch: KeywordMetrics[] = topic.keywords.map((keyword) => ({
    keyword,
    searchVolume: null,
    competition: null,
    cpc: null,
  }));

  if (!provider) return fromSearch.slice(0, perCluster);

  const fromProvider = await provider.ideasFor(topic.evidence.query, perCluster);
  const seen = new Set(fromProvider.map((m) => m.keyword));

  // Search-derived phrases have no volume yet; ask for it in one batch rather
  // than one request per phrase.
  const missing = fromSearch.filter((m) => !seen.has(m.keyword));
  const measured = missing.length > 0 ? await provider.metricsFor(missing.map((m) => m.keyword)) : [];
  const byKeyword = new Map(measured.map((m) => [m.keyword, m]));

  return onlyBuyers(
    [...fromProvider, ...missing.map((m) => byKeyword.get(m.keyword) ?? m)],
    topic.slug
  ).slice(0, perCluster);
}


export async function buildIdeaBank(
  options: BuildBankOptions,
  deps: { search?: SearchClient | null; provider?: KeywordDataProvider | null; relevance?: RelevanceJudge } = {}
): Promise<BuildBankResult> {
  const {
    seeds,
    target,
    articlesPerMonth = 100,
    keywordsPerCluster = 200,
    pillarsPerCluster = 1,
    country,
    lang,
    persist = true,
  } = options;

  const search = deps.search ?? searchClientFromEnv();
  if (!search) {
    throw new Error("No search client configured — set BRAVE_API_KEY");
  }
  const provider = deps.provider ?? keywordDataProviderFromEnv();

  const topics = await buildTopicBank(search, {
    seeds,
    keywordsPerTopic: 40,
    country,
    lang,
  });

  const clusters: ClusterInput[] = [];
  for (const topic of topics) {
    clusters.push({
      slug: topic.slug,
      name: topic.name,
      // Co-occurrence expansion drifts off-topic; judged against the domain first.
      keywords: await keepRelevant(await clusterKeywords(topic, provider, keywordsPerCluster), deps.relevance),
      // The topic's live SERP observations, so ranking can demote a head term
      // the whole results page already answers verbatim. Config-only topic
      // paths have no evidence and pass nothing — ranking is then unchanged.
      competition: topic.evidence.competition,
    });
  }

  const ideas = planIdeas(clusters, {
    target,
    pillarsPerCluster,
    existingKeys: persist ? await existingDedupeKeys() : [],
  });

  if (ideas.length < target) {
    // Said out loud rather than padded. A narrow niche genuinely runs out, and
    // a bank quietly filled with near-duplicates is worse than a short one.
    logger.warn(
      { requested: target, produced: ideas.length, clusters: clusters.length },
      "[IdeaBank] The evidence supported fewer ideas than requested — add seeds to go deeper"
    );
  }

  // Titles last, so a model outage costs headlines rather than the whole plan.
  const titled = await titleIdeas(ideas);

  const result: BuildBankResult = {
    topics,
    ideas,
    titled,
    requested: target,
    produced: ideas.length,
    coverageMonths: coverageMonths(ideas.length, articlesPerMonth),
    usedKeywordProvider: provider !== null,
  };

  if (persist) {
    const stored = await storeIdeas(ideas);
    result.inserted = stored.inserted;
    result.skipped = stored.skipped;
  }

  return result;
}
