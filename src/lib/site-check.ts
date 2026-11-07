/**
 * Does this install's configuration match the site it publishes to?
 *
 * One install ran for days with ARTICLE_PATH_PREFIX=/insights while the site
 * served articles under /articles: every liveness check failed, IndexNow was
 * pinged with URLs that 404, and nobody noticed because nothing compared the
 * config with the live site. This check does, from the site's own sitemap,
 * and the fleet monitor reads it every 15 minutes.
 */

import { siteInventory, normalisePath, type SiteInventory } from "./site-inventory.js";

export interface SiteCheck {
  siteUrl: string | null;
  articlePathPrefix: string;
  /** The sitemap was fetched and listed pages on this origin. */
  sitemapOk: boolean;
  /** At least one sitemap URL lives under the configured article prefix. */
  prefixOk: boolean;
  /** Prefixes that DO hold several pages, to name the likely correct value. */
  observedPrefixes: string[];
  pageCount: number;
  checkedAt: string;
  error: string;
}

export function evaluateSiteCheck(
  inventory: SiteInventory,
  siteUrl: string | null,
  articlePathPrefix: string
): SiteCheck {
  const prefix = normalisePath(articlePathPrefix);
  const sitemapOk = !inventory.error && inventory.paths.length > 0;
  const under = inventory.paths.filter(p => p.startsWith(prefix) && p !== prefix).length;
  const counts = new Map<string, number>();
  for (const p of inventory.paths) {
    const segments = p.split("/").filter(Boolean);
    if (segments.length >= 2) counts.set(`/${segments[0]}/`, (counts.get(`/${segments[0]}/`) ?? 0) + 1);
  }
  const observedPrefixes = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);
  return {
    siteUrl,
    articlePathPrefix: prefix,
    sitemapOk,
    // Without a sitemap the prefix cannot be judged; that is sitemapOk's
    // failure, not a second one.
    prefixOk: !sitemapOk || under > 0,
    observedPrefixes,
    pageCount: inventory.paths.length,
    checkedAt: inventory.fetchedAt,
    error: inventory.error,
  };
}

const TTL_MS = 60 * 60 * 1000;
let cached: { at: number; value: SiteCheck } | null = null;

/** Cached for an hour: the monitor polls every 15 minutes and this must stay cheap. */
export async function siteCheck(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<SiteCheck> {
  if (cached && now.getTime() - cached.at < TTL_MS) return cached.value;
  const siteUrl = env.SITE_URL?.replace(/\/+$/, "") || null;
  const prefix = env.ARTICLE_PATH_PREFIX?.trim() || "/guides";
  const inventory = await siteInventory(siteUrl, undefined, now);
  const value = evaluateSiteCheck(inventory, siteUrl, prefix);
  cached = { at: now.getTime(), value };
  return value;
}

export function resetSiteCheckCache(): void {
  cached = null;
}
