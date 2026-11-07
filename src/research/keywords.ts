/**
 * Candidate key phrases, derived from what actually ranks.
 *
 * The scoring signal is *document frequency* — how many distinct results
 * contain a phrase — not raw occurrence count. A single page repeating its own
 * brand nine times says nothing about the market; nine different pages using
 * the same phrase says the market has settled on that wording, which is
 * precisely what a writer needs to match.
 *
 * Everything here is deterministic and offline: it takes results in and gives
 * phrases out, so it can be tested without a network and without a model.
 */

import type { SearchResult } from "./brave.js";

/**
 * Words that carry no topical meaning on their own. A phrase may contain one in
 * the middle ("advertising on a budget"), but never start or end with one — a
 * phrase ending in "for" is a fragment, not a keyword.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "done",
  "have", "has", "had", "having",
  "of", "in", "on", "at", "to", "for", "with", "by", "from", "as", "into", "about", "over",
  "under", "between", "through", "during", "before", "after", "above", "below",
  "you", "your", "yours", "we", "our", "ours", "they", "their", "theirs", "it", "its",
  "i", "me", "my", "he", "she", "his", "her", "them", "us",
  "can", "could", "will", "would", "should", "may", "might", "must", "shall",
  "not", "no", "yes", "all", "any", "each", "more", "most", "other", "some", "such",
  "how", "what", "when", "where", "why", "who", "which",
  "best", "top", "new", "free", "vs", "get", "here", "there", "up", "out", "off", "now",
]);

export interface KeywordCandidate {
  phrase: string;
  /** Distinct results that used this phrase. */
  documents: number;
  /** Distinct hosts that used it — a phrase used by one site is that site's, not the market's. */
  hosts: number;
  words: number;
}

export interface CompetitionSignal {
  /** Distinct hosts in the results. Few hosts means a phrase a handful of sites own. */
  distinctHosts: number;
  /** Share of results held by the single most common host, 0–1. */
  topHostShare: number;
  /** Results whose title states the query more or less verbatim. */
  exactTitleMatches: number;
  sampleSize: number;
}

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isUsablePhrase(words: string[]): boolean {
  if (words.length < 2) return false;
  if (STOPWORDS.has(words[0])) return false;
  if (STOPWORDS.has(words[words.length - 1])) return false;
  // A phrase that is only numbers or single letters is noise from a title.
  return words.some((w) => w.length > 2 && !/^\d+$/.test(w));
}

function phrasesIn(text: string, minWords: number, maxWords: number): Set<string> {
  const words = tokenise(text);
  const found = new Set<string>();
  for (let size = minWords; size <= maxWords; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const gram = words.slice(i, i + size);
      if (isUsablePhrase(gram)) found.add(gram.join(" "));
    }
  }
  return found;
}

export interface ExtractOptions {
  minWords?: number;
  maxWords?: number;
  limit?: number;
  /** Phrases to leave out — normally the seed the search was run on. */
  exclude?: string[];
}

/**
 * Rank candidate phrases across a result set.
 *
 * A phrase must appear on at least two distinct hosts to be reported. One host
 * using a phrase is that host's own vocabulary; the goal is the wording the
 * market shares.
 */
export function extractKeywords(
  results: SearchResult[],
  { minWords = 2, maxWords = 4, limit = 25, exclude = [] }: ExtractOptions = {}
): KeywordCandidate[] {
  const excluded = new Set(exclude.map((e) => e.trim().toLowerCase()).filter(Boolean));

  const documents = new Map<string, number>();
  const hosts = new Map<string, Set<string>>();

  for (const result of results) {
    const text = `${result.title}. ${result.description}`;
    for (const phrase of phrasesIn(text, minWords, maxWords)) {
      if (excluded.has(phrase)) continue;
      documents.set(phrase, (documents.get(phrase) ?? 0) + 1);
      const seen = hosts.get(phrase) ?? new Set<string>();
      if (result.host) seen.add(result.host);
      hosts.set(phrase, seen);
    }
  }

  const candidates: KeywordCandidate[] = [];
  for (const [phrase, count] of documents) {
    const hostCount = hosts.get(phrase)?.size ?? 0;
    if (hostCount < 2) continue;
    candidates.push({
      phrase,
      documents: count,
      hosts: hostCount,
      words: phrase.split(" ").length,
    });
  }

  return candidates
    .sort(
      (a, b) =>
        b.hosts - a.hosts ||
        b.documents - a.documents ||
        b.words - a.words ||
        a.phrase.localeCompare(b.phrase)
    )
    .slice(0, limit);
}

/**
 * How contested a query looks. Not a difficulty score — nobody can compute one
 * from results alone, and pretending otherwise is how a made-up number ends up
 * driving a publishing decision. These are three observations, reported as
 * observations.
 */
export function competitionSignal(query: string, results: SearchResult[]): CompetitionSignal {
  const sampleSize = results.length;
  if (sampleSize === 0) {
    return { distinctHosts: 0, topHostShare: 0, exactTitleMatches: 0, sampleSize: 0 };
  }

  const counts = new Map<string, number>();
  for (const r of results) {
    if (!r.host) continue;
    counts.set(r.host, (counts.get(r.host) ?? 0) + 1);
  }
  const top = Math.max(0, ...counts.values());

  const needle = tokenise(query).join(" ");
  const exactTitleMatches = results.filter((r) => tokenise(r.title).join(" ").includes(needle)).length;

  return {
    distinctHosts: counts.size,
    topHostShare: Number((top / sampleSize).toFixed(2)),
    exactTitleMatches,
    sampleSize,
  };
}
