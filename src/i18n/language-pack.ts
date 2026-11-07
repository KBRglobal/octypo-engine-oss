/**
 * Language packs — every prompt scaffold the commercial writer path sends,
 * dispatched per cluster language (LANG-02, LANG-03).
 *
 * Every pack is English meta-language: models follow English instructions
 * about a target language reliably, so a German cluster gets English
 * scaffolding that names German, while the article itself is written natively
 * in German. The `en` pack adds the curated gate lists; the golden test
 * (src/writer/prompt-golden.test.ts) freezes its strings.
 *
 * Packs carry SCAFFOLDING only. The native-writing / local-conventions rule
 * lives in the envelope (languageEnvelope in run-commercial.ts), which stays
 * a separate prefix around the prompt file.
 *
 * Only `languageName` values derived internally by languageNameFor are ever
 * interpolated here — never operator-stored strings (T-quick-01).
 */

import { languageNameFor } from "../config/locale.js";

export interface LanguagePack {
  /** ISO 639-1 code this pack serves. */
  code: string;
  /** Plain English language name, derived internally by languageNameFor. */
  languageName: string;

  // ── Writer-path scaffolds ────────────────────────────────────────────
  /** The quality rider appended to every article input. */
  qualityRules(relatedTerms?: string): string;
  /** Length guidance for a lo-hi word window. */
  lengthHint(lo: number, hi: number): string;
  /** The one-table nudge when the facts carry numbers. */
  tableHint: string;
  /** The FAQ section request. */
  faqRequest: string;
  /** Rewrite prompt for one FAQ answer that overlaps the body. */
  faqRewritePrompt(question: string, answer: string): string;
  /** Targeted retry naming unsupported superlatives. */
  superlativeRetryNote(found: string[]): string;
  /** Full-retry note naming structural defects. */
  structuralRetryNote(repeatedSpans: string[], superlatives: string[]): string;
  /** The grammar-only editor pass around the serialized article. */
  editorPassPrompt(serialized: string): string;
  /** The competitive-snapshot rider around a stored SERP brief. */
  serpRider(brief: string): string;
  /**
   * The money-links rider (SEO-G): names the operator's conversion pages and
   * asks for exactly ONE natural-anchor link to the most relevant of them.
   * Appended ONLY when MONEY_URLS is set — the default path never sees it.
   */
  moneyLinkRider(entries: { path: string; label: string }[]): string;

  // ── Mechanical recognition ───────────────────────────────────────────
  /** Recognizes the FAQ section heading liftFaq extracts. */
  faqHeadingPattern: RegExp;
  /** Script a slug must contain, or null when Latin is fine. */
  slugScriptPattern: RegExp | null;

  // ── SERP research ────────────────────────────────────────────────────
  /** System prompt distilling raw results into a coverage brief. */
  distillPrompt: string;
  /** The zero-cost paste-ready research prompt. */
  serpPastePrompt(queries: string[]): string;

  // ── Deterministic gate lists (LANG-03) ───────────────────────────────
  //
  // A `null` list means the gate has no curated vocabulary for this
  // language: the gate does not run, and the caller records an explicit
  // skipped marker in the persisted audit payload (T-quick-02) — never a
  // false hold, never a silent pass. Language-neutral gates (numbers,
  // links, repetition, density counting) run unconditionally regardless.

  /** Lowercase-fold text before term search (a no-op for caseless scripts). */
  foldCase: boolean;
  /** Unsupported-boast wordlist, or null → gate skipped with a marker. */
  superlatives: string[] | null;
  /** True when the term occurrence at `at` is hedged (negated or bounded). */
  isHedged(text: string, at: number, term: string): boolean;
  /** Vague quantity words with no digits to anchor them, or null → skipped. */
  vagueNumberWords: RegExp | null;
  /** Writing-process vocabulary that must never reach a reader, or null. */
  processLeaks: string[] | null;
  /** Deictic phrases a standalone FAQ answer must not contain, or null. */
  faqDeictics: string[] | null;
  /** The noun replacing excess brand mentions, or null → skip demotion. */
  demotionNoun: string | null;
  /** Recognizes a price-like span (number + currency marker), or null → VAT gate skipped. */
  priceMarkerPattern: RegExp | null;
  /** Recognizes a VAT qualifier token near prices, or null → VAT gate skipped. */
  vatQualifierWords: RegExp | null;
  /** Promise verbs a YMYL topic must not carry, or null → gate skipped. */
  promiseVerbs: string[] | null;
  /** Health/money/legal topic terms that arm the promise gate, or null → gate skipped. */
  ymylTopicTerms: string[] | null;
  /** Contact-sentence markers that count as a CTA span, or null → gate skipped. */
  ctaContactMarkers: string[] | null;
  /** Operator-facing brand-density message. */
  brandDensityMessage(count: number): string;
}

// ============================================================================
// English meta-language packs — for en and every other ISO 639-1 language.
//
// The scaffolding is English (models follow English meta-instructions about
// a target language reliably); the article itself is written natively in the
// target language under the envelope's native-writing rule. Grammar rules are
// never spelled out per language: the short native-grammar directive below
// covers all of them.
// ============================================================================

/** ISO 15924 codes that name several Unicode scripts, or none directly. */
const COMPOSITE_SCRIPTS: Record<string, string> = {
  Jpan: "\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}",
  Kore: "\\p{Script=Hangul}\\p{Script=Han}",
  Hans: "\\p{Script=Han}",
};

/**
 * The script a native slug must contain, derived from the language's likely
 * script rather than listed per language. Latin-script languages need none.
 */
function slugScriptFor(code: string): RegExp | null {
  const script = new Intl.Locale(code).maximize().script;
  if (!script || script === "Latn") return null;
  return new RegExp(`[${COMPOSITE_SCRIPTS[script] ?? `\\p{Script=${script}}`}]`, "u");
}

const BRIEF_FORMAT_SECTIONS = (languageName: string) =>
  `Topics every competitor covers: (3-6 lines)\n` +
  `Buyer questions arising from the results: (3-6 lines)\n` +
  `Winning title patterns: (2-3 lines — which words recur in the ranking titles)\n` +
  `Professional terms the market uses: (one line, comma-separated)\n` +
  `Gaps and opportunities: (2-4 lines — what is missing from the results that a good article can cover)\n\n` +
  `Rules: only what the results actually show — never invent data; never name competitors; ` +
  `write the brief in ${languageName}; output the brief only, with no preamble.`;

function makeEnglishMetaPack(code: string, languageName: string): LanguagePack {
  return {
    code,
    languageName,

    qualityRules: (relatedTerms?: string) => `

Quality rules for this input (they apply to the body, the meta fields and the FAQ alike). The article itself is written in ${languageName}:

Opening and answer:
- The first paragraph: 40-55 words that answer buyer_query directly and completely. The first sentence opens with the business name and the numeric answer — no hedging, no precondition, no rhetorical question, no superlative.
- If there is a price fact, the full price sentence appears exactly once, in the second sentence of the first paragraph (inside the first 55 words), before operational detail. The meta description carries a short price capsule; a table carries the bare number. There is no second price section, and the full price sentence is never repeated anywhere else.
- If the input has no price fact, there is no price sentence, price section or price table: write the article from the facts available. Do not stop, do not ask for another field and do not answer STOP.
- The price sentence is anchored to the business name. The phone number appears in the closing section of the body, not in the meta.
- The article title contains the primary search phrase (keyword) verbatim, and the exact phrase also appears in the first paragraph. meta_title ends with "| business name". Print every output field with its label — including h1: (phrased slightly differently from the title) and the body: label before the article body.

Fact discipline:
- Every fact appears in ONE place only: prose, table or FAQ — never in two.
- No superlatives or universal quantifiers ("the best", "always", "perfect", "everywhere", "guaranteed") unless a fact states them literally.
- Never invent uses, events, formats, promises or quantities that are not in the facts, and keep each fact's own wording, scope and hedges — never upgrade them ("also in rain" never becomes "in any weather").
- Never tie items included in the service to the price: "included in the service" stays exactly that, unless a fact links them.
- Never derive combined conclusions from two facts — state each fact in its own phrasing only.
- Never intensify a fact: amplifiers ("absolutely", "fully", "at the last minute") are forbidden in a sentence that carries a fact, unless the fact itself uses them.
- A qualifier travels with its number to every occurrence, and a number phrased as an approximation stays approximate everywhere, including the opening and the meta.
- Never generalize from the business to the category: what is true of this business is not "standard in the industry".
- Never compare to other vendors. In comparison sections, claims are allowed only about the business's own product; other formats may be mentioned as a point of contrast only, with no attributes, limits or purposes ascribed to them.

Structure:
- Subheadings in markdown syntax (##), phrased as buyer questions where natural.
- Exactly one ## section for price, merging the influencing factors + what is included + the table; no separate "what affects the price" section. The summary table comes last, before the FAQ.
- The exact search phrase appears in at most two subheadings; vary the phrasing of the rest. Never append the phrase after a dash in a heading.
- Technical terms keep their accepted market name — never invent a translation for a professional term.
- Every fact is fully phrased exactly once in the whole article; any further mention is a short reference, never the full sentence again.
- A fact shown in the table gets exactly one prose sentence in the body — no more. The business name appears at most 8 times in the body.
- No two adjacent ## headings share a run of 3 or more words.
- Never expose the writing process — phrasings like "a fact provided", "per the brief", "according to the supplied information" are forbidden.
- No summary/closing section: the last body section before the FAQ ends with a single call-to-action sentence carrying the phone number when the facts include one.
- In at least two key sections (price and one more) include one standalone sentence that carries the business name and the fact and can be quoted alone; elsewhere, do not force the business name in.

${languageName}:
- Flawless native ${languageName} throughout: grammar, agreement, spelling, punctuation, register and idiom exactly as a top local commercial copywriter would write — never phrasing that reads as translated from another language.
- Weave in these related terms naturally: ${relatedTerms || "—"}.`,

    lengthHint: (lo: number, hi: number) =>
      `\n\nLength guidance: aim for ${lo}-${hi} words. Get there through depth — practical detail for every fact, buyer implications, usage examples — never through repetition. If there is no way without repeating, come in shorter.`,

    tableHint: `\n\nIf it serves the reader, gather the numeric data from the facts into one short table.`,

    faqRequest:
      `\n\nEnd the article with a FAQ section of 4-5 buyer questions, written in ${languageName}. ` +
      `Title the section with the natural local FAQ heading in ${languageName}, and the heading must include the abbreviation "FAQ" (for example: "FAQ — " followed by the local phrasing). ` +
      `At most two questions revisit a topic already covered; the rest combine two facts from different sections into a new answer. ` +
      `Every answer stands alone — no references such as "above" or "in the price section" — and the business name appears in at most one answer. ` +
      `Never repeat sentences or example lists from the body — rephrase or add an angle. No question repeats a question already used as a section heading. ` +
      `Exactly one question is phrased in the search language of "how much does it cost", and its answer opens with the number itself, then what determines it. ` +
      `Zero new numbers beyond the facts. If a fact answers only partially, state what exists affirmatively instead of an evasive answer.`,

    faqRewritePrompt: (question: string, answer: string) =>
      `The following answer to the question "${question}" repeats phrasing from the article body. ` +
      `Rewrite it in ${languageName}: exactly the same facts, zero new numbers beyond the facts, completely different wording. ` +
      `The answer must stand alone — no references ("above", "in the price section"); if it is a price question, open with the number from the facts; ` +
      `if it opens with "Yes." or "No.", make sure the rest of the answer agrees with that word — in doubt, drop the opener and answer affirmatively. ` +
      `Return the answer only, with no question and no notes.\n\nCurrent answer: ${answer}`,

    superlativeRetryNote: (found: string[]) =>
      `\n\nYour previous version was rejected because it contained: ${found.join(", ")} — phrases with no backing in the facts. Rewrite completely without them.`,

    structuralRetryNote: (repeatedSpans: string[], superlatives: string[]) =>
      `\n\nThe previous version had structural defects — rewrite the article without them:\n` +
      [
        ...repeatedSpans.map((r) => `- a passage or pattern repeated more than once: ${r}`),
        ...superlatives.map((f) => `- a phrase with no backing in the facts: ${f}`),
      ].join("\n"),

    editorPassPrompt: (serialized: string) =>
      `You are given an article in field format, written in ${languageName}. Fix ONLY ${languageName} language errors: ` +
      `grammar, agreement, spelling, punctuation, register, unidiomatic phrasing and calques — exactly as a native professional editor would. ` +
      `Do not change facts, numbers, headings, structure, links or length. If a number is phrased as an approximation in one place, align every occurrence to the approximation. ` +
      `Return the article in full, in exactly the same field format, with no notes.\n\n` +
      serialized,

    serpRider: (brief: string) =>
      `\n\nThe live competitive picture on Google (collected once for this client — use it for structure and coverage only, never as facts about the business):\n${brief}\n` +
      `Cover the topics and questions everyone covers, and exploit the gaps — without inventing data about the business.`,

    moneyLinkRider: (entries) =>
      `\n\nThe business's conversion pages on this site: ${entries.map((e) => `${e.path} — ${e.label}`).join("; ")}. ` +
      `Weave exactly one link into the article body to the single most relevant page from this list, placed naturally ` +
      `(the price section or the closing section), with a descriptive anchor that names the destination — never "click here".`,

    faqHeadingPattern: /\bFAQ\b/i,
    slugScriptPattern: slugScriptFor(code),

    distillPrompt:
      `You are a competitive analyst for search content. You are given the real search results (title + description) for a client's key queries in ${languageName}. ` +
      `Distill them into a short coverage brief for an article writer, in exactly this format:\n\n` +
      BRIEF_FORMAT_SECTIONS(languageName),

    serpPastePrompt: (queries: string[]) =>
      `Search Google in ${languageName} for the following queries and review the first results page of each:\n` +
      queries.map((q) => `- ${q}`).join("\n") +
      `\n\nBased on what you actually found, write a coverage brief in exactly this format:\n\n` +
      BRIEF_FORMAT_SECTIONS(languageName),

    // Gate lists: uncurated by default — every null gate is skipped WITH an
    // explicit marker in the persisted audit payload, never silently.
    foldCase: true,
    superlatives: null,
    isHedged: () => false,
    vagueNumberWords: null,
    processLeaks: null,
    faqDeictics: null,
    demotionNoun: null,
    priceMarkerPattern: null,
    vatQualifierWords: null,
    promiseVerbs: null,
    ymylTopicTerms: null,
    ctaContactMarkers: null,
    brandDensityMessage: (count: number): string =>
      `The business name appears ${count} times in the body — cap it at 8 mentions and vary the rest.`,
  };
}

// ============================================================================
// English — the meta pack plus curated gate lists (LANG-03). Terms are
// lowercase: English packs fold case before searching (foldCase above).
// ============================================================================

export const enPack: LanguagePack = {
  ...makeEnglishMetaPack("en", "English"),
  faqHeadingPattern: /frequently\s+asked\s+questions|\bFAQ\b/i,
  superlatives: [
    "the best",
    "always",
    "guaranteed",
    "perfect",
    "unbeatable",
    "everywhere",
    "anywhere",
    "number one",
    "#1",
    "world-class",
    "unmatched",
    "industry-leading",
    "market-leading",
    "state-of-the-art",
    "every location",
    "any location",
    "at any time",
    "fully flexible",
    "completely",
    "absolutely",
  ],
  // A negated quantifier ("not always") is a hedge, and a place or time
  // quantifier bounded by a restrictive clause ("every location you choose")
  // claims only the chosen case — neither is the boast the audit catches.
  isHedged: (text: string, at: number, term: string): boolean => {
    const before = text.slice(Math.max(0, at - 12), at);
    const after = text.slice(at + term.length, at + term.length + 8);
    const negated = /(?:^|\s)(?:not|never|no|isn't|aren't|don't|won't|can't|cannot|hardly|rarely)\s*$/.test(before);
    const bounded = /(?:location|time)$/.test(term) && /^\s+(?:that|which|you|we)\b/.test(after);
    return negated || bounded;
  },
  vagueNumberWords: /(thousand|million|billion|hundreds)/i,
  processLeaks: [
    "the fact provided",
    "the facts provided",
    "fact supplied",
    "facts supplied",
    "per the brief",
    "according to the brief",
    "the supplied information",
    "information supplied",
    "as provided in the input",
    "per the instructions",
    "from the briefing",
  ],
  faqDeictics: [
    "mentioned above",
    "see above",
    "as noted above",
    "described above",
    "listed above",
    "detailed above",
    "in the price section",
    "in the section above",
  ],
  demotionNoun: "the company",
  // A price-like span: digits next to a currency symbol or code, in either
  // order. The dollar is left out on purpose: US prices are quoted before sales
  // tax, so demanding a VAT qualifier there would flag every honest price.
  priceMarkerPattern:
    /\d[\d,.]*\s*(?:(?!\$)\p{Sc}|(?:EUR|GBP|ILS|NIS)\b|euros?\b)|(?:(?!\$)\p{Sc}|\b(?:EUR|GBP|ILS|NIS))\s*\d[\d,.]*/u,
  vatQualifierWords: /\bVAT\b|\bincl\w*|\bexcl\w*|\bplus tax\b|\bbefore tax\b/i,
  promiseVerbs: ["guaranteed", "guarantee", "guarantees", "we promise"],
  ymylTopicTerms: [
    // health
    "medical", "health", "treatment", "medication", "diet", "therapy",
    // money
    "insurance", "loan", "loans", "mortgage", "investment", "investments", "pension", "tax", "credit",
    // legal
    "legal", "lawyer", "attorney", "lawsuit", "inheritance",
  ],
  ctaContactMarkers: ["call us", "contact us", "get in touch", "leave your details"],
  brandDensityMessage: (count: number): string =>
    `The business name appears ${count} times in the body — cap it at 8 and replace the excess with "the company".`,
};

const packs = new Map<string, LanguagePack>([["en", enPack]]);

/**
 * The pack for a language code: an English meta-language pack naming the
 * target language. Codes outside the ISO 639-1 list should never reach here
 * (resolveLocale guarantees it) — defense in depth returns the default pack,
 * so an unvalidated string can never become a language name in a prompt.
 */
export function packFor(code: string): LanguagePack {
  const existing = packs.get(code);
  if (existing) return existing;
  const languageName = languageNameFor(code);
  if (!languageName) return enPack;
  const pack = makeEnglishMetaPack(code, languageName);
  packs.set(code, pack);
  return pack;
}
