/**
 * The commercial writer — one model call, one prompt, no supervision chain.
 *
 * This replaces the multi-agent pipeline (writer → validators → Gate 2 →
 * revision loops) for article generation. That chain existed to babysit a weak
 * model; a blind judging round across three model tiers showed the thing that
 * actually separates publishable from dangerous is not review depth but
 * *input discipline*: the model may only state facts the customer confirmed.
 * The prompt enforces it, and one deterministic number check verifies it.
 *
 * The prompt lives in `commercial-prompt.txt`. It is a language-neutral English
 * contract, not code, and editing it is a content decision.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../lib/logger.js";
import { enPack, type LanguagePack } from "../i18n/language-pack.js";

const PROMPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "commercial-prompt.txt"
);

/**
 * The prompt as authored — unless the publisher's editor supplied their own
 * rules (EDITORIAL_RULES). Then the "Rules:" section is theirs, verbatim, and
 * only the machine contract around it (input fields, the STOP rule, the exact
 * output format the parser below depends on) is kept.
 */
export function commercialSystemPrompt(env: NodeJS.ProcessEnv = process.env): string {
  const prompt = fs.readFileSync(PROMPT_PATH, "utf8");
  const rules = env.EDITORIAL_RULES?.trim();
  if (!rules) return prompt;
  const start = prompt.indexOf("Rules:");
  const end = prompt.indexOf("Return exactly:");
  if (start === -1 || end === -1 || end < start) return prompt;
  return `${prompt.slice(0, start)}Rules:\n${rules}\n\n${prompt.slice(end)}`;
}

export interface CommercialInput {
  host: string;
  buyerQuery: string;
  /** Confirmed facts, already joined into one passage. */
  uniqueFact: string;
  forbidden?: string[];
  liveUrls?: string[];
  sisterHosts?: string[];
  externalSources?: string[];
}

/** The exact input block the prompt's contract expects. */
export function buildInputBlock(input: CommercialInput): string {
  const list = (v: string[] | undefined) => JSON.stringify(v ?? []);
  return [
    `host: ${input.host}`,
    `buyer_query: ${input.buyerQuery}`,
    `unique_fact: ${input.uniqueFact}`,
    `forbidden: ${list(input.forbidden)}`,
    `live_urls: ${list(input.liveUrls)}`,
    `sister_hosts: ${list(input.sisterHosts)}`,
    `external_sources: ${list(input.externalSources)}`,
  ].join("\n");
}

export interface CommercialArticle {
  title: string;
  meta: string;
  slug: string;
  h1: string;
  body: string;
  internalLinks: string[];
  factsUsed: string[];
  sourcesUsed: string[];
}

const FIELDS = [
  "title",
  "meta",
  "slug",
  "h1",
  "body",
  "internal_links",
  "facts_used",
  "sources_used",
] as const;

function parseListy(raw: string): string[] {
  const text = raw.trim();
  if (!text || text === "[]") return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Fall through to line splitting.
  }
  return text
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
}

/**
 * Parse the fixed `field:` layout the prompt demands.
 *
 * Null on a STOP response — that is the prompt refusing to write for missing
 * input, and it must surface as "the input is incomplete", never as a broken
 * article.
 */
export function parseCommercialArticle(raw: string): CommercialArticle | null {
  const text = raw.trim();
  if (/^STOP:/m.test(text)) {
    logger.warn({ stop: text.slice(0, 200) }, "[Commercial] Writer refused — missing input fields");
    return null;
  }

  // Split on the known field labels at line starts, tolerating markdown bold.
  const pattern = new RegExp(
    `^\\**\\s*(${FIELDS.join("|")})\\s*\\**\\s*:`,
    "gim"
  );
  const found: Record<string, string> = {};
  const matches = [...text.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].toLowerCase();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    // First occurrence wins: a body that happens to contain "meta:" later must
    // not overwrite the real field.
    if (!(name in found)) found[name] = text.slice(start, end).trim();
  }

  // A model that skips the "body:" label writes the article directly under
  // h1, so everything until the next label lands inside found.h1. Recover:
  // the first line is the h1, the rest is the body.
  if (!found.body && found.h1 && found.h1.includes("\n")) {
    const cut = found.h1.indexOf("\n");
    const rest = found.h1.slice(cut + 1).trim();
    if (rest.length > 200) {
      found.body = rest;
      found.h1 = found.h1.slice(0, cut).trim();
    }
  }

  if (!found.title || !found.body || !found.h1) {
    logger.error(
      { fields: Object.keys(found), head: text.slice(0, 200) },
      "[Commercial] Response did not follow the output contract"
    );
    return null;
  }

  return {
    title: found.title,
    meta: found.meta ?? "",
    slug: (found.slug ?? "").replace(/^\/+|\/+$/g, ""),
    h1: found.h1,
    body: found.body,
    internalLinks: parseListy(found.internal_links ?? ""),
    factsUsed: parseListy(found.facts_used ?? ""),
    sourcesUsed: parseListy(found.sources_used ?? ""),
  };
}

// ============================================================================
// The one check that survives: no number the customer did not confirm.
// ============================================================================

/**
 * One numeric token, normalised across locale formats (LANG-06).
 *
 * The rule: a separator (comma or dot) followed by exactly 3 digits is
 * GROUPING and is stripped; any other separator is a DECIMAL, normalized to
 * a dot. So "1,500" → "1500" (unchanged from the historical behavior),
 * "2,5" → "2.5" (was mangled to "25"), "1.234.567" → "1234567",
 * "3.14" → "3.14". Both the facts and the article pass through the same
 * function, so identical (or equivalent) formats always still match.
 */
function normalizeNumberToken(raw: string): string {
  const token = raw.replace(/[,.]+$/, "");
  if (!/[.,]/.test(token)) return token;
  const parts = token.split(/[.,]/);
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out += parts[i].length === 3 ? parts[i] : "." + parts[i];
  }
  // Canonicalize a clean decimal so "850,50" and "850.5" meet at "850.5".
  // Only tokens that contained a separator get this — bare tokens ("054")
  // keep their digits untouched, exactly as before.
  if (/^\d+\.\d+$/.test(out)) {
    const value = Number(out);
    if (Number.isFinite(value)) return String(value);
  }
  return out;
}

/**
 * Any Unicode decimal digit to its ASCII digit, and the Arabic decimal and
 * thousands marks to their ASCII forms. Each digit set is a contiguous run from
 * zero, so a digit's value is its distance from the start of its run.
 */
function asciiNumerals(text: string): string {
  return text
    .replace(/\u066B/g, ".")
    .replace(/\u066C/g, ",")
    .replace(/\p{Nd}/gu, (digit) => {
      const point = digit.codePointAt(0)!;
      let zero = point;
      while (point - zero < 9 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
      return String(point - zero);
    });
}

/** Every numeric token in a text, normalised (1,500 → 1500; 2,5 → 2.5). */
export function numbersIn(text: string): string[] {
  return [...asciiNumerals(text).matchAll(/\d[\d,.]*/g)]
    .map((m) => normalizeNumberToken(m[0]))
    .filter((n) => n.length > 0);
}

export interface NumberAudit {
  ok: boolean;
  /** Numbers in the article that appear nowhere in the supplied input. */
  unsupported: string[];
  /** True when the body leans on the pack's quantity words with no digits to anchor them. */
  vagueQuantities: boolean;
  /** Present when the language has no vague-quantity wordlist — gate skipped, explicitly. */
  skipped?: string;
}

/**
 * The blind round's lesson, made mechanical: a number in the article must have
 * come from the input. Phone digits, years and small structural numbers (H2
 * counts, "3 hours" style trivia below 25) are allowed — the damage lives in
 * prices and quantities, which are exactly the ones a customer gets sued over.
 */
export function auditNumbers(
  article: CommercialArticle,
  input: CommercialInput,
  pack: LanguagePack = enPack
): NumberAudit {
  const supplied = new Set(
    numbersIn(
      [
        input.uniqueFact,
        input.buyerQuery,
        ...(input.externalSources ?? []),
        ...(input.liveUrls ?? []),
      ].join(" ")
    )
  );

  const currentYear = new Date().getFullYear();
  const unsupported = numbersIn(`${article.body} ${article.title} ${article.h1} ${article.meta}`)
    .filter((n) => !supplied.has(n))
    .filter((n) => {
      const value = Number(n);
      if (!Number.isFinite(value)) return true;
      if (value <= 25) return false; // list positions, hours, small counts
      if (value >= currentYear - 1 && value <= currentYear + 1) return false; // years
      return true;
    });

  const result: NumberAudit = {
    ok: unsupported.length === 0,
    unsupported: [...new Set(unsupported)],
    // Dispatched per language: an uncurated language reports the skip instead
    // of silently passing.
    vagueQuantities: pack.vagueNumberWords
      ? pack.vagueNumberWords.test(article.body) && supplied.size === 0
      : false,
  };
  if (!pack.vagueNumberWords) result.skipped = `no-vague-quantity-words:${pack.code}`;
  return result;
}

// ============================================================================
// Link audit: every link in the article must be one we handed the writer.
// ============================================================================

export interface LinkAudit {
  ok: boolean;
  /** Links in the body that were not in live_urls or external_sources. */
  unknown: string[];
  /** Supplied internal links the article actually used. */
  used: string[];
  /** Anchor texts that say nothing ("click here") — Google reads the anchor. */
  genericAnchors: string[];
}

/**
 * Anchor texts that describe the click, not the destination. Exact-match after
 * normalisation on purpose: "here are all our prices" is a real anchor that
 * merely CONTAINS a generic word, and flagging it would train the operator to
 * ignore the audit.
 */
const GENERIC_ANCHORS = new Set([
  "click here",
  "read more",
  "learn more",
  "here",
]);

/** Lowercased, tag-stripped, space-collapsed anchor text for comparison. */
function normalizeAnchor(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A link the writer was not given is a link that may 404 on the customer's
 * site — or point at a competitor. Checked mechanically, like the numbers.
 * The anchor TEXT is audited too (SEO-G): a generic anchor throws away the
 * one signal an internal link exists to carry.
 */
export function auditLinks(article: CommercialArticle, input: CommercialInput): LinkAudit {
  const allowed = new Set([
    ...(input.liveUrls ?? []).map((url) => url.split(" ")[0]),
    ...(input.externalSources ?? []),
  ]);

  const markdownMatches = [...article.body.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)];
  const htmlMatches = [
    ...article.body.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ];
  const found = [
    ...markdownMatches.map((m) => ({ href: m[2], anchor: m[1] })),
    ...htmlMatches.map((m) => ({ href: m[1], anchor: m[2] })),
  ];

  const hrefs = found.map((l) => l.href);
  const unknown = [...new Set(hrefs.filter((href) => !allowed.has(href)))];
  const used = [...new Set(hrefs.filter((href) => allowed.has(href)))];
  const genericAnchors = [
    ...new Set(
      found
        .map((l) => normalizeAnchor(l.anchor))
        .filter((anchor) => GENERIC_ANCHORS.has(anchor))
    ),
  ];
  return { ok: unknown.length === 0 && genericAnchors.length === 0, unknown, used, genericAnchors };
}

// ============================================================================
// Superlative audit: unsupported "best/always/everywhere" claims.
// ============================================================================

export interface SuperlativeAudit {
  ok: boolean;
  found: string[];
  /** Present when the language has no curated superlative list — gate skipped, explicitly. */
  skipped?: string;
}

/**
 * A superlative is allowed only when the fact library literally contains it —
 * otherwise it is invented salesmanship, and "reaches every location" three
 * paragraphs before the real service-area list is a contradiction a SERP snippet exposes.
 *
 * The wordlist and hedging rules live in the language pack (LANG-03): en has
 * a curated list with negation and bounding hedges; an uncurated language
 * returns ok with an explicit skipped marker — never a false hold, never
 * silent.
 */
export function auditSuperlatives(
  article: CommercialArticle,
  input: CommercialInput,
  pack: LanguagePack = enPack
): SuperlativeAudit {
  if (!pack.superlatives) {
    return { ok: true, found: [], skipped: `no-superlative-list:${pack.code}` };
  }
  const raw = `${article.title} ${article.meta} ${article.h1} ${article.body}`;
  const text = pack.foldCase ? raw.toLowerCase() : raw;
  const facts = pack.foldCase ? input.uniqueFact.toLowerCase() : input.uniqueFact;
  const unhedged = (term: string): boolean => {
    for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
      if (!pack.isHedged(text, at, term)) return true;
    }
    return false;
  };
  const found = pack.superlatives.filter((term) => unhedged(term) && !facts.includes(term));
  return { ok: found.length === 0, found };
}
