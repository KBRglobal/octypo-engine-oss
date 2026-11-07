/**
 * Draws from the idea bank at the customer's pace.
 *
 * Mirrors the RSS and library schedulers deliberately: same daily-limit shape,
 * same in-flight guard, same advisory lock. The bank is a third content source,
 * not a second system.
 */

import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db.js";
import { contentIdeas, contents } from "../schema/index.js";
import { jobQueue, JobType } from "../job-queue.js";
import { log } from "../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";
import { nextPlannedIdeas, claimIdeas, markIdea } from "./bank-store.js";
import { resolveLocale } from "../config/locale.js";
import { coverageIndexForSite, findCoveringPage, type CoverageIndex } from "./site-coverage.js";

export interface IdeaSchedulerConfig {
  /** Max articles written from the bank per day. */
  dailyLimit: number;
  intervalMinutes: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: IdeaSchedulerConfig = {
  dailyLimit: 3,
  intervalMinutes: 30,
  enabled: true,
};

let schedulerInterval: NodeJS.Timeout | null = null;
let currentConfig: IdeaSchedulerConfig = { ...DEFAULT_CONFIG };

async function writtenToday(): Promise<number> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  // A written article the operator deleted gave the reader nothing, so it must
  // not use up the day's slot (2026-10-07: a deleted draft cost LED GO its day).
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentIdeas)
    .leftJoin(contents, eq(contents.id, contentIdeas.contentId))
    .where(
      and(
        eq(contentIdeas.status, "written"),
        gte(contentIdeas.updatedAt, midnight),
        or(isNull(contentIdeas.contentId), isNull(contents.deletedAt))
      )
    );

  return row?.count ?? 0;
}

async function inFlight(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contentIdeas)
    .where(inArray(contentIdeas.status, ["queued"]));

  return row?.count ?? 0;
}

/** A queued idea whose write job never landed. 30 min is well past a write. */
async function recoverStuckIdeas(): Promise<void> {
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  await db
    .update(contentIdeas)
    .set({ status: "planned", updatedAt: new Date() })
    .where(and(eq(contentIdeas.status, "queued"), lt(contentIdeas.updatedAt, stale)));
}

/**
 * The next `limit` planned ideas whose topic the host site does not already
 * own. A covered idea is skipped for good, with the covering page recorded:
 * an evergreen guide beside a hub on the same query splits the query and the
 * hub falls. Without a readable sitemap nothing is skipped.
 */
export async function writableIdeas(
  limit: number,
  loadCoverage: () => Promise<CoverageIndex | null> = () =>
    process.env.IDEA_COVERAGE_CHECK === "off"
      ? Promise.resolve(null)
      : resolveLocale(null).then((locale) => coverageIndexForSite(undefined, locale))
): Promise<Awaited<ReturnType<typeof nextPlannedIdeas>>> {
  const first = await nextPlannedIdeas(limit);
  if (first.length === 0) return first;
  const coverage = await loadCoverage();
  if (!coverage) return first;

  const writable: typeof first = [];
  let batch = first;
  // Skipped ideas leave room; look a few batches further so a run of covered
  // ideas does not stall the day's quota.
  for (let round = 0; round < 5 && batch.length > 0 && writable.length < limit; round++) {
    for (const idea of batch) {
      const match = findCoveringPage(idea.targetKeyword, coverage);
      if (!match) {
        writable.push(idea);
        continue;
      }
      await markIdea(idea.id, "skipped", undefined, {
        skipReason: "covered_by_site_page",
        coveredBy: match.url,
        coveredRule: match.rule,
        coveredMatchedOn: match.matchedOn,
        coveredAt: new Date().toISOString(),
      });
      log.info("[IdeaScheduler] Idea skipped — the site already owns this topic", {
        ideaId: idea.id,
        keyword: idea.targetKeyword,
        coveredBy: match.url,
        rule: match.rule,
      });
    }
    if (writable.length >= limit) break;
    // Kept ideas are still "planned" and rank first; skipped ones are gone.
    // The top `limit` is therefore the kept ones plus the next new ones.
    batch = (await nextPlannedIdeas(limit)).filter((idea) => !writable.some((kept) => kept.id === idea.id));
  }
  return writable.slice(0, limit);
}

export async function runIdeaSchedulerCycle(): Promise<{ queued: number; remaining: number }> {
  await recoverStuckIdeas();
  if (!currentConfig.enabled) return { queued: 0, remaining: 0 };

  const remaining = Math.max(
    0,
    currentConfig.dailyLimit - (await writtenToday()) - (await inFlight())
  );
  if (remaining <= 0) return { queued: 0, remaining: 0 };

  const ideas = await writableIdeas(remaining);
  if (ideas.length === 0) {
    log.info("[IdeaScheduler] The bank is empty — rebuild it or add seeds");
    return { queued: 0, remaining };
  }

  // Claim before enqueueing: a job for an idea another tick already took would
  // write the same article twice.
  const claimed = await claimIdeas(ideas.map((idea) => idea.id));
  for (const id of claimed) {
    await jobQueue.addJob("idea_write" as JobType, { ideaId: id }, { priority: 3 });
  }

  log.info("[IdeaScheduler] Cycle complete", { queued: claimed.length });
  return { queued: claimed.length, remaining: remaining - claimed.length };
}

export function startIdeaScheduler(config?: Partial<IdeaSchedulerConfig>): void {
  currentConfig = { ...DEFAULT_CONFIG, ...config };
  if (schedulerInterval) clearInterval(schedulerInterval);

  const tick = () =>
    withTickLock(TICK_LOCKS.ideaScheduler, () => runIdeaSchedulerCycle()).catch((error) =>
      log.error("[IdeaScheduler] Cycle failed", { error })
    );

  schedulerInterval = setInterval(tick, currentConfig.intervalMinutes * 60_000);
  void tick();
}

export function stopIdeaScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
}

export function getIdeaSchedulerStatus(): IdeaSchedulerConfig & { running: boolean } {
  return { ...currentConfig, running: schedulerInterval !== null };
}
