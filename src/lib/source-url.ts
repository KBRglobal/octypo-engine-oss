/**
 * Sources must be the page that actually reported the story.
 *
 * A Google News RSS link is a redirect, not a source: it names no publisher,
 * it cannot be verified by a reader, and a customer's article ended up citing
 * "news.google.com" under a real story. The aggregator wrapper is decoded (or
 * followed) to the publisher URL before anything is written down, and the
 * quality gate refuses an aggregator host as a source outright.
 *
 * Pure except for `resolveSourceUrl`, which takes its fetch so the decoding
 * and the network fallback are both testable offline.
 */

/** Hosts that only ever point elsewhere. */
const AGGREGATOR_HOSTS = [
  "news.google.com",
  "google.com/rss",
  "feedproxy.google.com",
  "feeds.feedburner.com",
  "bing.com/news",
  "news.yahoo.com/rss",
  "flipboard.com",
  "feedly.com",
  "inoreader.com",
  "t.co",
  "bit.ly",
  "tinyurl.com",
  "lnkd.in",
];

function hostAndPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

/** True for a link that names an aggregator or a redirector, never a publisher. */
export function isAggregatorUrl(url: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return false;
  const full = `${parsed.host}${parsed.path}`;
  if (parsed.host.startsWith("news.google.")) return true; // every regional Google News host
  return AGGREGATOR_HOSTS.some(entry =>
    entry.includes("/") ? full.startsWith(entry) : parsed.host === entry || parsed.host.endsWith(`.${entry}`)
  );
}

/**
 * Google News article ids are base64url, and the ones that begin with "CBMi"
 * carry the publisher URL in clear text inside a protobuf-ish envelope. Newer
 * "AU_yqL…" ids are opaque and need the network fallback.
 */
export function decodeGoogleNewsUrl(url: string): string | null {
  const parsed = hostAndPath(url);
  if (!parsed || !parsed.host.startsWith("news.google.")) return null;
  const match = /\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/i.exec(new URL(url).pathname);
  if (!match) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[1].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
  const text = bytes.toString("latin1");
  const found = /https?:\/\/[\x21-\x7e]+/.exec(text);
  if (!found) return null;
  // The URL is length-prefixed, so it ends at the first control byte; anything
  // after "\x" garbage is the next field.
  const candidate = found[0].replace(/[\x00-\x1f\x7f].*$/, "");
  try {
    const u = new URL(candidate);
    return isAggregatorUrl(u.toString()) ? null : u.toString();
  } catch {
    return null;
  }
}

export interface ResolvedSource {
  /** The URL to cite. Equals the input when nothing needed resolving. */
  url: string;
  /** What was done, for the log and the gate's evidence. */
  via: "as-is" | "decoded" | "redirect" | "html-redirect" | "unresolved";
}

type FetchLike = (input: string, init?: { method?: string; body?: string; redirect?: "follow" | "manual"; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  url: string;
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

const REDIRECT_HTML_RE = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"/i;
const META_REFRESH_RE = /http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i;
const GN_SIGNATURE_RE = /data-n-a-sg="([^"]+)"/;
const GN_TIMESTAMP_RE = /data-n-a-ts="([^"]+)"/;
const GN_BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const UA = "Mozilla/5.0 (compatible; OctypoSourceResolver/1.0)";

/**
 * The current Google News format ("AU_yqL…" ids, often wrapped in a CBMi
 * envelope) carries no URL in the id. The article page holds a signature and
 * a timestamp, and Google's own splash endpoint exchanges those for the
 * publisher URL. Verified live 2026-09-15; returns null when the shape changes.
 */
export async function resolveGoogleNewsViaSplash(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<string | null> {
  const match = /\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/i.exec(new URL(url).pathname);
  if (!match) return null;
  const id = match[1];
  const page = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA } });
  const html = await page.text();
  const sg = GN_SIGNATURE_RE.exec(html)?.[1];
  const ts = GN_TIMESTAMP_RE.exec(html)?.[1];
  if (!sg || !ts) return null;
  const inner = JSON.stringify([
    "garturlreq",
    [["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]], "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0],
    id,
    Number(ts),
    sg,
  ]);
  const body = `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]))}`;
  const res = await fetchImpl(GN_BATCH_URL, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const text = await res.text();
  const found = text.match(/https?:\\?\/\\?\/[^"\\\s]+/g) ?? [];
  for (const raw of found) {
    const candidate = raw.replace(/\\\//g, "/");
    if (!isAggregatorUrl(candidate) && !/google\./i.test(candidate)) {
      try {
        return new URL(candidate).toString();
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Turn an aggregator link into the publisher's URL. Never throws: an
 * unresolvable link comes back marked "unresolved" and the gate decides.
 */
export async function resolveSourceUrl(
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 10_000
): Promise<ResolvedSource> {
  if (!isAggregatorUrl(url)) return { url, via: "as-is" };

  const decoded = decodeGoogleNewsUrl(url);
  if (decoded) return { url: decoded, via: "decoded" };

  if (/news\.google\./i.test(url)) {
    try {
      const viaSplash = await resolveGoogleNewsViaSplash(url, fetchImpl, timeoutMs);
      if (viaSplash) return { url: viaSplash, via: "decoded" };
    } catch {
      // fall through to the generic redirect follow
    }
  }

  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (compatible; OctypoSourceResolver/1.0)" },
    });
    if (res.url && !isAggregatorUrl(res.url)) return { url: res.url, via: "redirect" };
    const html = await res.text();
    const meta = META_REFRESH_RE.exec(html)?.[1] ?? REDIRECT_HTML_RE.exec(html)?.[1];
    if (meta && !isAggregatorUrl(meta)) return { url: meta, via: "html-redirect" };
  } catch {
    // fall through
  }
  return { url, via: "unresolved" };
}

/**
 * Hosts that report on things rather than being the thing. A claim such as
 * "no official date has been announced" is only honest when the official
 * page itself was checked, so a news domain never counts as a primary source
 * for that purpose.
 */
const NEWS_HOST_HINTS = [
  "news", "times", "post", "herald", "tribune", "gazette", "reuters", "apnews", "bbc", "cnn", "guardian",
  "aljazeera", "timeout", "bloomberg", "forbes", "wikipedia",
  "facebook", "instagram", "twitter", "x.com", "tiktok", "youtube", "linkedin", "medium.com",
];

export function looksLikeNewsOrSocialHost(url: string): boolean {
  const parsed = hostAndPath(url);
  if (!parsed) return true;
  return NEWS_HOST_HINTS.some(hint => parsed.host.includes(hint));
}
