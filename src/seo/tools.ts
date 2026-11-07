/**
 * The desk's tools, declared once.
 *
 * Each tool says what it needs, which endpoints it will call and how many rows
 * it will ask for, and only then how to run. The price shown beside a button
 * and the call the button makes are therefore the same declaration — the one
 * way to keep an estimate honest as endpoints get added is to make it
 * impossible to add one without its price.
 */

import {
  mapRows,
  toAnchorRow,
  toBacklinkSummaryRow,
  toCompetitorRow,
  toDomainOverviewRow,
  toIntersectionRow,
  toKeywordRow,
  toRankedKeywordRow,
  toReferringDomainRow,
  toSerpRow,
} from "./rows.js";
import type { Market, SeoClient } from "./client.js";
import { SeoApiError } from "./client.js";

export const SEO_TOOL_IDS = [
  "domain-overview",
  "ranked-keywords",
  "keywords",
  "backlinks",
  "competitors",
  "keyword-gap",
  "serp",
] as const;

export type SeoToolId = (typeof SEO_TOOL_IDS)[number];

export interface SeoToolInput extends Market {
  /** A domain, for the tools that look at a site. */
  target?: string;
  /** A phrase, for the tools that look at a search. */
  keyword?: string;
  /** The other domain, for the gap. */
  rival?: string;
  limit?: number;
}

export interface SeoCall {
  path: string;
  /** Rows this call will ask for — the per-result half of the estimate. */
  rows: number;
}

export interface SeoToolDef {
  id: SeoToolId;
  label: string;
  hint: string;
  /** Which input fields must be filled before the button does anything. */
  needs: ("target" | "keyword" | "rival")[];
  defaultLimit: number;
  maxLimit: number;
  /** Cached answers older than this are bought again. */
  ttlMs: number;
  calls(input: Required<Pick<SeoToolInput, "limit">> & SeoToolInput): SeoCall[];
  run(client: SeoClient, input: SeoToolInput & { limit: number }): Promise<SeoToolData>;
}

export type SeoToolData = Record<string, unknown> & { costUsd: number };

const DAY = 86_400_000;

/**
 * A bare host. People paste whatever is in the address bar, and DataForSEO
 * answers a domain that carries a scheme or a path with an empty result rather
 * than an error — the most expensive kind of nothing.
 */
export function cleanDomain(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split("/")[0].split("?")[0].split("#")[0];
  return host.replace(/^www\./, "").replace(/:\d+$/, "");
}

function requireInput(input: SeoToolInput, needs: SeoToolDef["needs"]): void {
  for (const field of needs) {
    if (!input[field]?.trim()) {
      throw new SeoApiError(`This lookup needs a ${field === "keyword" ? "keyword" : "domain"}.`, 400);
    }
  }
}

const LABS = "/dataforseo_labs/google";

export const SEO_TOOLS: Record<SeoToolId, SeoToolDef> = {
  "domain-overview": {
    id: "domain-overview",
    label: "Domain overview",
    hint: "Organic footprint and link profile in one view.",
    needs: ["target"],
    defaultLimit: 1,
    maxLimit: 1,
    ttlMs: 7 * DAY,
    calls: () => [
      { path: `${LABS}/domain_rank_overview/live`, rows: 1 },
      { path: "/backlinks/summary/live", rows: 1 },
    ],
    async run(client, input) {
      const target = cleanDomain(input.target ?? "");
      const [overview, links] = await Promise.all([
        client.post(`${LABS}/domain_rank_overview/live`, { target }, input),
        // The link half is global; only the organic half has a market.
        client.post("/backlinks/summary/live", { target, internal_list_limit: 1 }),
      ]);
      return {
        target,
        organic: toDomainOverviewRow(overview.rows.length ? overview.rows : overview.results),
        links: toBacklinkSummaryRow(links.head),
        costUsd: overview.costUsd + links.costUsd,
      };
    },
  },

  "ranked-keywords": {
    id: "ranked-keywords",
    label: "Ranked keywords",
    hint: "Every phrase this domain already ranks for.",
    needs: ["target"],
    defaultLimit: 100,
    maxLimit: 1000,
    ttlMs: 3 * DAY,
    calls: (input) => [{ path: `${LABS}/ranked_keywords/live`, rows: input.limit }],
    async run(client, input) {
      const target = cleanDomain(input.target ?? "");
      const response = await client.post(`${LABS}/ranked_keywords/live`, {
        target,
        limit: input.limit,
        order_by: ["ranked_serp_element.serp_item.etv,desc"],
      }, input);
      return {
        target,
        total: (response.head?.total_count as number) ?? null,
        keywords: mapRows(response.rows, toRankedKeywordRow),
        costUsd: response.costUsd,
      };
    },
  },

  keywords: {
    id: "keywords",
    label: "Keyword research",
    hint: "Volume, difficulty and the long tail around a phrase.",
    needs: ["keyword"],
    defaultLimit: 100,
    maxLimit: 1000,
    ttlMs: 7 * DAY,
    calls: (input) => [
      { path: `${LABS}/keyword_overview/live`, rows: 1 },
      { path: `${LABS}/keyword_suggestions/live`, rows: input.limit },
      { path: `${LABS}/related_keywords/live`, rows: input.limit },
    ],
    /**
     * Two expansions, because they answer different questions: suggestions are
     * the phrases that contain the seed (the tight long tail), related is what
     * the same searchers also look for (where a topic gains breadth).
     * `keyword_ideas` is left out on purpose — it expands the individual words,
     * so a seed like "led truck advertising" comes back with "led drawing board".
     */
    async run(client, input) {
      const keyword = (input.keyword ?? "").trim().toLowerCase();
      const [seed, suggestions, related] = await Promise.all([
        client.post(`${LABS}/keyword_overview/live`, { keywords: [keyword] }, input),
        client.post(`${LABS}/keyword_suggestions/live`, { keyword, limit: input.limit }, input),
        client.post(`${LABS}/related_keywords/live`, { keyword, limit: input.limit, depth: 2 }, input),
      ]);

      const seen = new Set<string>();
      const ideas = [];
      for (const row of [...suggestions.rows, ...related.rows]) {
        const shaped = toKeywordRow(row);
        if (!shaped || seen.has(shaped.keyword)) continue;
        seen.add(shaped.keyword);
        ideas.push(shaped);
      }
      ideas.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));

      return {
        keyword,
        seed: toKeywordRow(seed.rows[0] ?? seed.head),
        ideas,
        costUsd: seed.costUsd + suggestions.costUsd + related.costUsd,
      };
    },
  },

  backlinks: {
    id: "backlinks",
    label: "Backlinks",
    hint: "Who links to this domain, in what words, and what was lost.",
    needs: ["target"],
    defaultLimit: 100,
    maxLimit: 1000,
    ttlMs: 3 * DAY,
    calls: (input) => [
      { path: "/backlinks/summary/live", rows: 1 },
      { path: "/backlinks/referring_domains/live", rows: input.limit },
      { path: "/backlinks/anchors/live", rows: Math.min(input.limit, 100) },
    ],
    async run(client, input) {
      const target = cleanDomain(input.target ?? "");
      // No market on these three: the backlink index is global, so there is no
      // country to narrow to and passing one would only look like there is.
      const [summary, domains, anchors] = await Promise.all([
        client.post("/backlinks/summary/live", { target, internal_list_limit: 1 }),
        client.post("/backlinks/referring_domains/live", {
          target,
          limit: input.limit,
          order_by: ["rank,desc"],
        }),
        client.post("/backlinks/anchors/live", {
          target,
          limit: Math.min(input.limit, 100),
          order_by: ["backlinks,desc"],
        }),
      ]);
      return {
        target,
        summary: toBacklinkSummaryRow(summary.head),
        referringDomains: mapRows(domains.rows, toReferringDomainRow),
        anchors: mapRows(anchors.rows, toAnchorRow),
        costUsd: summary.costUsd + domains.costUsd + anchors.costUsd,
      };
    },
  },

  competitors: {
    id: "competitors",
    label: "Competitors",
    hint: "The domains fighting for the same searches.",
    needs: ["target"],
    defaultLimit: 50,
    maxLimit: 500,
    ttlMs: 7 * DAY,
    calls: (input) => [{ path: `${LABS}/competitors_domain/live`, rows: input.limit }],
    async run(client, input) {
      const target = cleanDomain(input.target ?? "");
      const response = await client.post(`${LABS}/competitors_domain/live`, {
        target,
        limit: input.limit,
        order_by: ["intersections,desc"],
      }, input);
      return {
        target,
        competitors: mapRows(response.rows, toCompetitorRow).filter((row) => row.domain !== target),
        costUsd: response.costUsd,
      };
    },
  },

  "keyword-gap": {
    id: "keyword-gap",
    label: "Keyword gap",
    hint: "What a rival ranks for and you do not.",
    needs: ["target", "rival"],
    defaultLimit: 100,
    maxLimit: 1000,
    ttlMs: 3 * DAY,
    calls: (input) => [{ path: `${LABS}/domain_intersection/live`, rows: input.limit }],
    /**
     * Two inversions, both measured against the live endpoint rather than
     * assumed, and both silently wrong in a plausible way if got backwards:
     *
     * - `intersections: false` asks for the phrases where only one of the two
     *   domains ranks. Left on, the endpoint returns the overlap instead.
     * - the rival goes in as `target1`. The endpoint returns rows where the
     *   *first* domain ranks and the second does not, so sending our own
     *   domain first answers the opposite question: what we have and they lack.
     */
    async run(client, input) {
      const target = cleanDomain(input.target ?? "");
      const rival = cleanDomain(input.rival ?? "");
      const response = await client.post(`${LABS}/domain_intersection/live`, {
        target1: rival,
        target2: target,
        intersections: false,
        limit: input.limit,
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
      }, input);
      const rows = mapRows(response.rows, toIntersectionRow);
      return {
        target,
        rival,
        total: (response.head?.total_count as number) ?? null,
        missing: rows
          .filter((row) => row.secondPosition === null && row.firstPosition !== null)
          .map(({ firstPosition, firstUrl, secondPosition, secondUrl: _unused, ...keyword }) => ({
            ...keyword,
            theirPosition: firstPosition,
            theirUrl: firstUrl,
            myPosition: secondPosition,
          })),
        costUsd: response.costUsd,
      };
    },
  },

  serp: {
    id: "serp",
    label: "Live results",
    hint: "Who Google is showing for this phrase right now.",
    needs: ["keyword"],
    defaultLimit: 20,
    maxLimit: 100,
    ttlMs: 6 * 3_600_000,
    calls: () => [{ path: "/serp/google/organic/live/advanced", rows: 1 }],
    async run(client, input) {
      const keyword = (input.keyword ?? "").trim();
      const response = await client.post("/serp/google/organic/live/advanced", {
        keyword,
        depth: input.limit,
      }, input);
      return {
        keyword,
        results: mapRows(response.rows, toSerpRow),
        costUsd: response.costUsd,
      };
    },
  },
};

/**
 * The exact question, and nothing else.
 *
 * Only the fields this tool needs survive. The page keeps all three boxes
 * filled as someone moves between tools, so a domain lookup would otherwise
 * carry along whatever keyword was last typed — harmless in the request, but
 * part of the cache key, which would make the same question look like a new
 * one and charge for it again.
 */
export function normaliseInput(tool: SeoToolDef, input: SeoToolInput): SeoToolInput & { limit: number } {
  requireInput(input, tool.needs);
  const asked = Number(input.limit);
  const limit =
    Number.isFinite(asked) && asked > 0
      ? Math.min(Math.trunc(asked), tool.maxLimit)
      : tool.defaultLimit;

  const kept: SeoToolInput & { limit: number } = { limit };
  for (const field of tool.needs) {
    const value = input[field]?.trim();
    if (value) kept[field] = field === "keyword" ? value : cleanDomain(value);
  }
  if (input.locationCode) kept.locationCode = Number(input.locationCode);
  if (input.languageCode?.trim()) kept.languageCode = input.languageCode.trim();
  return kept;
}

export function isSeoToolId(value: unknown): value is SeoToolId {
  return typeof value === "string" && (SEO_TOOL_IDS as readonly string[]).includes(value);
}
