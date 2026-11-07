/**
 * Topic terms: the shared vocabulary for "is this the same subject?".
 *
 * Two guards use it: the site-coverage check (an evergreen idea whose keyword
 * a hub page already owns) and the news-duplicate check (a feed item whose
 * story the engine already wrote). Both compare short phrases that can be in
 * any language, so everything here works from the text itself:
 *
 * - letters and digits of any script are kept; marks stay attached to their
 *   letter, so an Indic or Thai word is not shattered
 * - optional vowel pointing is dropped (abjads are written with or without it)
 * - apostrophes and quotes vanish ("O'Brien" = "OBrien")
 * - scripts written without spaces are split into words by the runtime's own
 *   word segmenter, so a Japanese headline yields words, not one long token
 *
 * The word lists below are English and belong to English text only. Other
 * languages need no list: what a language repeats in every headline is learnt
 * from the corpus (`frequentTokens`), and a word the lists miss only makes a
 * match less likely, never more.
 *
 * Instead of committing to one stem per word, every token keeps a small set of
 * candidate forms; two tokens are the same term when their sets meet. Both
 * sides are treated identically, so an over-eager strip on one side is also
 * made on the other.
 *
 * Concepts fold a handful of phrases that name the same thing into one opaque
 * term. The lists are deliberately short: a missing synonym only means a
 * duplicate slips through, a wrong one blocks a good article.
 */

/** Scripts written without spaces between words. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const wordSegmenter = new Intl.Segmenter("und", { granularity: "word" });

/** Function words: never carry a topic. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "from", "by", "with", "and", "or", "is", "are",
  "was", "be", "it", "its", "this", "that", "these", "as", "into", "over", "after", "before", "about",
  "how", "what", "when", "where", "why", "who", "which", "you", "your", "our", "we", "us", "vs",
  "today", "now", "all", "more", "most", "up", "out", "new", "will", "can", "than", "there", "here",
]);

/**
 * Words every page of a content site says. They tell nothing about which page
 * owns a topic. Site-specific ones (the city name) are added by the callers,
 * from document frequency or explicitly.
 */
const GENERIC = new Set([
  "guide", "guides", "tips", "complete", "list", "best", "top",
  // Every seasonal venue has a "season"; it names no story.
  "season", "seasonal",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "week", "month", "year", "update", "updates", "news", "latest",
]);

export interface Concept {
  id: string;
  /**
   * A weak concept (a venue, a sector) is one ordinary word in the news
   * check: two comedians at the same opera house are two stories.
   */
  weak?: boolean;
  /** Each phrase is matched on whole tokens. */
  phrases: string[];
}

/** Named things that read as one subject. Safe in any check. */
export const ENTITY_CONCEPTS: Concept[] = [{ id: "realestate", weak: true, phrases: ["real estate"] }];

/**
 * Query-intent synonyms for the coverage check. They are NOT used for news,
 * where "show" is an event word, not a topic.
 */
export const COVERAGE_CONCEPTS: Concept[] = [
  ...ENTITY_CONCEPTS,
  { id: "family", phrases: ["families", "family", "kids", "children"] },
  { id: "price", phrases: ["how much", "prices", "price", "cost", "costs"] },
  { id: "events", phrases: ["events", "event", "festivals", "festival"] },
];

const CONCEPT_PREFIX = "c_";

export interface Term {
  /** The token as it appeared, normalised. */
  raw: string;
  /** Candidate forms; two terms match when these sets intersect. */
  forms: string[];
  /** True for a folded concept. */
  concept: boolean;
  /** True for a folded weak concept (see Concept.weak). */
  weak?: boolean;
}

/** Split a space-free run into words; anything else stays as it is. */
function segmentWords(token: string): string[] {
  if (!UNSPACED_SCRIPT.test(token)) return [token];
  return [...wordSegmenter.segment(token)].map((part) => part.segment);
}

/**
 * Lowercase, drop optional vowel pointing and quotes, turn every other
 * punctuation mark into a space, and separate words in unspaced scripts. The
 * result is always tokens joined by single spaces.
 */
export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/([\p{Script=Arabic}\p{Script=Hebrew}])\p{Mn}+/gu, "$1")
    .replace(/['"`\u2018\u2019\u201C\u201D\u201E\u00B4\u05F3\u05F4]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}_]+/gu, " ")
    .trim()
    .split(" ")
    .flatMap(segmentWords)
    .join(" ");
}

/** English plurals; other languages keep the token as written. */
function suffixVariants(token: string): string[] {
  if (!/^[a-z]+$/.test(token)) return [];
  if (token.length > 4 && token.endsWith("ies")) return [`${token.slice(0, -3)}y`];
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return [token.slice(0, -1)];
  return [];
}

export function tokenForms(token: string): string[] {
  return [token, ...suffixVariants(token)];
}

/** True when any form of the token is on the list (list entries are raw words). */
function formsOnList(forms: string[], list: Set<string>): boolean {
  return forms.some((form) => list.has(form));
}

type Tok = { text: string; concept: boolean; weak?: boolean };

function compileConcepts(concepts: Concept[]): Array<{ id: string; weak: boolean; tokens: string[] }> {
  return concepts
    .flatMap((concept) =>
      concept.phrases.map((phrase) => ({ id: concept.id, weak: Boolean(concept.weak), tokens: normaliseText(phrase).split(" ") }))
    )
    .filter((entry) => entry.tokens.length > 0 && entry.tokens[0] !== "")
    // Longest phrase first, so "real estate investment" would win over "real estate".
    .sort((a, b) => b.tokens.length - a.tokens.length);
}

function foldConcepts(tokens: string[], concepts: Concept[]): Tok[] {
  if (concepts.length === 0) return tokens.map((text) => ({ text, concept: false }));
  const compiled = compileConcepts(concepts);
  const out: Tok[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = compiled.find(
      (entry) =>
        i + entry.tokens.length <= tokens.length &&
        entry.tokens.every((phraseToken, j) => tokens[i + j] === phraseToken)
    );
    if (hit) {
      out.push({ text: `${CONCEPT_PREFIX}${hit.id}`, concept: true, weak: hit.weak });
      i += hit.tokens.length;
    } else {
      out.push({ text: tokens[i], concept: false });
      i += 1;
    }
  }
  return out;
}

export interface TermOptions {
  concepts?: Concept[];
  /** Extra low-information words (normalised or not), e.g. the site's city. */
  generic?: Iterable<string>;
  /** Tokens to drop and report instead, e.g. event words in a headline. */
  exclude?: (forms: string[]) => boolean;
}

export function buildGenericSet(words: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const word of words ?? []) {
    const normal = normaliseText(word);
    if (normal) for (const part of normal.split(" ")) out.add(part);
  }
  return out;
}

/**
 * Content terms of a phrase in order of appearance, deduplicated.
 * Numbers, stopwords and generic words are dropped.
 */
export function contentTerms(text: string, options: TermOptions = {}): Term[] {
  const normal = normaliseText(text);
  if (!normal) return [];
  const extraGeneric = options.generic instanceof Set ? (options.generic as Set<string>) : buildGenericSet(options.generic);
  const toks = foldConcepts(normal.split(" "), options.concepts ?? []);
  const terms: Term[] = [];
  for (const tok of toks) {
    if (tok.concept) {
      if (!terms.some((term) => term.raw === tok.text)) {
        terms.push({ raw: tok.text, forms: [tok.text], concept: true, weak: tok.weak });
      }
      continue;
    }
    const token = tok.text;
    if (token.length < 2 || /^\d+$/.test(token) || STOPWORDS.has(token)) continue;
    const forms = tokenForms(token);
    if (formsOnList(forms, GENERIC) || formsOnList(forms, extraGeneric)) continue;
    if (options.exclude?.(forms)) continue;
    const term: Term = { raw: token, forms, concept: false };
    if (!terms.some((existing) => termsMatch(existing, term))) terms.push(term);
  }
  return terms;
}

export function termsMatch(a: Term, b: Term): boolean {
  if (a.concept || b.concept) return a.raw === b.raw;
  return a.forms.some((form) => b.forms.includes(form));
}

export function hasTerm(terms: Term[], term: Term): boolean {
  return terms.some((candidate) => termsMatch(candidate, term));
}

/** How many of `a` also appear in `b`. */
export function sharedTerms(a: Term[], b: Term[]): Term[] {
  return a.filter((term) => hasTerm(b, term));
}

/**
 * Words that appear in more than `ratio` of the documents: the site's own
 * city, its brand, and in any language the words every headline repeats. Only meaningful over a corpus of at least `minDocs`.
 */
export function frequentTokens(documents: string[], ratio = 0.3, minDocs = 8): Set<string> {
  const out = new Set<string>();
  if (documents.length < minDocs) return out;
  const counts = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set<string>();
    for (const token of normaliseText(doc).split(" ")) {
      if (!token || /^\d+$/.test(token)) continue;
      seen.add(token);
    }
    for (const token of seen) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    if (count / documents.length > ratio) out.add(token);
  }
  return out;
}
