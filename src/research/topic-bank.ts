/**
 * Builds a customer's topic bank from live search results.
 *
 * The bank used to be written by hand into `src/config/topics.ts`, which made
 * every install a manual authoring job and made the keywords a guess about the
 * customer's market rather than an observation of it.
 *
 * The output is exactly the shape `TOPICS_JSON` expects, so the result of a
 * research run can be pasted straight into a deployment's environment.
 */

import type { Topic } from "../config/topics.js";
import type { SearchClient, SearchResult } from "./brave.js";
import { competitionSignal, extractKeywords, type CompetitionSignal } from "./keywords.js";

export interface ResearchedTopic extends Topic {
  /** What the suggestion is based on, so a human can disagree with it. */
  evidence: {
    query: string;
    competition: CompetitionSignal;
    topHosts: string[];
  };
}

export interface TopicBankOptions {
  seeds: string[];
  /** Keywords to keep per topic. */
  keywordsPerTopic?: number;
  country?: string;
  lang?: string;
  fetchImpl?: typeof fetch;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
}

function titleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function topHostsOf(results: SearchResult[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (!r.host) continue;
    counts.set(r.host, (counts.get(r.host) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([host]) => host);
}

/**
 * A keyword may only belong to one topic.
 *
 * Topics are how the engine tags an article and how it enforces the per-topic
 * daily limit. A phrase claimed by two topics makes both counts wrong and the
 * tag arbitrary, so each keyword is kept by the topic that ranked it highest
 * and dropped from the others. Ties go to the earlier topic, which is the seed
 * order the operator chose.
 */
export function assignKeywordsExclusively(
  ranked: { slug: string; keywords: { phrase: string; score: number }[] }[]
): Map<string, string[]> {
  const owner = new Map<string, { slug: string; score: number; index: number }>();

  ranked.forEach((topic, index) => {
    for (const { phrase, score } of topic.keywords) {
      const held = owner.get(phrase);
      if (!held || score > held.score || (score === held.score && index < held.index)) {
        owner.set(phrase, { slug: topic.slug, score, index });
      }
    }
  });

  const assigned = new Map<string, string[]>();
  for (const topic of ranked) assigned.set(topic.slug, []);
  for (const [phrase, held] of owner) {
    assigned.get(held.slug)?.push(phrase);
  }
  return assigned;
}

export async function buildTopicBank(
  client: SearchClient,
  { seeds, keywordsPerTopic = 12, country, lang, fetchImpl }: TopicBankOptions
): Promise<ResearchedTopic[]> {
  const cleaned = [...new Set(seeds.map((s) => s.trim()).filter(Boolean))];
  if (cleaned.length === 0) return [];

  const searched = await Promise.all(
    cleaned.map(async (seed) => ({
      seed,
      results: await client.search(seed, { country, lang, fetchImpl }),
    }))
  );

  // Rank within each seed first, then resolve overlaps across seeds, so a
  // phrase two markets share lands with the one it fits best.
  const ranked = searched.map(({ seed, results }) => ({
    seed,
    slug: slugify(seed),
    results,
    keywords: extractKeywords(results, {
      limit: keywordsPerTopic * 2,
      exclude: [seed],
    }).map((c) => ({ phrase: c.phrase, score: c.hosts * 10 + c.documents })),
  }));

  const assigned = assignKeywordsExclusively(ranked);

  return ranked
    .map((topic) => {
      const keywords = (assigned.get(topic.slug) ?? []).slice(0, keywordsPerTopic);
      // The seed itself is always a keyword of its own topic: it is the phrase
      // the operator actually asked about.
      const seedPhrase = topic.seed.toLowerCase();
      if (!keywords.includes(seedPhrase)) keywords.unshift(seedPhrase);

      return {
        slug: topic.slug,
        name: titleCase(topic.seed),
        keywords,
        evidence: {
          query: topic.seed,
          competition: competitionSignal(topic.seed, topic.results),
          topHosts: topHostsOf(topic.results),
        },
      };
    })
    .filter((topic) => topic.slug.length > 0);
}

/** The `TOPICS_JSON` value for a researched bank — evidence stripped. */
export function toTopicsJson(topics: ResearchedTopic[]): string {
  return JSON.stringify(
    topics.map(({ slug, name, keywords }) => ({ slug, name, keywords })),
    null,
    2
  );
}
