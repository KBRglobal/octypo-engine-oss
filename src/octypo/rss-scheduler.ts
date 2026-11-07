/**
 * RSS Content Scheduler v3
 *
 * Routes RSS content through the Gatekeeper Pipeline (Pipeline B):
 * RSS -> Gate1 (Selection) -> Writer -> Gate2 (Approval) -> Publish
 *
 * Key features:
 * - Global daily limit enforcement
 * - Pending job throttling (octypo_write jobs)
 * - Delegates item selection and evaluation to Gatekeeper
 * - Quality threshold enforcement via Gate1 + Gate2
 */

import { db } from "../db.js";
import { contents, backgroundJobs } from "../schema/index.js";
import { eq, and, gte, sql } from "drizzle-orm";
import { getGatekeeperOrchestrator } from "./gatekeeper/index.js";
import { rssReader } from "./rss-reader.js";
import { log } from "../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";

// ============================================
// CONFIGURATION
// ============================================

interface RSSSchedulerConfig {
  /** Items per topic per day */
  dailyLimitPerTopic: number;
  /** Global daily limit across all topics */
  globalDailyLimit: number;
  /** Interval between scheduler runs in minutes (default: 30) */
  intervalMinutes: number;
  /** Whether scheduler is enabled */
  enabled: boolean;
  /** Minimum quality score for auto-publish (default: 85) */
  minQualityScore: number;
}

const DEFAULT_CONFIG: RSSSchedulerConfig = {
  dailyLimitPerTopic: 20,
  globalDailyLimit: 200,
  intervalMinutes: 10,
  enabled: true,
  minQualityScore: 85,
};

let schedulerInterval: NodeJS.Timeout | null = null;
let currentConfig: RSSSchedulerConfig = { ...DEFAULT_CONFIG };

// ============================================
// DAILY COUNT TRACKING (PER TOPIC)
// ============================================

interface TopicCounts {
  [topicId: string]: number;
}

async function getTodaysCountsPerTopic(): Promise<TopicCounts> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Count AI-generated articles per topic today
  // related_topic_ids is JSONB, use ->> 0 to get first element
  const result = await db.execute(sql`
    SELECT
      a.related_topic_ids ->> 0 as topic_id,
      COUNT(*) as count
    FROM contents c
    JOIN articles a ON a.content_id = c.id
    WHERE c.type = 'article'
      AND c.generated_by_ai = true
      AND c.created_at >= ${today.toISOString()}
      AND a.related_topic_ids IS NOT NULL
      AND jsonb_array_length(a.related_topic_ids) > 0
    GROUP BY a.related_topic_ids ->> 0
  `);

  const counts: TopicCounts = {};
  for (const row of result as unknown as any[]) {
    if (row.topic_id) {
      counts[row.topic_id] = Number.parseInt(row.count, 10);
    }
  }

  return counts;
}

async function getTodaysTotalCount(): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contents)
    .where(
      and(
        eq(contents.type, "article"),
        gte(contents.createdAt, today),
        eq(contents.generatedByAI, true)
      )
    );

  return result[0]?.count || 0;
}

// ============================================
// SCHEDULER CYCLE
// ============================================

async function runSchedulerCycle(): Promise<{
  created: number;
  topics: string[];
  globalRemaining: number;
}> {
  if (!currentConfig.enabled) {
    return { created: 0, topics: [], globalRemaining: currentConfig.globalDailyLimit };
  }

  // Check global limit
  const totalToday = await getTodaysTotalCount();
  const globalRemaining = Math.max(0, currentConfig.globalDailyLimit - totalToday);

  if (globalRemaining <= 0) {
    log.info("[RSSScheduler] Global daily limit reached", { totalToday });
    return { created: 0, topics: [], globalRemaining: 0 };
  }

  // Check pending octypo_write jobs to avoid creating too many
  const pendingJobs = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(backgroundJobs)
    .where(and(sql`${backgroundJobs.type} = 'octypo_write'`, eq(backgroundJobs.status, "pending")));

  const pendingCount = pendingJobs[0]?.count || 0;
  if (pendingCount >= 10) {
    log.info("[RSSScheduler] Too many pending octypo_write jobs, skipping cycle", { pendingCount });
    return { created: 0, topics: [], globalRemaining };
  }

  // Calculate how many items to process this cycle.
  // MAX_ITEMS_PER_CYCLE is intentionally low (5) so that if the system
  // was offline for a long time and accumulated a backlog, articles are
  // spread throughout the day rather than published all at once.
  // At 5 items per 10-min cycle → max 30/hour, 720/day (capped by globalDailyLimit).
  // Evaluating and writing are budgeted separately: a strict selector may
  // have to look at dozens of items to find one worth writing, so the
  // evaluation batch (RSS_EVAL_BATCH) is independent of the daily write cap,
  // and the write cap is passed to the pipeline as maxApprovals.
  const MAX_ITEMS_PER_CYCLE = Number(process.env.RSS_EVAL_BATCH) || 5;
  const maxApprovals = Math.min(globalRemaining, 10 - pendingCount);
  const maxItems = Math.min(MAX_ITEMS_PER_CYCLE, Math.max(0, 10 - pendingCount));

  if (maxItems <= 0 || maxApprovals <= 0) {
    return { created: 0, topics: [], globalRemaining };
  }

  // Fetch fresh RSS items from all configured feeds before processing
  log.info("[RSSScheduler] Fetching fresh RSS feed items...");
  try {
    await rssReader.fetchAllFeeds();
  } catch (err) {
    log.error("[RSSScheduler] Feed fetch failed, continuing with existing items:", err);
  }

  // Run the Gatekeeper pipeline — it fetches unprocessed RSS items,
  // evaluates them through Gate1, and queues octypo_write jobs
  const orchestrator = getGatekeeperOrchestrator();
  const stats = await orchestrator.runPipeline(maxItems, maxApprovals);

  log.info("[RSSScheduler] Cycle complete (Gatekeeper pipeline)", {
    itemsEvaluated: stats.itemsEvaluated,
    itemsApprovedForWriting: stats.itemsApprovedForWriting,
    itemsSkipped: stats.itemsSkipped,
    globalRemaining: globalRemaining - stats.itemsApprovedForWriting,
  });

  return {
    created: stats.itemsApprovedForWriting,
    topics: [], // Gatekeeper handles topic assignment internally
    globalRemaining: globalRemaining - stats.itemsApprovedForWriting,
  };
}

// ============================================
// PUBLIC API
// ============================================

export function startRSSScheduler(config?: Partial<RSSSchedulerConfig>): void {
  if (schedulerInterval) {
    stopRSSScheduler();
  }

  currentConfig = { ...DEFAULT_CONFIG, ...config };

  log.info("[RSSScheduler] Starting scheduler", {
    dailyLimitPerTopic: currentConfig.dailyLimitPerTopic,
    globalDailyLimit: currentConfig.globalDailyLimit,
    intervalMinutes: currentConfig.intervalMinutes,
  });

  // Run immediately (advisory-locked so only one replica runs each tick)
  withTickLock(TICK_LOCKS.rss, runSchedulerCycle).catch(err => {
    log.error("[RSSScheduler] Initial cycle failed:", err);
  });

  // Schedule recurring runs
  schedulerInterval = setInterval(
    () =>
      withTickLock(TICK_LOCKS.rss, runSchedulerCycle).catch(err => {
        log.error("[RSSScheduler] Scheduled cycle failed:", err);
      }),
    currentConfig.intervalMinutes * 60 * 1000
  );
}

export function stopRSSScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    log.info("[RSSScheduler] Scheduler stopped");
  }
}

export function updateRSSSchedulerConfig(config: Partial<RSSSchedulerConfig>): void {
  const wasEnabled = currentConfig.enabled;
  currentConfig = { ...currentConfig, ...config };

  log.info(`[RSSScheduler] Config updated: ${JSON.stringify(currentConfig)}`);

  if (config.enabled === false && wasEnabled) {
    stopRSSScheduler();
  } else if (config.enabled === true && !wasEnabled) {
    startRSSScheduler(currentConfig);
  }
}

export function getRSSSchedulerStatus(): {
  running: boolean;
  config: RSSSchedulerConfig;
} {
  return {
    running: schedulerInterval !== null,
    config: { ...currentConfig },
  };
}

export async function getSchedulerStats(): Promise<{
  totalToday: number;
  perTopic: TopicCounts;
  globalRemaining: number;
  perTopicRemaining: TopicCounts;
}> {
  const totalToday = await getTodaysTotalCount();
  const perTopic = await getTodaysCountsPerTopic();

  const perTopicRemaining: TopicCounts = {};
  for (const [topic, count] of Object.entries(perTopic)) {
    perTopicRemaining[topic] = Math.max(0, currentConfig.dailyLimitPerTopic - count);
  }

  return {
    totalToday,
    perTopic,
    globalRemaining: Math.max(0, currentConfig.globalDailyLimit - totalToday),
    perTopicRemaining,
  };
}

export async function manualTrigger(): Promise<{
  created: number;
  topics: string[];
  globalRemaining: number;
}> {
  return runSchedulerCycle();
}

/**
 * Force-trigger the pipeline bypassing the pending-jobs throttle.
 * Use from admin dashboard when backlog is being cleared.
 */
export async function forceTrigger(maxItems: number = 10): Promise<{
  created: number;
  topics: string[];
  globalRemaining: number;
}> {
  if (!currentConfig.enabled) {
    return { created: 0, topics: [], globalRemaining: currentConfig.globalDailyLimit };
  }

  const totalToday = await getTodaysTotalCount();
  const globalRemaining = Math.max(0, currentConfig.globalDailyLimit - totalToday);

  if (globalRemaining <= 0) {
    return { created: 0, topics: [], globalRemaining: 0 };
  }

  const orchestrator = getGatekeeperOrchestrator();
  const stats = await orchestrator.runPipeline(maxItems, globalRemaining);

  log.info("[RSSScheduler] Force-trigger complete", {
    itemsEvaluated: stats.itemsEvaluated,
    itemsApprovedForWriting: stats.itemsApprovedForWriting,
    itemsSkipped: stats.itemsSkipped,
  });

  return {
    created: stats.itemsApprovedForWriting,
    topics: [],
    globalRemaining: globalRemaining - stats.itemsApprovedForWriting,
  };
}
