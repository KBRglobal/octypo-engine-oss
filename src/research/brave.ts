/**
 * Live search results, via the Brave Search API.
 *
 * Everything the engine previously "knew" about search demand was a guess: Gate
 * 1 asked a model to rate `searchVolumePotential` as low/medium/high, which is
 * the model describing its own intuition, not the market. Real results are the
 * cheapest correction available — what actually ranks for a phrase tells you
 * whether the phrase is contested, who owns it, and which adjacent phrases
 * people are actually served.
 *
 * This is deliberately not a keyword-volume provider. Brave returns results,
 * not search volume; anything here that claims to know a monthly number would
 * be inventing it. Volume needs a paid data provider and is a separate decision.
 */

import { logger } from "../lib/logger.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_COUNT = 20;

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  /** Registrable-ish host, for judging who owns a phrase. */
  host: string;
}

export interface SearchOptions {
  count?: number;
  country?: string;
  lang?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SearchClient {
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Brave wraps matched terms in <strong>; the text is what we want, not the markup. */
export function stripHighlight(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

interface BraveWebResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

export function parseResults(payload: unknown): SearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const web = (payload as { web?: { results?: unknown } }).web;
  if (!web || !Array.isArray(web.results)) return [];

  const out: SearchResult[] = [];
  for (const raw of web.results as BraveWebResult[]) {
    const url = typeof raw?.url === "string" ? raw.url : "";
    const title = typeof raw?.title === "string" ? stripHighlight(raw.title) : "";
    if (!url || !title) continue;
    out.push({
      title,
      url,
      description: typeof raw?.description === "string" ? stripHighlight(raw.description) : "",
      host: hostOf(url),
    });
  }
  return out;
}

export class BraveSearchClient implements SearchClient {
  constructor(private readonly apiKey: string) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      count = DEFAULT_COUNT,
      country,
      lang,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      fetchImpl = fetch,
    } = options;

    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(Math.max(count, 1), 20)));
    if (country) url.searchParams.set("country", country);
    if (lang) url.searchParams.set("search_lang", lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Detached call: invoking fetch as a method of another object throws
      // "Illegal invocation" on some runtimes.
      const doFetch = fetchImpl;
      const res = await doFetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ query, status: res.status }, "[Search] Brave returned an error");
        return [];
      }
      return parseResults(await res.json());
    } catch (error) {
      // Research is an input to a decision, never the decision itself. A search
      // outage must degrade the suggestion, not stop the pipeline.
      logger.warn({ query, error }, "[Search] Brave request failed");
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Null when no key is configured — the caller falls back to its own heuristics. */
export function searchClientFromEnv(env: NodeJS.ProcessEnv = process.env): SearchClient | null {
  const key = env.BRAVE_API_KEY?.trim();
  if (!key) return null;
  return new BraveSearchClient(key);
}
