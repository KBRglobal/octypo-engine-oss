/**
 * Real search demand, from a keyword-data provider.
 *
 * Live search results (see `brave.ts`) show who ranks for a phrase. They cannot
 * show how many people search it — that number only exists inside Google's own
 * keyword data, and every "estimate" derived from results alone is invented.
 * Inventing it would be worse than not having it, because a fabricated volume
 * silently drives which articles get written.
 *
 * So volume is a *provider*, and its absence is a first-class state: without one
 * the engine still builds a topic bank and an idea bank, just ranked on the
 * evidence it does have. Nothing here ever fills in a number it did not receive.
 */

import { logger } from "../lib/logger.js";

const DFS_BASE = "https://api.dataforseo.com/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
/** DataForSEO takes at most 1000 keywords per task; more is a second task. */
export const MAX_KEYWORDS_PER_TASK = 1000;

export interface KeywordMetrics {
  keyword: string;
  /** Average monthly searches. Null when the provider had no data for it. */
  searchVolume: number | null;
  /** Advertiser competition 0–1, when the provider supplies it. */
  competition: number | null;
  /** Cost per click in the account currency, when supplied. */
  cpc: number | null;
}

export interface KeywordDataProvider {
  /** Metrics for the given phrases. Missing phrases are simply absent. */
  metricsFor(keywords: string[]): Promise<KeywordMetrics[]>;
  /** Related phrases the provider knows for a seed. Empty when unsupported. */
  ideasFor(seed: string, limit?: number): Promise<KeywordMetrics[]>;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Normalises what a provider returns, whatever shape it arrived in. */
export function toMetrics(raw: unknown): KeywordMetrics | null {
  if (!raw || typeof raw !== "object") return null;
  // `related_keywords` wraps the same object one level deeper again.
  const outer = raw as Record<string, unknown>;
  const record = (
    outer.keyword_data && typeof outer.keyword_data === "object" ? outer.keyword_data : outer
  ) as Record<string, unknown>;
  const keyword = typeof record.keyword === "string" ? record.keyword.trim().toLowerCase() : "";
  if (!keyword) return null;

  // Labs endpoints nest the same fields one level down.
  const info = (record.keyword_info ?? {}) as Record<string, unknown>;
  const pick = (name: string): unknown => record[name] ?? info[name];

  const volume = pick("search_volume");
  const competition = pick("competition");
  const cpc = pick("cpc");

  return {
    keyword,
    searchVolume: typeof volume === "number" ? volume : null,
    competition: typeof competition === "number" ? competition : null,
    cpc: typeof cpc === "number" ? cpc : null,
  };
}

export interface DataForSeoConfig {
  login: string;
  password: string;
  /** Google location, e.g. 2840 for the United States. */
  locationCode?: number;
  languageCode?: string;
  timeoutMs?: number;
}

export function dataForSeoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): DataForSeoConfig | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password) return null;
  return {
    login,
    password,
    locationCode: Number(env.DATAFORSEO_LOCATION_CODE) || undefined,
    languageCode: env.DATAFORSEO_LANGUAGE_CODE?.trim() || undefined,
  };
}

export interface ProviderOptions {
  fetchImpl?: typeof fetch;
}

export class DataForSeoProvider implements KeywordDataProvider {
  constructor(
    private readonly config: DataForSeoConfig,
    private readonly options: ProviderOptions = {}
  ) {}

  private authHeader(): string {
    const token = Buffer.from(`${this.config.login}:${this.config.password}`).toString("base64");
    return `Basic ${token}`;
  }

  private async post(path: string, body: unknown): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const res = await doFetch(`${DFS_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ path, status: res.status }, "[KeywordData] Provider returned an error");
        return [];
      }
      return extractResults(await res.json());
    } catch (error) {
      // Research informs a decision, it is not the decision. A provider outage
      // degrades the ranking; it must not stop an install or a publish.
      logger.warn({ path, error }, "[KeywordData] Provider request failed");
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async metricsFor(keywords: string[]): Promise<KeywordMetrics[]> {
    const cleaned = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];
    if (cleaned.length === 0) return [];

    const batches = chunk(cleaned, MAX_KEYWORDS_PER_TASK);
    const results = await Promise.all(
      batches.map((batch) =>
        this.post("/keywords_data/google_ads/search_volume/live", [
          {
            keywords: batch,
            location_code: this.config.locationCode,
            language_code: this.config.languageCode,
          },
        ])
      )
    );

    return results.flat().map(toMetrics).filter((m): m is KeywordMetrics => m !== null);
  }

  /**
   * Phrases worth writing about, from two endpoints that answer different
   * questions.
   *
   * `keyword_suggestions` returns phrases that *contain* the seed — the tight
   * long tail, and the most relevant thing the provider has. `related_keywords`
   * returns what the same searchers also look for, which is where a cluster
   * gains breadth. Suggestions come first, because relevance beats reach when a
   * plan is capped.
   *
   * `keyword_ideas` is deliberately not used: it expands on the individual
   * words, so "led truck advertising" comes back with "led meaning" and "led
   * drawing board" — measured, not assumed.
   */
  async ideasFor(seed: string, limit = 200): Promise<KeywordMetrics[]> {
    const params = {
      keyword: seed,
      limit,
      location_code: this.config.locationCode,
      language_code: this.config.languageCode,
    };

    const [suggestions, related] = await Promise.all([
      this.post("/dataforseo_labs/google/keyword_suggestions/live", [params]),
      this.post("/dataforseo_labs/google/related_keywords/live", [{ ...params, depth: 2 }]),
    ]);

    const seen = new Set<string>();
    const merged: KeywordMetrics[] = [];
    for (const row of [...suggestions, ...related]) {
      const metrics = toMetrics(row);
      if (!metrics || seen.has(metrics.keyword)) continue;
      seen.add(metrics.keyword);
      merged.push(metrics);
    }
    return merged.slice(0, limit);
  }
}

/**
 * DataForSEO wraps everything twice: `tasks[].result[]`, and Labs endpoints put
 * the rows one level deeper again under `result[].items[]`.
 */
export function extractResults(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const tasks = (payload as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];

  const rows: unknown[] = [];
  for (const task of tasks) {
    const result = (task as { result?: unknown }).result;
    if (!Array.isArray(result)) continue;
    for (const entry of result) {
      const items = (entry as { items?: unknown })?.items;
      if (Array.isArray(items)) rows.push(...items);
      else rows.push(entry);
    }
  }
  return rows;
}

/** Null when no provider is configured — the caller ranks without volume. */
export function keywordDataProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ProviderOptions = {}
): KeywordDataProvider | null {
  const config = dataForSeoConfigFromEnv(env);
  if (!config) return null;
  return new DataForSeoProvider(config, options);
}
