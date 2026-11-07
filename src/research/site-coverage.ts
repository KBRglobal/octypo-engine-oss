/**
 * Does the host site already own this topic?
 *
 * The engine wrote evergreen guides on topics the site already answers with a
 * hub or a tool page — "/articles/opening-hours-guide/" beside "/opening-hours/",
 * and the same for prices, visas, hotels and transport. Google then split the
 * query between the two URLs and the hub fell. One query intent gets one
 * indexable URL, so an idea whose primary keyword a non-article page already
 * owns is not written at all.
 *
 * The evidence is the site's own statement: every sitemap URL outside the
 * article section, and the title and H1 of each. Matching is lexical and
 * conservative on purpose — a missed duplicate costs one weak article, a false
 * match silently kills a good one. An idea is covered only when
 *
 *   R1  its single topic term leads the page's heading ("flights" →
 *       "Flights today: ...") and anything after it is coordinated
 *       ("metro and taxis"), not a modifier ("sports betting"), or
 *   R2  all its (2+) terms are in the page's heading, or
 *   R3  all its (2+) terms are in the page's title/H1, and at least one of
 *       them is in a hub-shaped heading of at most two terms ("vegan
 *       restaurants" → "Vegan food: restaurants, ...").
 *
 * The heading is the part before the first ":" "?" "|" or dash, with the
 * site-name suffix removed. The home page and the article section never count.
 *
 * Language and country come from the caller. Neither is assumed: the country
 * and language are sent to the site, and the language decides which words
 * coordinate a heading.
 */

import { fetchSiteInventory, normalisePath } from "../lib/site-inventory.js";
import { logger } from "../lib/logger.js";
import {
  COVERAGE_CONCEPTS,
  buildGenericSet,
  contentTerms,
  frequentTokens,
  hasTerm,
  type Term,
} from "../lib/topic-terms.js";

export interface CoveragePage {
  url: string;
  path: string;
  title: string;
  h1: string;
}

export interface SiteCoverage {
  origin: string;
  pages: CoveragePage[];
  /** Words so common across the site's headings they say nothing (the city). */
  siteGeneric: string[];
  fetchedAt: string;
  /** Empty when the load succeeded. */
  error: string;
}

/** Which audience the site is read for. */
export interface CoverageLocale {
  /** ISO 639-1 language code. */
  language: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
}

const DEFAULT_COVERAGE_LOCALE: CoverageLocale = { language: "en", country: "US" };

export interface CoverageMatch {
  url: string;
  path: string;
  rule: "R1" | "R2" | "R3";
  /** The page text the keyword was matched against. */
  matchedOn: string;
}

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; url?: string; text(): Promise<string> }>;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 OctypoSiteCoverage/1.0";

/** Path prefixes that hold engine-written articles, never hubs. */
export function articlePrefixes(): string[] {
  const configured = (process.env.ARTICLE_PATH_PREFIX || "").trim();
  return [...new Set([configured, "/articles", "/guides", "/blog", "/news-articles"].filter(Boolean))].map((prefix) =>
    normalisePath(prefix)
  );
}

export function isHubPath(path: string, prefixes: string[] = articlePrefixes()): boolean {
  const p = normalisePath(path);
  if (p === "/") return false;
  if (/\.[a-z0-9]{2,5}$/i.test(p)) return false;
  // The section index itself (/articles/) is not a topic page either.
  return !prefixes.some((prefix) => p === prefix || p.startsWith(prefix));
}

// ---------- HTML ----------

function decodeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

export function titleAndH1(html: string): { title: string; h1: string } {
  const title = decodeHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const h1 = decodeHtml(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "");
  return { title, h1 };
}

/** "Topic: detail | Site" → "Topic: detail" */
export function stripSiteName(title: string): string {
  const parts = title.split(/\s[|•·]\s/);
  return parts.length > 1 ? parts.slice(0, -1).join(" | ").trim() : title.trim();
}

/** The part of a heading before the first ":" "?" "|" or spaced dash, in any script. */
export function headingHead(text: string): string {
  return stripSiteName(text).split(/[:?|\u061F\uFF1A\uFF1F]|\s[-–—]\s/)[0]?.trim() ?? "";
}

// ---------- loading ----------

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}

export async function fetchSiteCoverage(
  siteUrl: string,
  options: {
    fetchImpl?: FetchLike;
    now?: Date;
    concurrency?: number;
    timeoutMs?: number;
    maxPages?: number;
    prefixes?: string[];
    locale?: CoverageLocale;
  } = {}
): Promise<SiteCoverage> {
  const {
    fetchImpl = fetch as unknown as FetchLike,
    now = new Date(),
    concurrency = 6,
    timeoutMs = 8_000,
    maxPages = 1_500,
    prefixes = articlePrefixes(),
    locale = DEFAULT_COVERAGE_LOCALE,
  } = options;
  const inventory = await fetchSiteInventory(siteUrl, fetchImpl as never, now);
  if (inventory.paths.length === 0) {
    return { origin: inventory.origin, pages: [], siteGeneric: [], fetchedAt: now.toISOString(), error: inventory.error || "no pages" };
  }
  const paths = inventory.paths.filter((path) => isHubPath(path, prefixes)).slice(0, maxPages);
  let failures = 0;
  const pages = (
    await mapLimit(paths, concurrency, async (path): Promise<CoveragePage | null> => {
      const url = new URL(path, inventory.origin).toString();
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "user-agent": BROWSER_UA,
            accept: "text/html",
            "accept-language": `${locale.language}-${locale.country},${locale.language};q=0.9`,
          },
        });
        if (!response.ok) {
          failures++;
          return null;
        }
        const { title, h1 } = titleAndH1(await response.text());
        if (!title && !h1) return null;
        return { url, path, title, h1 };
      } catch {
        failures++;
        return null;
      }
    })
  ).filter((page): page is CoveragePage => page !== null);

  const heads = pages.flatMap((page) => [headingHead(page.title), headingHead(page.h1)].filter(Boolean));
  const siteGeneric = [...frequentTokens(heads, 0.2, 20)];
  return {
    origin: inventory.origin,
    pages,
    siteGeneric,
    fetchedAt: now.toISOString(),
    error: pages.length === 0 ? `no page could be read (${failures} failed)` : "",
  };
}

// ---------- 12-hour process cache ----------

const TTL_MS = 12 * 60 * 60 * 1000;
/** A failed load is retried sooner: an outage must not disable the guard for half a day. */
const ERROR_TTL_MS = 30 * 60 * 1000;
let cached: { key: string; at: number; value: SiteCoverage } | null = null;
let inflight: { key: string; promise: Promise<SiteCoverage> } | null = null;

export async function siteCoverage(
  siteUrl: string | null | undefined = process.env.SITE_URL,
  options: Parameters<typeof fetchSiteCoverage>[1] = {}
): Promise<SiteCoverage> {
  const now = options.now ?? new Date();
  const site = (siteUrl ?? "").replace(/\/+$/, "");
  if (!site) return { origin: "", pages: [], siteGeneric: [], fetchedAt: now.toISOString(), error: "SITE_URL is not set" };
  const locale = options.locale ?? DEFAULT_COVERAGE_LOCALE;
  const key = `${site}|${locale.language}-${locale.country}`;
  if (cached && cached.key === key) {
    const age = now.getTime() - cached.at;
    if (age < (cached.value.error ? ERROR_TTL_MS : TTL_MS)) return cached.value;
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = fetchSiteCoverage(site, { ...options, now })
    .then((value) => {
      cached = { key, at: now.getTime(), value };
      if (value.error) logger.warn({ siteUrl: site, error: value.error }, "[SiteCoverage] Site pages unavailable — no idea is blocked");
      else logger.info({ siteUrl: site, pages: value.pages.length }, "[SiteCoverage] Site pages loaded");
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = { key, promise };
  return promise;
}

/** Test hook. */
export function resetSiteCoverageCache(): void {
  cached = null;
  inflight = null;
}

// ---------- matching ----------

interface PreparedPage {
  page: CoveragePage;
  heads: Array<{ text: string; terms: Term[]; leads: Term[] }>;
  full: Term[];
}

export interface CoverageIndex {
  pages: PreparedPage[];
  generic: Set<string>;
  /** Conjunctions this language writes joined to the next word. */
  joinedConjunctions: string[];
}

/**
 * How this language writes "and" and "or", from the runtime's locale data, so
 * no language needs a word list here. A conjunction with a space after it stands
 * alone; one without is joined to the word that follows.
 */
function conjunctions(language: string): { separate: string[]; joined: string[] } {
  const separate: string[] = [];
  const joined: string[] = [];
  for (const type of ["conjunction", "disjunction"] as const) {
    let parts: { type: string; value: string }[] = [];
    try {
      parts = new Intl.ListFormat(language, { type }).formatToParts(["x", "y"]);
    } catch {
      continue; // An unusable tag leaves only punctuation to coordinate.
    }
    for (const part of parts) {
      const word = part.value.trim();
      if (part.type !== "literal" || !/\p{L}/u.test(word)) continue;
      (/\s$/.test(part.value) ? separate : joined).push(word);
    }
  }
  return { separate, joined };
}

const LIST_PUNCTUATION = /[,&+/\u060C\u3001\u30FB]/u;

/** The first content term of each coordinated part of a heading. */
function leadTerms(text: string, separate: string[], options: Parameters<typeof contentTerms>[1]): Term[] {
  const spaced = separate.length > 0 ? text.split(new RegExp(`\\s(?:${separate.join("|")})\\s`, "iu")) : [text];
  return spaced
    .flatMap((part) => part.split(LIST_PUNCTUATION))
    .flatMap((part) => contentTerms(part, options).slice(0, 1));
}

export function buildCoverageIndex(
  coverage: Pick<SiteCoverage, "pages" | "siteGeneric">,
  extraGeneric: string[] = [],
  locale: CoverageLocale = DEFAULT_COVERAGE_LOCALE
): CoverageIndex {
  const { separate, joined } = conjunctions(locale.language);
  const generic = buildGenericSet([...coverage.siteGeneric, ...extraGeneric, ...separate]);
  const options = { concepts: COVERAGE_CONCEPTS, generic };
  const pages = coverage.pages
    .filter((page) => isHubPath(page.path))
    .map((page) => {
      const heads = [...new Set([headingHead(page.title), headingHead(page.h1)].filter(Boolean))].map((text) => ({
        text,
        terms: contentTerms(text, options),
        leads: leadTerms(text, separate, options),
      }));
      const full = contentTerms(`${stripSiteName(page.title)} ${page.h1}`, options);
      return { page, heads, full };
    });
  return { pages, generic, joinedConjunctions: joined };
}

/**
 * Extra heading terms after the lead one must be coordinated ("metro and
 * taxis"), not modifiers ("sports betting" is betting, not sport): each opens
 * its own part of the heading, or carries a joined conjunction.
 */
function onlyCoordinated(rest: Term[], leads: Term[], joined: string[]): boolean {
  return rest.every(
    (term) =>
      term.concept ||
      hasTerm(leads, term) ||
      joined.some((word) => term.raw.startsWith(word) && term.raw.length >= word.length + 3)
  );
}

function ruleFor(
  keyword: Term[],
  page: PreparedPage,
  joined: string[]
): { rule: CoverageMatch["rule"]; matchedOn: string } | null {
  for (const head of page.heads) {
    if (head.terms.length === 0) continue;
    const inHead = keyword.every((term) => hasTerm(head.terms, term));
    if (keyword.length === 1 && inHead && hasTerm(keyword, head.terms[0]) && onlyCoordinated(head.terms.slice(1), head.leads, joined)) {
      return { rule: "R1", matchedOn: head.text };
    }
    if (keyword.length >= 2 && inHead) return { rule: "R2", matchedOn: head.text };
  }
  if (keyword.length >= 2 && keyword.every((term) => hasTerm(page.full, term))) {
    // Only a hub-shaped heading (one or two terms) may own a topic this way;
    // a detail page ("Pools and beach at the Grand Hotel ...") mentions far too much.
    const head = page.heads.find(
      (candidate) => candidate.terms.length <= 2 && keyword.some((term) => hasTerm(candidate.terms, term))
    );
    if (head) return { rule: "R3", matchedOn: `${page.page.title} / ${page.page.h1}` };
  }
  return null;
}

/**
 * The page that already owns `keyword`, or null. Among several, the most
 * focused one wins: rule R1/R2 before R3, then the shortest heading, then the
 * shallowest path.
 */
export function findCoveringPage(keyword: string, index: CoverageIndex): CoverageMatch | null {
  const terms = contentTerms(keyword, { concepts: COVERAGE_CONCEPTS, generic: index.generic });
  // Nothing specific left (e.g. the city and a generic word), or a long tail too specific
  // for a hub to own: never block.
  if (terms.length === 0 || terms.length > 4) return null;

  const hits: Array<CoverageMatch & { weight: number }> = [];
  for (const page of index.pages) {
    const hit = ruleFor(terms, page, index.joinedConjunctions);
    if (!hit) continue;
    const headSize = Math.min(...page.heads.map((head) => head.terms.length || 99));
    const depth = page.page.path.split("/").filter(Boolean).length;
    hits.push({
      url: page.page.url,
      path: page.page.path,
      ...hit,
      weight: (hit.rule === "R3" ? 1000 : 0) + headSize * 10 + depth,
    });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.weight - b.weight);
  const { weight: _weight, ...best } = hits[0];
  return best;
}

/** Convenience for the scheduler: never throws, null when the site is unknown. */
export async function coverageIndexForSite(
  siteUrl: string | null | undefined = process.env.SITE_URL,
  locale: CoverageLocale = DEFAULT_COVERAGE_LOCALE
): Promise<CoverageIndex | null> {
  try {
    const coverage = await siteCoverage(siteUrl, { locale });
    if (coverage.pages.length === 0) return null;
    return buildCoverageIndex(coverage, [], locale);
  } catch (error) {
    logger.warn({ error }, "[SiteCoverage] Coverage check unavailable — no idea is blocked");
    return null;
  }
}
