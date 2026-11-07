/**
 * Who Google actually shows for this business's money terms.
 *
 * The competitor endpoint answers "who else ranks for the phrases you already
 * rank for", which is circular for a prospect that ranks for almost nothing —
 * it returned Facebook and Wikipedia for a five-keyword site. This asks the
 * opposite and far more useful question: take the phrases their customers
 * actually search, look at page one, and write down who is standing there.
 *
 * It works for a domain with no visibility at all, which is exactly the
 * prospect worth calling. And it is cheap: one live SERP is $0.002, so the
 * whole section costs about two cents.
 */

import { logger } from "../../lib/logger.js";
import type { Market, SeoClient } from "../client.js";
import { mapRows, toSerpRow } from "../rows.js";
import { cleanDomain } from "../tools.js";

export interface SerpKeyword {
  keyword: string;
  volume: number | null;
  /** Where the prospect appears in the top ten, or null when absent. */
  prospectPosition: number | null;
  /** The domains holding the first few places, in order. */
  topDomains: string[];
}

export interface SerpOwner {
  domain: string;
  /** How many of the measured phrases this domain appears on page one for. */
  appearances: number;
  bestPosition: number;
  /** The phrases it holds, so the claim can be checked. */
  keywords: string[];
}

export interface SerpOwnersSection {
  keywords: SerpKeyword[];
  owners: SerpOwner[];
  /** How many of the measured phrases the prospect appears on page one for. */
  prospectAppearances: number;
  costUsd: number;
  /** Named when the section is thin, so the operator knows before the client. */
  notes: string[];
}

/** One page of Google per phrase is enough to say who owns the category. */
const DEPTH = 10;

export interface SerpOwnersInput {
  domain: string;
  /** The phrases to look at, highest demand first. */
  keywords: { keyword: string; volume: number | null }[];
  /** How many phrases to buy a SERP for. */
  limit?: number;
  market?: Market;
}

export async function buildSerpOwnersSection(
  client: SeoClient,
  input: SerpOwnersInput
): Promise<SerpOwnersSection> {
  const prospect = cleanDomain(input.domain);
  const notes: string[] = [];

  // Highest demand first: the phrases worth arguing about are the ones people
  // actually type, not the long tail where anyone can rank.
  const chosen = [...input.keywords]
    .filter((row) => row.keyword.trim())
    .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1))
    .slice(0, Math.max(1, Math.min(input.limit ?? 8, 15)));

  if (chosen.length === 0) {
    return { keywords: [], owners: [], prospectAppearances: 0, costUsd: 0, notes: ["no-keywords"] };
  }

  const results = await Promise.all(
    chosen.map(async (row) => {
      try {
        const response = await client.post(
          "/serp/google/organic/live/advanced",
          { keyword: row.keyword, depth: DEPTH },
          input.market ?? {}
        );
        return { row, response, error: false as const };
      } catch (error) {
        logger.warn({ error, keyword: row.keyword }, "[SEO] SERP lookup failed for a phrase");
        return { row, response: null, error: true as const };
      }
    })
  );

  const keywords: SerpKeyword[] = [];
  const ownerIndex = new Map<string, SerpOwner>();
  let costUsd = 0;
  let failures = 0;

  for (const { row, response, error } of results) {
    if (error || !response) {
      failures += 1;
      continue;
    }
    costUsd += response.costUsd;

    const organic = mapRows(response.rows, toSerpRow);
    // The prospect can appear as a bare domain or with a host prefix, and
    // matching the raw string would miss "www." — which reads as "you are
    // nowhere" about a business that is in fact on page one.
    const prospectHit = organic.find(
      (item) => item.domain !== null && cleanDomain(item.domain) === prospect
    );

    keywords.push({
      keyword: row.keyword,
      volume: row.volume,
      prospectPosition: prospectHit?.position ?? null,
      topDomains: organic
        .slice(0, 5)
        .map((item) => (item.domain ? cleanDomain(item.domain) : ""))
        .filter(Boolean),
    });

    for (const item of organic) {
      if (!item.domain || item.position === null) continue;
      const domain = cleanDomain(item.domain);
      if (domain === prospect) continue;

      const existing = ownerIndex.get(domain);
      if (existing) {
        existing.appearances += 1;
        existing.bestPosition = Math.min(existing.bestPosition, item.position);
        if (!existing.keywords.includes(row.keyword)) existing.keywords.push(row.keyword);
      } else {
        ownerIndex.set(domain, {
          domain,
          appearances: 1,
          bestPosition: item.position,
          keywords: [row.keyword],
        });
      }
    }
  }

  if (failures > 0) notes.push(`serp-failed:${failures}`);
  if (keywords.length === 0) notes.push("no-serp");

  // The domains that keep showing up are the category's real owners. A single
  // appearance is noise, so the list is ordered by how often they recur and
  // cut at the point where it stops being a pattern.
  const owners = [...ownerIndex.values()]
    .filter((owner) => owner.appearances >= 2)
    .sort((a, b) => b.appearances - a.appearances || a.bestPosition - b.bestPosition)
    .slice(0, 12);

  if (owners.length === 0 && keywords.length > 0) notes.push("no-recurring-owner");

  return {
    keywords,
    owners,
    prospectAppearances: keywords.filter((row) => row.prospectPosition !== null).length,
    costUsd: Number(costUsd.toFixed(6)),
    notes,
  };
}
