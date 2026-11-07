/**
 * Search-engine indexing notifications (IndexNow).
 *
 * No-op (logs only) unless SITE_URL is configured, in which case published
 * URLs are POSTed to the IndexNow API. INDEXNOW_API_KEY is optional but
 * required by the IndexNow protocol for the ping to be accepted.
 */

import { SITE_URL } from "../config/domain.js";
import { createLogger } from "./logger.js";
import { entitled } from "../config/entitlements.js";

const logger = createLogger("indexing");

/**
 * Submit URLs (or absolute paths like "/article/slug") to IndexNow.
 * Never throws — indexing is best-effort.
 */
export async function submitToIndexNow(urls: string[]): Promise<void> {
  if (urls.length === 0) return;

  // The engine is a CLOSED, headless system: it must never trigger indexing.
  // The consuming site owns its own indexing / sitemap / Search Console.
  // IndexNow stays off unless ENABLE_INDEXNOW is explicitly turned on.
  const enabled = ["true", "1", "yes", "on"].includes(
    (process.env.ENABLE_INDEXNOW || "false").toLowerCase()
  );
  if (!enabled) {
    logger.debug({ count: urls.length }, "[IndexNow] disabled (engine is closed/headless) — skipping");
    return;
  }
  if (!entitled("indexnow")) {
    logger.debug({ count: urls.length }, "[IndexNow] not in this customer's plan — skipping");
    return;
  }

  if (!SITE_URL) {
    logger.debug({ count: urls.length }, "[IndexNow] SITE_URL not set — skipping notification");
    return;
  }

  const key = process.env.INDEXNOW_API_KEY;
  if (!key) {
    logger.debug({ count: urls.length }, "[IndexNow] INDEXNOW_API_KEY not set — skipping");
    return;
  }

  const host = new URL(SITE_URL).host;
  const urlList = urls.map(u => (u.startsWith("http") ? u : `${SITE_URL}${u}`));

  try {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, urlList }),
    });
    logger.info({ count: urlList.length, status: res.status }, "[IndexNow] URLs submitted");
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[IndexNow] Submission failed (non-fatal)"
    );
  }
}
