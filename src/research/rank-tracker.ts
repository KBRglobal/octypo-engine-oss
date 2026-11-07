/**
 * Once a month, ask Google where every target phrase stands.
 *
 * The bank decides what the engine writes; this is the only thing that says
 * whether it worked. Without it the engine is a machine that produces
 * articles, and with it the engine is a machine that moves a client's
 * rankings — which is the thing they are paying for and the thing that keeps
 * them. So it runs on its own: at boot when there is no reading from the last
 * month, and then monthly, with nobody asked.
 *
 * One call does the whole site. `ranked_keywords` returns every phrase the
 * domain ranks for with its position, so the tracker buys that once (about a
 * tenth of a dollar at most) and looks each target phrase up in it. A phrase
 * absent from the answer is stored with a null position: "not ranking on this
 * date" is the reading that matters most on a new client.
 */

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../db.js";
import { contentIdeas, contents, rankSnapshots } from "../schema/index.js";
import { SITE_URL } from "../config/domain.js";
import { log } from "../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";
import { seoClientFromEnv, type SeoClient } from "../seo/client.js";
import { mapRows, toRankedKeywordRow } from "../seo/rows.js";
import { cleanDomain } from "../seo/tools.js";
import { recordSpend } from "../seo/store.js";

import { isDue } from "./rank-rhythm.js";

/** How often the tracker checks whether a month has passed. */
const CHECK_EVERY_MS = 6 * 3_600_000;
/** `ranked_keywords` takes at most this many rows per call. */
const MAX_RANKED = 1000;

let timer: NodeJS.Timeout | null = null;

export interface RankRun {
  runId: string;
  measuredAt: Date;
  tracked: number;
  ranking: number;
  top10: number;
  top3: number;
  costUsd: number;
}

/**
 * The phrases worth measuring: everything the bank plans or has written for,
 * plus the primary phrase of every published article. De-duplicated, because
 * an idea and its article carry the same phrase.
 */
export async function targetKeywords(): Promise<string[]> {
  const fromIdeas = await db
    .select({ keyword: contentIdeas.targetKeyword })
    .from(contentIdeas)
    .where(isNotNull(contentIdeas.targetKeyword));
  const fromArticles = await db
    .select({ keyword: contents.primaryKeyword })
    .from(contents)
    .where(and(eq(contents.status, "published"), isNotNull(contents.primaryKeyword)));

  const seen = new Set<string>();
  for (const row of [...fromIdeas, ...fromArticles]) {
    const keyword = row.keyword?.trim().toLowerCase();
    if (keyword) seen.add(keyword);
  }
  return [...seen];
}

/** When the site was last measured, or null on a fresh install. */
export async function lastMeasuredAt(): Promise<Date | null> {
  const [row] = await db
    .select({ at: rankSnapshots.measuredAt })
    .from(rankSnapshots)
    .orderBy(desc(rankSnapshots.measuredAt))
    .limit(1);
  return row?.at ?? null;
}

export interface MeasureOptions {
  client?: SeoClient | null;
  domain?: string | null;
  market?: { locationCode?: number; languageCode?: string };
  now?: Date;
}

/**
 * Take one reading of every target phrase and store it.
 *
 * Returns null, and says why, when it cannot: no site URL to ask about, no
 * DataForSEO login, or nothing in the bank yet. None of those is an error —
 * a fresh install has nothing to measure — so none of them throws.
 */
export async function measureRankings(options: MeasureOptions = {}): Promise<RankRun | null> {
  const domain = cleanDomain(options.domain ?? SITE_URL ?? "");
  if (!domain) {
    log.info("[RankTracker] No SITE_URL — nothing to measure against");
    return null;
  }
  const client = options.client === undefined ? seoClientFromEnv() : options.client;
  if (!client) {
    log.info("[RankTracker] No DataForSEO login on this install — rankings not tracked");
    return null;
  }
  const keywords = await targetKeywords();
  if (keywords.length === 0) {
    log.info("[RankTracker] The bank is empty — nothing to measure yet");
    return null;
  }

  const response = await client.post(
    "/dataforseo_labs/google/ranked_keywords/live",
    { target: domain, limit: MAX_RANKED, order_by: ["ranked_serp_element.serp_item.etv,desc"] },
    options.market ?? {}
  );
  recordSpend("rank-tracker", response.costUsd);

  const ranked = new Map(
    mapRows(response.rows, toRankedKeywordRow).map((row) => [row.keyword.toLowerCase(), row])
  );

  const measuredAt = options.now ?? new Date();
  const runId = `${measuredAt.toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

  const rows = keywords.map((keyword) => {
    const hit = ranked.get(keyword);
    return {
      runId,
      keyword,
      position: hit?.position ?? null,
      url: hit?.url ?? null,
      searchVolume: hit?.volume === null || hit?.volume === undefined ? null : Math.round(hit.volume),
      trafficEstimate:
        hit?.trafficEstimate === null || hit?.trafficEstimate === undefined
          ? null
          : Math.round(hit.trafficEstimate),
      measuredAt,
    };
  });

  // One insert per run rather than one per phrase; a thousand phrases is a
  // single statement, and a half-written run is not a run.
  await db.insert(rankSnapshots).values(rows);

  const run: RankRun = {
    runId,
    measuredAt,
    tracked: rows.length,
    ranking: rows.filter((row) => row.position !== null).length,
    top10: rows.filter((row) => row.position !== null && row.position <= 10).length,
    top3: rows.filter((row) => row.position !== null && row.position <= 3).length,
    costUsd: response.costUsd,
  };
  log.info("[RankTracker] Measured", { ...run });
  return run;
}

/** Measure only when the last reading is older than a month. */
export async function runRankTrackerCycle(now = new Date()): Promise<RankRun | null> {
  if (!isDue(await lastMeasuredAt(), now)) return null;
  return measureRankings({ now });
}

export function startRankTracker(): void {
  if (timer) clearInterval(timer);
  const tick = () =>
    withTickLock(TICK_LOCKS.rankTracker, () => runRankTrackerCycle()).catch((error) =>
      log.error("[RankTracker] Cycle failed", { error })
    );
  timer = setInterval(tick, CHECK_EVERY_MS);
  // Not immediately: the bank may still be filling on a fresh boot, and a
  // baseline of zero phrases is a reading nobody wants.
  setTimeout(tick, 5 * 60_000).unref?.();
}

export function stopRankTracker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface RankMovement {
  keyword: string;
  position: number | null;
  previous: number | null;
  /** Positive when the phrase moved up the page. */
  change: number | null;
  url: string | null;
  searchVolume: number | null;
}

export interface RankReport {
  current: RankRun | null;
  previous: RankRun | null;
  movements: RankMovement[];
}

/**
 * This month against the one before, phrase by phrase.
 *
 * "Previous" is the latest run before the current one, not "a month ago" —
 * a client whose tracker missed a month still gets a comparison, and the
 * dates on both runs say how far apart they really are.
 */
export async function rankReport(): Promise<RankReport> {
  const runs = await db
    .select({
      runId: rankSnapshots.runId,
      measuredAt: sql<Date>`min(${rankSnapshots.measuredAt})`,
      tracked: sql<number>`count(*)::int`,
      ranking: sql<number>`count(${rankSnapshots.position})::int`,
      top10: sql<number>`count(*) filter (where ${rankSnapshots.position} <= 10)::int`,
      top3: sql<number>`count(*) filter (where ${rankSnapshots.position} <= 3)::int`,
    })
    .from(rankSnapshots)
    .groupBy(rankSnapshots.runId)
    .orderBy(desc(sql`min(${rankSnapshots.measuredAt})`))
    .limit(2);

  const toRun = (row: (typeof runs)[number] | undefined): RankRun | null =>
    row
      ? {
          runId: row.runId,
          measuredAt: new Date(row.measuredAt),
          tracked: row.tracked,
          ranking: row.ranking,
          top10: row.top10,
          top3: row.top3,
          costUsd: 0,
        }
      : null;

  const current = toRun(runs[0]);
  const previous = toRun(runs[1]);
  if (!current) return { current: null, previous: null, movements: [] };

  const currentRows = await db
    .select()
    .from(rankSnapshots)
    .where(eq(rankSnapshots.runId, current.runId));
  const previousRows = previous
    ? await db.select().from(rankSnapshots).where(eq(rankSnapshots.runId, previous.runId))
    : [];
  const before = new Map(previousRows.map((row) => [row.keyword, row.position]));

  const movements: RankMovement[] = currentRows
    .map((row) => {
      const prior = before.has(row.keyword) ? (before.get(row.keyword) ?? null) : null;
      return {
        keyword: row.keyword,
        position: row.position,
        previous: prior,
        // Up the page is a positive number; a phrase that entered or left the
        // results has no prior to subtract from and stays null.
        change: row.position !== null && prior !== null ? prior - row.position : null,
        url: row.url,
        searchVolume: row.searchVolume,
      };
    })
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  return { current, previous, movements };
}

/** For the health endpoints: is the tracker alive, and when did it last run. */
export async function rankTrackerStatus(): Promise<{ running: boolean; lastMeasuredAt: string | null }> {
  const last = await lastMeasuredAt().catch(() => null);
  return { running: timer !== null, lastMeasuredAt: last?.toISOString() ?? null };
}

