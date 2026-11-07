/**
 * Document Library Scheduler
 *
 * The second content source (alongside RSS). Continuously turns mined article
 * ideas (library_items with status='idea') into original, source-grounded
 * articles via the SAME writer → Gate 2 → publish path the RSS pipeline uses.
 *
 * Loop: pick up to N ideas (oldest first), respecting a daily published-from-
 * library limit, mark each 'queued', and enqueue a library_write job.
 *
 * Mirrors rss-scheduler.ts.
 */

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "../../db.js";
import { libraryItems, documents } from "../../schema/index.js";
import { jobQueue, JobType } from "../../job-queue.js";
import { log } from "../../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../../lib/advisory-lock.js";

interface LibrarySchedulerConfig {
  /** Max articles produced from the library per day. */
  dailyLimit: number;
  /** Interval between scheduler runs in minutes. */
  intervalMinutes: number;
  /** Whether the scheduler is enabled. */
  enabled: boolean;
}

const DEFAULT_CONFIG: LibrarySchedulerConfig = {
  dailyLimit: 3,
  intervalMinutes: 30,
  enabled: true,
};

let schedulerInterval: NodeJS.Timeout | null = null;
let currentConfig: LibrarySchedulerConfig = { ...DEFAULT_CONFIG };

/** Library items published today (status='published' updated today). */
async function getTodaysPublishedCount(): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(libraryItems)
    .where(and(eq(libraryItems.status, "published"), gte(libraryItems.updatedAt, today)));

  return result[0]?.count || 0;
}

/** How many library_write jobs are already in flight (pending or running). */
async function getInFlightCount(): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(libraryItems)
    .where(inArray(libraryItems.status, ["queued", "writing"]));

  return result[0]?.count || 0;
}

async function runSchedulerCycle(): Promise<{ queued: number; remaining: number }> {
  if (!currentConfig.enabled) {
    return { queued: 0, remaining: currentConfig.dailyLimit };
  }

  const publishedToday = await getTodaysPublishedCount();
  const inFlight = await getInFlightCount();
  const remaining = Math.max(0, currentConfig.dailyLimit - publishedToday - inFlight);

  if (remaining <= 0) {
    log.info("[LibraryScheduler] Daily limit reached or jobs in flight", {
      publishedToday,
      inFlight,
      dailyLimit: currentConfig.dailyLimit,
    });
    return { queued: 0, remaining: 0 };
  }

  // Pick the oldest unqueued ideas.
  const ideas = await db
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(eq(libraryItems.status, "idea"))
    .orderBy(asc(libraryItems.createdAt))
    .limit(remaining);

  if (ideas.length === 0) {
    return { queued: 0, remaining };
  }

  let queued = 0;
  for (const idea of ideas) {
    // Mark queued only if still an idea (guards against concurrent cycles).
    const [claimed] = await db
      .update(libraryItems)
      .set({ status: "queued", updatedAt: new Date() })
      .where(and(eq(libraryItems.id, idea.id), eq(libraryItems.status, "idea")))
      .returning({ id: libraryItems.id });

    if (!claimed) continue;

    await jobQueue.addJob(
      "library_write" as JobType,
      { libraryItemId: claimed.id },
      { priority: 3 }
    );
    queued++;
  }

  log.info("[LibraryScheduler] Cycle complete", { queued, remaining: remaining - queued });
  return { queued, remaining: remaining - queued };
}

// ============================================
// PUBLIC API
// ============================================

export function startLibraryScheduler(config?: Partial<LibrarySchedulerConfig>): void {
  if (schedulerInterval) {
    stopLibraryScheduler();
  }

  currentConfig = { ...DEFAULT_CONFIG, ...config };

  log.info("[LibraryScheduler] Starting scheduler", {
    dailyLimit: currentConfig.dailyLimit,
    intervalMinutes: currentConfig.intervalMinutes,
  });

  withTickLock(TICK_LOCKS.library, runSchedulerCycle).catch(err => {
    log.error("[LibraryScheduler] Initial cycle failed:", err);
  });

  schedulerInterval = setInterval(
    () =>
      withTickLock(TICK_LOCKS.library, runSchedulerCycle).catch(err => {
        log.error("[LibraryScheduler] Scheduled cycle failed:", err);
      }),
    currentConfig.intervalMinutes * 60 * 1000
  );
}

export function stopLibraryScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log.info("[LibraryScheduler] Scheduler stopped");
  }
}

export function getLibrarySchedulerStatus(): {
  running: boolean;
  config: LibrarySchedulerConfig;
} {
  return {
    running: schedulerInterval !== null,
    config: { ...currentConfig },
  };
}

export async function getLibraryStats(): Promise<{
  documents: number;
  ideasPending: number;
  queued: number;
  writing: number;
  publishedTotal: number;
  publishedToday: number;
  dailyRemaining: number;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [docCount, statusRows, publishedTodayRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(documents),
    db
      .select({ status: libraryItems.status, count: sql<number>`count(*)::int` })
      .from(libraryItems)
      .groupBy(libraryItems.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(libraryItems)
      .where(and(eq(libraryItems.status, "published"), gte(libraryItems.updatedAt, today))),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row.count;

  const publishedToday = publishedTodayRows[0]?.count || 0;

  return {
    documents: docCount[0]?.count || 0,
    ideasPending: byStatus.idea || 0,
    queued: byStatus.queued || 0,
    writing: byStatus.writing || 0,
    publishedTotal: byStatus.published || 0,
    publishedToday,
    dailyRemaining: Math.max(0, currentConfig.dailyLimit - publishedToday),
  };
}

/** Manually trigger a cycle (admin). */
export async function triggerLibraryCycle(): Promise<{ queued: number; remaining: number }> {
  return runSchedulerCycle();
}
