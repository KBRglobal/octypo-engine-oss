/**
 * What pages the customer's site actually has.
 *
 * A git-delivered site lives outside this database, so the engine only knew
 * the articles it wrote itself: the internal-link audit ran blind ("no list
 * of published slugs was supplied") on every review, and the writer had
 * nothing to link to. The sitemap is the site's own statement of its pages;
 * it is fetched once a day per process and every consumer — writer prompt,
 * Gate 2 audit, install check — reads the same list.
 *
 * Never throws. A site without a reachable sitemap yields an empty inventory
 * and the consumers say so, loudly.
 */

export interface SiteInventory {
  /** Absolute origin the paths belong to, e.g. https://www.example.com */
  origin: string;
  /** Path portion of every <loc>, with a trailing slash, e.g. /attractions/ */
  paths: string[];
  fetchedAt: string;
  /** Empty string when the fetch succeeded. */
  error: string;
}

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 OctypoSiteInventory/1.0";
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const SITEMAP_INDEX_RE = /<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi;

export function normalisePath(pathname: string): string {
  let p = pathname.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (!p.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(p)) p = `${p}/`;
  return p;
}

/** Paths from one sitemap body that belong to `origin`. */
export function parseSitemapPaths(xml: string, origin: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(LOC_RE)) {
    try {
      const u = new URL(m[1]);
      if (u.origin !== origin) continue;
      // A sitemap index lists other sitemaps, not pages.
      if (/\.xml(?:\.gz)?$/i.test(u.pathname)) continue;
      out.add(normalisePath(u.pathname));
    } catch {
      // not a URL; skip
    }
  }
  return [...out];
}

export async function fetchSiteInventory(
  siteUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: Date = new Date()
): Promise<SiteInventory> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return { origin: siteUrl, paths: [], fetchedAt: now.toISOString(), error: "SITE_URL is not a valid URL" };
  }
  const get = async (url: string): Promise<string> => {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
      // Some shared hosts answer 406 to anything that
      // does not look like a browser.
      headers: { "user-agent": BROWSER_UA, accept: "application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  };
  /** The sitemap's real address: /sitemap.xml, then Astro's /sitemap-index.xml, then whatever robots.txt names. */
  const locate = async (): Promise<string> => {
    const errors: string[] = [];
    for (const candidate of [`${origin}/sitemap.xml`, `${origin}/sitemap-index.xml`]) {
      try {
        return await get(candidate);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const robots = await get(`${origin}/robots.txt`);
      const named = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map(m => m[1]);
      for (const url of named.slice(0, 3)) {
        try {
          return await get(url);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    throw new Error(errors[0] ?? "no sitemap found");
  };
  try {
    const xml = await locate();
    const children = [...xml.matchAll(SITEMAP_INDEX_RE)].map(m => m[1]);
    let paths = parseSitemapPaths(xml, origin);
    for (const child of children.slice(0, 20)) {
      try {
        paths = paths.concat(parseSitemapPaths(await get(child), origin));
      } catch {
        // one broken child sitemap does not void the rest
      }
    }
    paths = [...new Set(paths)].sort();
    return {
      origin,
      paths,
      fetchedAt: now.toISOString(),
      error: paths.length === 0 ? "sitemap.xml had no URLs on this origin" : "",
    };
  } catch (error) {
    return {
      origin,
      paths: [],
      fetchedAt: now.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------- process-wide daily cache ----------

const TTL_MS = 24 * 60 * 60 * 1000;
let cached: { key: string; at: number; value: SiteInventory } | null = null;
let inflight: Promise<SiteInventory> | null = null;

/** The inventory for SITE_URL, refreshed at most once a day; empty without SITE_URL. */
export async function siteInventory(
  siteUrl: string | null | undefined = process.env.SITE_URL,
  fetchImpl?: FetchLike,
  now: Date = new Date()
): Promise<SiteInventory> {
  const key = (siteUrl ?? "").replace(/\/+$/, "");
  if (!key) return { origin: "", paths: [], fetchedAt: now.toISOString(), error: "SITE_URL is not set" };
  if (cached && cached.key === key && now.getTime() - cached.at < TTL_MS && !cached.value.error) {
    return cached.value;
  }
  if (inflight) return inflight;
  inflight = fetchSiteInventory(key, fetchImpl, now)
    .then(value => {
      cached = { key, at: now.getTime(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Test hook. */
export function resetSiteInventoryCache(): void {
  cached = null;
  inflight = null;
}

/** The last path segment, the shape the internal-link audit compares on. */
export function slugsFromPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const segments = p.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) out.add(last.toLowerCase());
  }
  return [...out];
}

/**
 * Pages worth offering a writer: top-level hubs first, then the deepest
 * pages under `articlePrefix` (the newest articles). Capped so the prompt
 * stays short.
 */
export function linkablePaths(paths: string[], articlePrefix: string, cap = 40): string[] {
  const prefix = normalisePath(articlePrefix);
  const hubs = paths.filter(p => p !== "/" && p.split("/").filter(Boolean).length === 1);
  const articles = paths.filter(p => p.startsWith(prefix) && p !== prefix);
  return [...hubs, ...articles.slice(-Math.max(0, cap - hubs.length))].slice(0, cap);
}
