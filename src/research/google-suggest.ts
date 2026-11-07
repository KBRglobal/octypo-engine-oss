/**
 * Keyword discovery with no account and no subscription.
 *
 * Google's own autocomplete endpoint answers unauthenticated, for whichever
 * language and country the caller names, and every phrase it returns is one
 * real people actually type — it is the completion list shown in the search box. That makes it a better
 * starting point than any model's guess at what a query looks like, and it
 * costs nothing.
 *
 * What it does NOT give is volume. Suggestions come back ranked but
 * unnumbered, so a phrase's position is a hint about popularity and nothing
 * more. Where DataForSEO is configured the desk attaches real monthly
 * figures on top; where it is not, the list is still real queries in a
 * sensible order, and it says so rather than inventing numbers.
 *
 * Expansion works the way a person would: ask for the seed, then the seed
 * after each question word and before each letter, which is how the long tail
 * surfaces. Question words exist for English and the alphabet for Latin script;
 * a caller working in anything else passes its own `prefixes` and `letters`,
 * and without them only the bare seed is asked.
 */
import { logger } from "../lib/logger.js";

const ENDPOINT = "https://suggestqueries.google.com/complete/search";

const ENGLISH_PREFIXES = ["how", "how much", "what", "why", "when", "where", "best", "price", "reviews"];
const LATIN_LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

export interface SuggestOptions {
  /** ISO 639-1 language code, sent as `hl`. */
  language: string;
  /** ISO 3166-1 alpha-2 country code, sent as `gl`. */
  country: string;
  /** Expand with question words and letters, not just the bare seed. */
  deep?: boolean;
  /** Words to put before the seed when `deep`. */
  prefixes?: string[];
  /** Letters to put after the seed when `deep`. */
  letters?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One call. Returns [] on any failure — discovery must never break a flow. */
async function suggestOnce(query: string, options: SuggestOptions): Promise<string[]> {
  const params = new URLSearchParams({
    client: "firefox",
    hl: options.language.toLowerCase(),
    gl: options.country.toLowerCase(),
    q: query,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const res = await doFetch(`${ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OctypoLinkDesk/1.0)" },
    });
    if (!res.ok) return [];
    // Some languages come back in a legacy charset, not UTF-8, and res.json()
    // would turn every suggestion into replacement characters. Honour the header.
    const charset =
      /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.toLowerCase() ??
      "utf-8";
    const buffer = await res.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder(charset).decode(buffer);
    } catch {
      text = new TextDecoder("utf-8").decode(buffer);
    }
    // The firefox client returns [query, [suggestions], ...].
    const body = JSON.parse(text) as unknown;
    if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
    return (body[1] as unknown[]).map((s) => String(s).trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expand seeds into the phrases Google itself completes them to.
 *
 * Returned in discovery order with duplicates removed, so a phrase both
 * Google and the seed list agree on comes out near the top.
 */
export async function expandSeeds(
  seeds: string[],
  options: SuggestOptions
): Promise<string[]> {
  const clean = [...new Set(seeds.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) return [];

  const queries: string[] = [];
  for (const seed of clean) {
    queries.push(seed);
    if (!options.deep) continue;
    const prefixes = options.prefixes ?? (options.language.toLowerCase() === "en" ? ENGLISH_PREFIXES : []);
    const letters = options.letters ?? (/\p{Script=Latin}/u.test(seed) ? LATIN_LETTERS : []);
    for (const prefix of prefixes) queries.push(`${prefix} ${seed}`);
    for (const letter of letters) queries.push(`${seed} ${letter}`);
  }

  // Google is being asked politely, in small waves, not hammered.
  const found: string[] = [];
  const seen = new Set<string>();
  const WAVE = 6;
  for (let i = 0; i < queries.length; i += WAVE) {
    const wave = queries.slice(i, i + WAVE);
    const results = await Promise.all(wave.map((q) => suggestOnce(q, options)));
    for (const list of results) {
      for (const phrase of list) {
        const key = phrase.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(phrase);
      }
    }
    if (found.length > 400) break;
  }

  logger.info(
    { seeds: clean.length, queries: queries.length, found: found.length },
    "[Suggest] Expanded seeds via Google autocomplete"
  );
  return found;
}
