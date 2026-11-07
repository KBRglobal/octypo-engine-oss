/**
 * Which official page did we actually open before writing?
 *
 * A news story usually links to the organiser, the authority or the venue it
 * reports on. Those outbound links, minus other news sites and social
 * networks, are the primary sources for the story — the page where "no date
 * has been announced yet" can be verified today rather than assumed. Each one
 * is opened, and the record (URL, when, HTTP status) rides along with the
 * article so the quality gate and the editor can see what was checked.
 *
 * Never throws. Fetch is injected so this is testable offline.
 */

import { isAggregatorUrl, looksLikeNewsOrSocialHost } from "./source-url.js";
import type { SourceCheck } from "../schema/index.js";

type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" }) => Promise<{
  status: number;
  ok: boolean;
  url: string;
  text(): Promise<string>;
}>;

const HREF_RE = /<a\b[^>]*\bhref\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; OctypoSourceCheck/1.0)" };
const SKIP_PATH_RE = /\.(?:pdf|jpe?g|png|gif|webp|svg|mp4|zip)(?:$|\?)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Outbound links from a publisher page that could be the story's own subject. */
export function candidatePrimaryLinks(html: string, publisherUrl: string, cap = 4): string[] {
  const publisherHost = hostOf(publisherUrl);
  const seenHosts = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(HREF_RE)) {
    const href = m[1].replace(/&amp;/g, "&");
    const host = hostOf(href);
    if (!host || host === publisherHost || (publisherHost && host.endsWith(`.${publisherHost}`))) continue;
    if (seenHosts.has(host)) continue;
    if (isAggregatorUrl(href) || looksLikeNewsOrSocialHost(href) || SKIP_PATH_RE.test(href)) continue;
    // Tracking and ad hosts add nothing a reader can verify.
    if (/doubleclick|googlesyndication|google-analytics|googletagmanager|gstatic|cloudflare|cdn\.|amazonaws|akamai|outbrain|taboola|adsrvr|criteo|whatsapp\.com|wa\.me|apple\.com\/app|play\.google/i.test(host + href)) continue;
    seenHosts.add(host);
    out.push(href);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Open the publisher page, find the official pages it points at, open those
 * too, and return what was checked (reachable ones first).
 */
export async function discoverPrimarySources(
  publisherUrl: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: Date = new Date(),
  timeoutMs = 8_000
): Promise<SourceCheck[]> {
  if (!publisherUrl || isAggregatorUrl(publisherUrl)) return [];
  let html = "";
  try {
    const res = await fetchImpl(publisherUrl, { signal: AbortSignal.timeout(timeoutMs), headers: HEADERS, redirect: "follow" });
    html = res.ok ? await res.text() : "";
  } catch {
    return [];
  }
  const checks: SourceCheck[] = [];
  for (const url of candidatePrimaryLinks(html, publisherUrl)) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: HEADERS, redirect: "follow" });
      checks.push({ url: res.url || url, checkedAt: now.toISOString(), httpStatus: res.status });
    } catch {
      checks.push({ url, checkedAt: now.toISOString(), httpStatus: null });
    }
  }
  return checks.sort((a, b) => Number(b.httpStatus !== null && b.httpStatus < 400) - Number(a.httpStatus !== null && a.httpStatus < 400));
}

/** The checks a "not yet announced" claim may lean on: reachable and fresh. */
export function usablePrimarySources(checks: SourceCheck[] | null | undefined): Array<{ url: string; checkedAt: string }> {
  return (checks ?? [])
    .filter(c => c.httpStatus !== null && c.httpStatus < 400)
    .map(c => ({ url: c.url, checkedAt: c.checkedAt }));
}
