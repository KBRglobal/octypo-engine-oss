/**
 * Drop the phrases that are not customers before they become articles.
 *
 * The provider's keyword ideas for "event production" include "event
 * production jobs" and "event production course" — people looking for a job in the trade or
 * a course in it — with volumes as healthy as the buying phrases. Ranked on
 * demand alone they land near the top of the bank, and the engine then writes
 * a job-listings page for a company that is not hiring. Measured on the first
 * client this ran for: 17 of 40 phrases.
 *
 * Separate from the bank builder because the builder imports the store, and
 * the store imports the database; this rule has to be testable without one.
 * What was removed is logged rather than silently gone, so a bank that comes
 * out smaller than expected can be explained.
 */

import { logger } from "../lib/logger.js";
import { splitBuyers } from "../seo/sections/intent.js";
import type { KeywordMetrics } from "./keyword-data.js";

export function onlyBuyers(keywords: KeywordMetrics[], cluster: string): KeywordMetrics[] {
  const { buyers, removed } = splitBuyers(keywords);
  if (removed.length > 0) {
    logger.info(
      { cluster, removed: removed.length, examples: removed.slice(0, 3).map((r) => r.keyword) },
      "[IdeaBank] Dropped phrases from job seekers and students"
    );
  }
  return buyers;
}
