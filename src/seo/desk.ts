/**
 * The SEO desk: our own research bench, not a customer feature.
 *
 * Octypo runs one deployment per customer from one codebase, so anything added
 * here appears in every install unless something stops it. Entitlements cannot
 * be that something: an install with `OCTYPO_ENTITLEMENTS` unset is granted
 * everything on purpose, so that shipping a new capability never silently
 * removes a feature a customer already had. A capability added to that list
 * would therefore switch itself *on* across the fleet — the opposite of what a
 * desk billed to our own DataForSEO account needs.
 *
 * So the gate is its own flag, off unless someone set it, and it is checked in
 * exactly one place: `deskEnabled()`.
 */

import { logger } from "../lib/logger.js";
import { SeoApiError, seoClientFromEnv, type SeoClient } from "./client.js";
import { accountStatus, estimateUsd } from "./prices.js";
import { cacheKey, readCache, recordSpend, writeCache } from "./store.js";
import {
  SEO_TOOLS,
  SEO_TOOL_IDS,
  normaliseInput,
  type SeoToolId,
  type SeoToolInput,
} from "./tools.js";

export function deskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SEO_TOOLS_ENABLED?.trim().toLowerCase();
  if (flag !== "1" && flag !== "true" && flag !== "on") return false;
  return Boolean(env.DATAFORSEO_LOGIN?.trim() && env.DATAFORSEO_PASSWORD?.trim());
}

/**
 * Which country the desk opens on.
 *
 * `DATAFORSEO_LOCATION_CODE` is the *engine's* market — the country this
 * install's customer is written for — and the desk must not inherit it, or
 * borrow it either: researching a Tel Aviv competitor would silently open in
 * the customer's country and answer about the wrong one. The desk gets its own
 * pair, and only falls back to the engine's when they are unset.
 */
export function deskDefaultMarket(client: SeoClient): {
  locationCode: number | null;
  languageCode: string | null;
} {
  const configured = Number(process.env.SEO_DESK_LOCATION_CODE);
  const language = process.env.SEO_DESK_LANGUAGE_CODE?.trim();
  const fallback = client.defaults;
  return {
    locationCode: Number.isFinite(configured) && configured > 0 ? configured : fallback.locationCode ?? null,
    languageCode: language || fallback.languageCode || null,
  };
}

/** Throws rather than returns null: every route here is behind the same gate. */
export function requireClient(): SeoClient {
  if (!deskEnabled()) {
    throw new SeoApiError("The SEO desk is not enabled on this install.", 404);
  }
  const client = seoClientFromEnv();
  if (!client) throw new SeoApiError("DataForSEO is not configured on this install.", 404);
  return client;
}

export interface ToolDescription {
  id: SeoToolId;
  label: string;
  hint: string;
  needs: ("target" | "keyword" | "rival")[];
  defaultLimit: number;
  maxLimit: number;
  /** What one run costs at the default limit, or null when unpriced. */
  estimateUsd: number | null;
}

export interface DeskStatus {
  enabled: boolean;
  balanceUsd: number | null;
  locationCode: number | null;
  languageCode: string | null;
  tools: ToolDescription[];
  /** Set when the account itself could not be read — shown, not swallowed. */
  error?: string;
}

/**
 * What the desk can do and what it will cost, in one call.
 *
 * The rate card comes from the account rather than from a table in this repo,
 * so the price beside a button stays true when the plan changes. When the
 * account cannot be read, the tools are still listed with null prices: a desk
 * that will not open because the balance call failed is worse than one that
 * admits it does not know the price yet.
 */
export async function deskStatus(): Promise<DeskStatus> {
  if (!deskEnabled()) {
    return { enabled: false, balanceUsd: null, locationCode: null, languageCode: null, tools: [] };
  }

  const client = requireClient();
  const base = {
    enabled: true,
    ...deskDefaultMarket(client),
  };

  try {
    const account = await accountStatus(client);
    return {
      ...base,
      balanceUsd: account.balanceUsd,
      tools: SEO_TOOL_IDS.map((id) => describe(id, account.prices)),
    };
  } catch (error) {
    logger.warn({ error }, "[SEO] Could not read the DataForSEO account");
    return {
      ...base,
      balanceUsd: null,
      tools: SEO_TOOL_IDS.map((id) => describe(id, {})),
      error: error instanceof SeoApiError ? error.message : "Could not read the account.",
    };
  }
}

function describe(id: SeoToolId, prices: Record<string, unknown>): ToolDescription {
  const tool = SEO_TOOLS[id];
  return {
    id,
    label: tool.label,
    hint: tool.hint,
    needs: tool.needs,
    defaultLimit: tool.defaultLimit,
    maxLimit: tool.maxLimit,
    estimateUsd: quote(id, tool.defaultLimit, prices),
  };
}

/**
 * The sum of every call a run makes. Null when any one of them is unpriced —
 * a partial total read as a full one is how a button under-promises.
 */
export function quote(
  id: SeoToolId,
  limit: number,
  prices: Record<string, unknown>
): number | null {
  const tool = SEO_TOOLS[id];
  let total = 0;
  for (const call of tool.calls({ limit })) {
    const price = estimateUsd(prices, call.path, call.rows);
    if (price === null) return null;
    total += price;
  }
  return Number(total.toFixed(6));
}

export async function quoteTool(id: SeoToolId, limit: number): Promise<number | null> {
  try {
    const account = await accountStatus(requireClient());
    return quote(id, limit, account.prices);
  } catch {
    return null;
  }
}

export interface ToolRun {
  tool: SeoToolId;
  input: SeoToolInput & { limit: number };
  data: Record<string, unknown>;
  /** What this run cost. Zero when the answer came from the cache. */
  costUsd: number;
  cached: boolean;
  fetchedAt: string;
}

/**
 * Run a tool, or hand back the answer already paid for.
 *
 * `refresh` is the deliberate override — the button that says "buy it again",
 * for when the cached answer is the stale one that matters.
 */
export async function runTool(
  id: SeoToolId,
  rawInput: SeoToolInput,
  options: { refresh?: boolean } = {}
): Promise<ToolRun> {
  const tool = SEO_TOOLS[id];
  const client = requireClient();
  const input = normaliseInput(tool, rawInput);
  const key = cacheKey(id, input);

  if (!options.refresh) {
    const hit = await readCache(key, tool.ttlMs);
    if (hit) {
      return {
        tool: id,
        input,
        data: hit.payload,
        costUsd: 0,
        cached: true,
        fetchedAt: hit.fetchedAt.toISOString(),
      };
    }
  }

  const result = await tool.run(client, input);
  const { costUsd, ...data } = result;

  recordSpend(id, costUsd);
  await writeCache(id, key, input, data, costUsd);

  return {
    tool: id,
    input,
    data,
    costUsd,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };
}
