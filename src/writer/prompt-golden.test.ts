import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {} }));
vi.mock('../lib/logger.js', () => {
  const stub = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: stub, log: stub, createLogger: () => stub };
});

const {
  buildQualityRules,
  buildLengthHint,
  buildTableHint,
  buildFaqRequest,
  buildEditorPrompt,
  buildSerpRider,
  buildSuperlativeRetryNote,
  buildStructuralRetryNote,
  buildFaqRewritePrompt,
  buildSystemPrompt,
  languageEnvelope,
} = await import('./run-commercial.js');
const { commercialSystemPrompt } = await import('./commercial.js');
const { packFor } = await import('../i18n/language-pack.js');
const { DEFAULT_LOCALE } = await import('../config/locale.js');

/**
 * THE BYTE-IDENTITY CONTRACT (LANG-01).
 *
 * Every fixture below is the exact string the commercial writer sends to the
 * model on the default en/US path. With no cluster_settings row (or an explicit
 * en/US row) these strings must be produced unchanged. Any refactor — language
 * packs, envelopes, dispatch — is accepted only while this file stays green
 * WITHOUT edits to the fixtures. Changing a prompt on purpose is a content
 * decision, and the fixture changes with it in the same commit.
 */

const PROMPT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'commercial-prompt.txt'
);

const ENVELOPE_FIXTURE =
  'You are a top local commercial copywriter creating this content NATIVELY in English for buyers in US. ' +
  'Write it from scratch the way the best local marketer would — never translate, and never carry over ' +
  'foreign phrasing, idiom or word order from any other language. Use the local conventions of US throughout: ' +
  'currency and its symbols, date formats, units of measurement, and digit grouping. The writing contract below ' +
  'governs everything; follow it exactly. It is in English, but everything a reader sees is written in English. ' +
  'Keep the input contract and the output field labels exactly as specified.';

const QUALITY_RULES_FIXTURE = (relatedTerms?: string) => `

Quality rules for this input (they apply to the body, the meta fields and the FAQ alike). The article itself is written in English:

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

English:
- Flawless native English throughout: grammar, agreement, spelling, punctuation, register and idiom exactly as a top local commercial copywriter would write — never phrasing that reads as translated from another language.
- Weave in these related terms naturally: ${relatedTerms || "—"}.`;

const TABLE_HINT_FIXTURE = `\n\nIf it serves the reader, gather the numeric data from the facts into one short table.`;

const LENGTH_HINT_FIXTURE = (targetWords: number) =>
  `\n\nLength guidance: aim for ${Math.round(targetWords * 0.8)}-${targetWords} words. Get there through depth — practical detail for every fact, buyer implications, usage examples — never through repetition. If there is no way without repeating, come in shorter.`;

const FAQ_REQUEST_FIXTURE =
  `\n\nEnd the article with a FAQ section of 4-5 buyer questions, written in English. ` +
  `Title the section with the natural local FAQ heading in English, and the heading must include the abbreviation "FAQ" (for example: "FAQ — " followed by the local phrasing). ` +
  `At most two questions revisit a topic already covered; the rest combine two facts from different sections into a new answer. ` +
  `Every answer stands alone — no references such as "above" or "in the price section" — and the business name appears in at most one answer. ` +
  `Never repeat sentences or example lists from the body — rephrase or add an angle. No question repeats a question already used as a section heading. ` +
  `Exactly one question is phrased in the search language of "how much does it cost", and its answer opens with the number itself, then what determines it. ` +
  `Zero new numbers beyond the facts. If a fact answers only partially, state what exists affirmatively instead of an evasive answer.`;

const EDITOR_PROMPT_FIXTURE = (serialized: string) =>
  `You are given an article in field format, written in English. Fix ONLY English language errors: ` +
  `grammar, agreement, spelling, punctuation, register, unidiomatic phrasing and calques — exactly as a native professional editor would. ` +
  `Do not change facts, numbers, headings, structure, links or length. If a number is phrased as an approximation in one place, align every occurrence to the approximation. ` +
  `Return the article in full, in exactly the same field format, with no notes.\n\n` +
  serialized;

const SERP_RIDER_FIXTURE = (brief: string) =>
  `\n\nThe live competitive picture on Google (collected once for this client — use it for structure and coverage only, never as facts about the business):\n${brief}\n` +
  `Cover the topics and questions everyone covers, and exploit the gaps — without inventing data about the business.`;

const SUPERLATIVE_RETRY_FIXTURE = (found: string[]) =>
  `\n\nYour previous version was rejected because it contained: ${found.join(", ")} — phrases with no backing in the facts. Rewrite completely without them.`;

const STRUCTURAL_NOTE_FIXTURE = (repeatedSpans: string[], superlatives: string[]) =>
  `\n\nThe previous version had structural defects — rewrite the article without them:\n` +
  [
    ...repeatedSpans.map((r) => `- a passage or pattern repeated more than once: ${r}`),
    ...superlatives.map((f) => `- a phrase with no backing in the facts: ${f}`),
  ].join("\n");

const FAQ_REWRITE_FIXTURE = (question: string, answer: string) =>
  `The following answer to the question "${question}" repeats phrasing from the article body. ` +
  `Rewrite it in English: exactly the same facts, zero new numbers beyond the facts, completely different wording. ` +
  `The answer must stand alone — no references ("above", "in the price section"); if it is a price question, open with the number from the facts; ` +
  `if it opens with "Yes." or "No.", make sure the rest of the answer agrees with that word — in doubt, drop the opener and answer affirmatively. ` +
  `Return the answer only, with no question and no notes.\n\nCurrent answer: ${answer}`;

const EN_EXPLICIT = { language: 'en', country: 'US', languageName: 'English', isDefault: false };
const AR_AE = { language: 'ar', country: 'AE', languageName: 'Arabic', isDefault: false };
const JA_JP = { language: 'ja', country: 'JP', languageName: 'Japanese', isDefault: false };

describe('golden: the default (unset locale) prompt path is byte-identical', () => {
  it('system prompt = envelope + blank line + the raw prompt file', () => {
    const raw = fs.readFileSync(PROMPT_FILE, 'utf8');
    expect(buildSystemPrompt()).toBe(ENVELOPE_FIXTURE + '\n\n' + raw);
    expect(buildSystemPrompt(DEFAULT_LOCALE)).toBe(buildSystemPrompt());
    expect(commercialSystemPrompt()).toBe(raw);
  });

  it('an explicit en/US row behaves exactly like unset — single code path', () => {
    expect(buildSystemPrompt(EN_EXPLICIT)).toBe(buildSystemPrompt(DEFAULT_LOCALE));
  });

  it('quality rules rider — exact bytes, with and without related terms', () => {
    expect(buildQualityRules()).toBe(QUALITY_RULES_FIXTURE());
    expect(buildQualityRules('projector rental, event projector')).toBe(
      QUALITY_RULES_FIXTURE('projector rental, event projector')
    );
  });

  it('length hint — exact bytes, and empty when no target', () => {
    expect(buildLengthHint(700)).toBe(LENGTH_HINT_FIXTURE(700));
    expect(buildLengthHint(0)).toBe('');
  });

  it('table hint — exact bytes above the numeric-facts threshold, empty below', () => {
    expect(buildTableHint(6)).toBe(TABLE_HINT_FIXTURE);
    expect(buildTableHint(5)).toBe('');
  });

  it('FAQ request — opt-in only, exact bytes when WANT_FAQ=true', () => {
    const prev = process.env.WANT_FAQ;
    delete process.env.WANT_FAQ;
    expect(buildFaqRequest()).toBe('');
    process.env.WANT_FAQ = 'true';
    expect(buildFaqRequest()).toBe(FAQ_REQUEST_FIXTURE);
    if (prev === undefined) delete process.env.WANT_FAQ;
    else process.env.WANT_FAQ = prev;
  });

  it('editor pass prompt — exact bytes around the serialized article', () => {
    const serialized = 'title: A title\nmeta: M\nslug: s\nh1: H\nbody: Body';
    expect(buildEditorPrompt(serialized)).toBe(EDITOR_PROMPT_FIXTURE(serialized));
  });

  it('SERP rider — exact bytes around the brief', () => {
    expect(buildSerpRider('brief')).toBe(SERP_RIDER_FIXTURE('brief'));
  });

  it('superlative retry note — exact bytes', () => {
    expect(buildSuperlativeRetryNote(['always', 'the best'])).toBe(
      SUPERLATIVE_RETRY_FIXTURE(['always', 'the best'])
    );
  });

  it('structural retry note — exact bytes', () => {
    expect(buildStructuralRetryNote(['a repeated span'], ['perfect'])).toBe(
      STRUCTURAL_NOTE_FIXTURE(['a repeated span'], ['perfect'])
    );
  });

  it('FAQ rewrite prompt — exact bytes', () => {
    expect(buildFaqRewritePrompt('How much?', 'The price starts at about $2,500.')).toBe(
      FAQ_REWRITE_FIXTURE('How much?', 'The price starts at about $2,500.')
    );
  });
});

describe('golden: the prompt file is a language-neutral English contract', () => {
  const raw = fs.readFileSync(PROMPT_FILE, 'utf8');

  it('carries the machine contract the parser depends on', () => {
    for (const label of ['title:', 'meta:', 'slug:', 'h1:', 'body:', 'internal_links:', 'facts_used:', 'sources_used:']) {
      expect(raw).toContain(`\n${label}\n`);
    }
    for (const field of ['host:', 'buyer_query:', 'unique_fact:', 'forbidden:', 'live_urls:', 'sister_hosts:', 'external_sources:']) {
      expect(raw).toContain(`- ${field}`);
    }
    expect(raw).toContain('STOP: [');
    expect(raw).toContain('\nRules:\n');
    expect(raw).toContain('\nReturn exactly:\n');
  });

  it('names no language — the envelope does that', () => {
    expect(raw).not.toMatch(/\b(English|Hebrew|Arabic|German)\b/);
    expect(raw).toContain("the article's target language");
  });

  it('is plain ASCII, so no script is built into the contract', () => {
    expect(raw).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('golden: every locale wraps — never edits — the prompt file', () => {
  it.each([
    ['en/US', EN_EXPLICIT],
    ['ar/AE', AR_AE],
    ['ja/JP', JA_JP],
  ])('%s system prompt = envelope + blank line + the raw file, file bytes untouched', (_label, locale) => {
    const raw = fs.readFileSync(PROMPT_FILE, 'utf8');
    const sys = buildSystemPrompt(locale);
    expect(sys.endsWith('\n\n' + raw)).toBe(true);
    const envelope = sys.slice(0, sys.length - ('\n\n' + raw).length);
    expect(envelope).toBe(languageEnvelope(locale));
    expect(envelope).toContain(locale.languageName);
    expect(envelope).toContain(locale.country);
    expect(envelope).toMatch(/NATIVELY/);
    expect(envelope).toMatch(/never translat/i);
    expect(envelope).toMatch(/currency/i);
    expect(envelope).toMatch(/date/i);
    expect(envelope).toMatch(/unit/i);
    // It frames, the contract governs: keep it under ~120 words.
    expect(envelope.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
  });

  it('tells the model that English instructions still mean native reader-facing text', () => {
    expect(languageEnvelope(JA_JP)).toContain('everything a reader sees is written in Japanese');
    expect(languageEnvelope(AR_AE)).toContain('NATIVELY in Arabic');
  });

  it('every prompt builder names the target language, not English, for a non-English pack', () => {
    const ja = packFor('ja');
    expect(buildQualityRules(undefined, ja)).toContain('native Japanese');
    expect(buildEditorPrompt('x', ja)).toContain('Fix ONLY Japanese language errors');
    expect(buildFaqRewritePrompt('q', 'a', ja)).toContain('Rewrite it in Japanese');
  });
});
