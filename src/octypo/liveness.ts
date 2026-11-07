/**
 * Post-publish liveness verification (SEO-F).
 *
 * "Published" in the engine's database and "reachable and indexable on the
 * public site" are two different facts, and until now nobody checked the
 * second one. After a publish the engine GETs its own public article URL and
 * records what it saw — status, reachability, a noindex directive — on the
 * row, so a broken deploy or a stray X-Robots-Tag surfaces in the Studio
 * instead of in next month's traffic report.
 *
 * Strictly an OBSERVER: it runs fire-and-forget after the publish result is
 * already decided, every failure is swallowed into the record or a warn log,
 * and nothing here can un-publish an article.
 *
 * SSRF containment (T-quick-02): the URL is built exclusively from SITE_URL +
 * ARTICLE_PATH_PREFIX + the already-sanitized slug — never from row-stored or
 * model-produced URLs. 10s timeout, body read capped at ~20KB.
 */

import { eq } from "drizzle-orm";

import { db } from "../db.js";
import { contents } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { SITE_URL } from "../config/domain.js";
import { ARTICLE_PATH_PREFIX } from "./aeo.js";

export interface LivenessRecord {
  checkedAt: string;
  httpStatus: number | null;
  ok: boolean;
  noindex: boolean;
  error?: string;
}

const BODY_CAP_BYTES = 20 * 1024;
const TIMEOUT_MS = 10_000;

/** A robots meta tag carrying noindex, either attribute order. */
const ROBOTS_META_RE =
  /<meta\b(?:[^>]*\bname\s*=\s*["']?robots["']?[^>]*\bcontent\s*=\s*["'][^"']*noindex|[^>]*\bcontent\s*=\s*["'][^"']*noindex[^"']*["'][^>]*\bname\s*=\s*["']?robots)/i;

/** Read at most the first ~20KB of the body — enough for any <head>. */
async function readHead(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, BODY_CAP_BYTES);
  const decoder = new TextDecoder();
  let head = "";
  try {
    while (head.length < BODY_CAP_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      head += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return head.slice(0, BODY_CAP_BYTES);
}

/**
 * GET the public article URL and record the verdict on the row.
 *
 * Returns the record (or null when SITE_URL is unset and the check is
 * skipped). NEVER throws — the caller invokes it fire-and-forget after a
 * publish, and a verification failure must never look like a publish failure.
 */
export async function verifyArticleLiveness(
  target: { id: string; slug: string },
  fetchImpl: typeof fetch = fetch
): Promise<LivenessRecord | null> {
  if (!SITE_URL) return null;

  const url = `${SITE_URL}${ARTICLE_PATH_PREFIX}/${encodeURIComponent(target.slug)}/`;
  const record: LivenessRecord = {
    checkedAt: new Date().toISOString(),
    httpStatus: null,
    ok: false,
    noindex: false,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      record.httpStatus = res.status;
      const headerNoindex = /noindex/i.test(res.headers.get("x-robots-tag") ?? "");
      const body = await readHead(res).catch(() => "");
      record.noindex = headerNoindex || ROBOTS_META_RE.test(body);
      record.ok = res.ok && !record.noindex;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  if (!record.ok || record.noindex) {
    logger.warn(
      { contentId: target.id, url, liveness: record },
      "[Liveness] Published article failed its liveness check"
    );
  }

  try {
    await db.update(contents).set({ liveness: record }).where(eq(contents.id, target.id));
  } catch (error) {
    logger.warn(
      { contentId: target.id, error },
      "[Liveness] Could not store the liveness record (non-fatal)"
    );
  }

  return record;
}
