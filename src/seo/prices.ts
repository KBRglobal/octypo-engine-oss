/**
 * What a lookup will cost, before anyone clicks it.
 *
 * DataForSEO publishes the account's own rate card inside `appendix/user_data`,
 * next to the balance. That matters more than it sounds: the desk shows a price
 * beside every button, and a hardcoded table would quietly become a lie the day
 * the account's plan changes. Nothing here invents a number — an endpoint whose
 * price cannot be resolved reports null, and the button says so.
 *
 * The rate card and the balance come from the same free call, so they are
 * fetched together and held briefly.
 */

import { SeoApiError, type SeoClient } from "./client.js";

const CACHE_MS = 60_000;

export interface AccountStatus {
  balanceUsd: number;
  /** The account's rate card, keyed the way DataForSEO nests it. */
  prices: Record<string, unknown>;
}

export interface PriceEstimate {
  /** Charged once per call. */
  perRequestUsd: number;
  /** Charged per row returned. */
  perResultUsd: number;
}

let cached: { at: number; status: AccountStatus } | null = null;

export async function accountStatus(client: SeoClient, force = false): Promise<AccountStatus> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.status;

  const { head } = await client.get("/appendix/user_data");
  if (!head) throw new SeoApiError("DataForSEO returned no account data.", 502);

  const money = (head.money ?? {}) as Record<string, unknown>;
  const status: AccountStatus = {
    balanceUsd: typeof money.balance === "number" ? money.balance : 0,
    prices: (head.price ?? {}) as Record<string, unknown>,
  };
  cached = { at: Date.now(), status };
  return status;
}

/** Tests and a manual refresh; nothing else. */
export function resetAccountCache(): void {
  cached = null;
}

/**
 * Resolve an endpoint path against the rate card.
 *
 * The rate card is not keyed by the endpoint path. It drops the segments that
 * carry no price of their own, and which those are differs per family:
 * `/serp/google/organic/live/advanced` is priced at `serp.live.advanced`, while
 * `/keywords_data/google_ads/search_volume/live` keeps every segment. So the
 * walk descends where it can and steps over a segment the card does not have,
 * which reads both shapes without a per-endpoint table to maintain.
 */
export function findPrice(prices: Record<string, unknown>, path: string): PriceEstimate | null {
  const segments = path.split("/").filter(Boolean);
  let node: Record<string, unknown> = prices;

  for (const segment of segments) {
    const next = node[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    }
    // Absent: a segment the rate card does not price separately. Keep walking.
  }

  const tier = node.priority_normal;
  if (!Array.isArray(tier)) return null;

  let perRequestUsd = 0;
  let perResultUsd = 0;
  for (const entry of tier) {
    if (!entry || typeof entry !== "object") continue;
    const { cost_type: type, cost } = entry as { cost_type?: string; cost?: number };
    if (typeof cost !== "number") continue;
    if (type === "per_request") perRequestUsd = cost;
    if (type === "per_result") perResultUsd = cost;
  }

  return { perRequestUsd, perResultUsd };
}

/** The number the button shows: one call returning at most `rows` rows. */
export function estimateUsd(
  prices: Record<string, unknown>,
  path: string,
  rows = 1
): number | null {
  const price = findPrice(prices, path);
  if (!price) return null;
  return price.perRequestUsd + price.perResultUsd * Math.max(rows, 1);
}
