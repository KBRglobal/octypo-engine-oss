/**
 * The countries a question can be asked about.
 *
 * This matters more than it looks. DataForSEO defaults to the United States,
 * and a domain with no US presence answers with an empty result rather than an
 * error — so a foreign site researched in the default market reads as "nothing
 * known about this domain", which is a wrong answer that looks like a true one.
 *
 * The list is the provider's own, not a table here: only it knows which
 * languages are actually available for a country (many sell only
 * their own, with no English). It is a free call, and held for an hour.
 */

import { SeoApiError, type SeoClient } from "./client.js";

const CACHE_MS = 3_600_000;

export interface MarketLanguage {
  code: string;
  name: string;
}

export interface MarketOption {
  code: number;
  name: string;
  languages: MarketLanguage[];
}

let cached: { at: number; markets: MarketOption[] } | null = null;

export async function markets(client: SeoClient, force = false): Promise<MarketOption[]> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.markets;

  const { results } = await client.get("/dataforseo_labs/locations_and_languages");
  const options: MarketOption[] = [];

  for (const row of results) {
    if (row.location_type !== "Country") continue;
    const code = typeof row.location_code === "number" ? row.location_code : null;
    const name = typeof row.location_name === "string" ? row.location_name : null;
    if (code === null || !name) continue;

    const languages: MarketLanguage[] = [];
    for (const language of Array.isArray(row.available_languages) ? row.available_languages : []) {
      const entry = language as { language_code?: unknown; language_name?: unknown };
      if (typeof entry.language_code === "string" && typeof entry.language_name === "string") {
        languages.push({ code: entry.language_code, name: entry.language_name });
      }
    }
    options.push({ code, name, languages });
  }

  if (options.length === 0) {
    throw new SeoApiError("DataForSEO returned no countries.", 502);
  }

  // Alphabetical, and nothing promoted: which countries matter is the
  // operator's business, not a preference compiled into the engine.
  options.sort((a, b) => a.name.localeCompare(b.name));
  cached = { at: Date.now(), markets: options };
  return options;
}

export function resetMarketsCache(): void {
  cached = null;
}
