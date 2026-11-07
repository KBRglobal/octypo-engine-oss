/**
 * Decides whether a candidate stock photo is actually about the article.
 *
 * This exists because a live search for one topic, "led truck advertising",
 * returned a truck in snow, a Christmas ornament and a hookah.
 * Every one was correctly licensed and completely wrong. An irrelevant header
 * image on a client's site reads as carelessness just as loudly as a generated
 * hand with six fingers, and nobody reviews these before they publish.
 *
 * Scoring is deliberately conservative: when nothing clears the bar the caller
 * is expected to fall back (other provider, then generation, then no image).
 * Publishing without a header is recoverable; publishing a nonsense one is the
 * thing the customer notices.
 */

/** Words that carry no topical signal and would otherwise create false matches. */
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "best", "but", "by", "can", "do",
  "does", "for", "from", "guide", "how", "in", "is", "it", "its", "of", "on",
  "or", "the", "their", "there", "this", "to", "top", "using", "what", "when",
  "where", "which", "who", "why", "will", "with", "you", "your",
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Cheap singular/plural folding so "trucks" matches "truck". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

export interface RelevanceResult {
  score: number;
  matched: string[];
  /** True when the candidate is good enough to publish unattended. */
  relevant: boolean;
}

/**
 * Raised from 0.34 after measuring against real searches: at the lower bar a
 * photo of a classic car scored 0.60 for an article about billboards, and
 * "right or wrong" clipart passed for an article about choosing a supplier. A
 * single shared word is not a subject match.
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.5;

/**
 * @param topic  what the article is about — title and/or primary keyword
 * @param description  the candidate's own words: Pexels `alt`, Pixabay `tags`
 */
export function scoreRelevance(
  topic: string,
  description: string,
  threshold = DEFAULT_RELEVANCE_THRESHOLD
): RelevanceResult {
  const topicTerms = [...new Set(tokenise(topic).map(stem))];
  const candidateTerms = new Set(tokenise(description).map(stem));

  if (topicTerms.length === 0 || candidateTerms.size === 0) {
    // No signal either way. Refuse rather than guess — an unscoreable candidate
    // is exactly the case where a wrong image slips through.
    return { score: 0, matched: [], relevant: false };
  }

  const matched = topicTerms.filter((t) => candidateTerms.has(t));
  const score = matched.length / topicTerms.length;
  return { score, matched, relevant: score >= threshold };
}

export interface Candidate {
  id: string;
  url: string;
  width: number;
  height: number;
  description: string;
  provider: string;
  photographer?: string | null;
  sourcePage?: string | null;
}

export interface RankedCandidate extends Candidate {
  relevance: RelevanceResult;
}

/** A header image that is too small or portrait-shaped is unusable regardless of subject. */
export const MIN_WIDTH = 1200;
export const MIN_ASPECT = 1.2;

export function rankCandidates(
  topic: string,
  candidates: readonly Candidate[],
  threshold = DEFAULT_RELEVANCE_THRESHOLD
): RankedCandidate[] {
  return candidates
    .filter((c) => c.width >= MIN_WIDTH && c.width / Math.max(c.height, 1) >= MIN_ASPECT)
    .map((c) => ({ ...c, relevance: scoreRelevance(topic, c.description, threshold) }))
    .filter((c) => c.relevance.relevant)
    // Prefer the strongest topical match; break ties by resolution so the same
    // article always picks the same image on a re-run.
    .sort((a, b) => b.relevance.score - a.relevance.score || b.width - a.width);
}
