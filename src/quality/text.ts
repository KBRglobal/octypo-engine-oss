/**
 * Text primitives shared by every criterion.
 *
 * All of it is pure and locale-independent. Nothing here may consult the clock,
 * the network or the environment — the whole point of the scorer is that the
 * same article always produces the same verdict.
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&pound;": "£",
  "&euro;": "€",
};

/**
 * Reduce stored HTML to what a reader actually sees. Attribute values — hrefs,
 * image URLs, alt text — are dropped on purpose: keyword density counted over
 * markup is how "SEO scores" end up measuring the wrong thing entirely.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&[a-z]+;/gi, entity => ENTITIES[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words as a reader would count them: letters and digits, apostrophes kept. */
export function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’]*(?:-[\p{L}\p{N}'’]+)*/gu) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

/**
 * Lowercase, strip accents, and reduce every separator to a single space, so
 * "Deposit-Deduction," and "deposit deduction" compare equal.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizedTokens(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(" ") : [];
}

/**
 * Singular/plural tolerance only. Real stemming would make the scorer's
 * decisions hard for a human to predict, and a gate nobody can predict is a
 * gate nobody trusts.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === `${b}s` || b === `${a}s`) return true;
  if (a === `${b}es` || b === `${a}es`) return true;
  return false;
}

/** How many times the keyword phrase occurs, counted on whole-word boundaries. */
export function countPhrase(haystack: string, phrase: string): number {
  const needle = normalizedTokens(phrase);
  if (needle.length === 0) return 0;
  const hay = normalizedTokens(haystack);
  let count = 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (!tokensMatch(hay[i + j], needle[j])) {
        hit = false;
        break;
      }
    }
    if (hit) {
      count++;
      i += needle.length - 1;
    }
  }
  return count;
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  return countPhrase(haystack, phrase) > 0;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "how", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who", "why",
  "with", "you", "your",
]);

/** Tokens worth matching on — stopwords and one-letter noise removed. */
export function significantTokens(text: string): string[] {
  return normalizedTokens(text).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/** The first `n` words of prose, used for the "keyword in the opening" check. */
export function firstWords(text: string, n: number): string {
  return words(text).slice(0, n).join(" ");
}
