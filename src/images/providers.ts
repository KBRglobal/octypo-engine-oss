/**
 * Stock photo search across Pexels and Pixabay.
 *
 * Pexels is tried first: on live comparison for the first customer's topic it
 * returned genuinely relevant street/billboard photography where Pixabay
 * returned a truck in snow. It also supplies a written description per photo,
 * where Pixabay supplies only tags — and a description is what makes automated
 * relevance judgement possible at all.
 *
 * Licence obligations honoured here (see the licensing research):
 * - Pixabay REQUIRES the file be downloaded to our own server; permanent
 *   hotlinking of their URLs is explicitly not allowed. We therefore return a
 *   download URL, never a URL to embed.
 * - Neither provider requires photographer attribution, but we carry the
 *   credit fields through so a caller can display them if a customer wants to.
 */

import type { Candidate } from "./relevance.js";

export interface SearchOptions {
  perPage?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_PER_PAGE = 15;
const DEFAULT_TIMEOUT_MS = 12_000;

async function getJson(
  url: string,
  headers: Record<string, string>,
  { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }: SearchOptions
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Detached call: invoking fetch as a method of another object throws
    // "Illegal invocation" on some runtimes.
    const doFetch = fetchImpl;
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // A provider being down must degrade to the next one, never throw into the
    // publishing pipeline.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPexels(
  query: string,
  apiKey: string,
  opts: SearchOptions = {}
): Promise<Candidate[]> {
  if (!apiKey) return [];
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const url =
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
    `&per_page=${perPage}&orientation=landscape`;

  const body = (await getJson(url, { Authorization: apiKey }, opts)) as
    | { photos?: unknown[] }
    | null;
  if (!body?.photos) return [];

  return body.photos.flatMap((raw): Candidate[] => {
    const p = raw as Record<string, any>;
    const src = p.src as Record<string, string> | undefined;
    const download = src?.original ?? src?.large2x ?? src?.large;
    if (!download || typeof p.id === "undefined") return [];
    return [{
      id: String(p.id),
      url: download,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0,
      // `alt` is a real sentence describing the photo — the signal Pixabay lacks.
      description: String(p.alt ?? ""),
      provider: "pexels",
      photographer: p.photographer ?? null,
      sourcePage: p.url ?? null,
    }];
  });
}

export async function searchPixabay(
  query: string,
  apiKey: string,
  opts: SearchOptions = {}
): Promise<Candidate[]> {
  if (!apiKey) return [];
  const perPage = opts.perPage ?? DEFAULT_PER_PAGE;
  const url =
    `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}` +
    `&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal` +
    `&safesearch=true&per_page=${perPage}`;

  const body = (await getJson(url, {}, opts)) as { hits?: unknown[] } | null;
  if (!body?.hits) return [];

  return body.hits.flatMap((raw): Candidate[] => {
    const h = raw as Record<string, any>;
    // largeImageURL is the highest resolution available without approved
    // full-API access; webformatURL is only 640px and unusable as a header.
    const download = h.largeImageURL ?? h.fullHDURL;
    if (!download || typeof h.id === "undefined") return [];
    return [{
      id: String(h.id),
      url: download,
      width: Number(h.imageWidth) || 0,
      height: Number(h.imageHeight) || 0,
      // Comma-separated tags, the only description Pixabay offers.
      description: String(h.tags ?? "").replace(/,/g, " "),
      provider: "pixabay",
      photographer: h.user ?? null,
      sourcePage: h.pageURL ?? null,
    }];
  });
}

export interface StockKeys {
  pexels?: string;
  pixabay?: string;
}

/**
 * Searches providers in order and returns everything found. Ordering matters:
 * the caller ranks by relevance, and a tie is resolved by the order candidates
 * arrive — so the better-described provider should come first.
 */
export async function searchAllProviders(
  query: string,
  keys: StockKeys,
  opts: SearchOptions = {}
): Promise<Candidate[]> {
  const results: Candidate[] = [];
  if (keys.pexels) results.push(...(await searchPexels(query, keys.pexels, opts)));
  if (keys.pixabay) results.push(...(await searchPixabay(query, keys.pixabay, opts)));
  return results;
}
