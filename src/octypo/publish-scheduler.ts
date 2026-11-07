/**
 * Publish scheduler — promotes `scheduled` articles to `published` once their
 * scheduledFor time has passed. Runs an in-process interval (one tick/minute).
 * Independent of the RSS drip: it only touches rows the editor explicitly
 * scheduled from the Review console.
 */

import { and, eq, isNull, lt, lte } from "drizzle-orm";

import { db } from "../db.js";
import { contents } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { publishContentById } from "./publish.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";
import { autoScheduleConfig, placeIntoCalendar } from "./auto-schedule.js";

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let lastRun: Date | null = null;
let lastPublished = 0;

/**
 * Auto-slot: any approved draft that nobody scheduled gets a calendar slot on
 * the next tick. This is the piece that makes the whole path autonomous — the
 * operator's only verb is "approve"; the calendar fills itself, randomised,
 * and the promote step below publishes on time. AUTO_SLOT_DRAFTS=false turns
 * it off for an install that wants manual slotting.
 */
async function autoSlotDrafts(): Promise<number> {
  if ((process.env.AUTO_SLOT_DRAFTS ?? "true").toLowerCase() === "false") return 0;

  const drafts = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "draft"), isNull(contents.scheduledFor)))
    .orderBy(contents.createdAt)
    .limit(20);
  if (drafts.length === 0) return 0;

  const config = autoScheduleConfig();
  const future = await db
    .select({ at: contents.scheduledFor })
    .from(contents)
    .where(eq(contents.status, "scheduled"));
  const calendar = future.map((row) => row.at).filter((at): at is Date => at !== null);

  let slotted = 0;
  for (const draft of drafts) {
    const slot = placeIntoCalendar(calendar, config);
    calendar.push(slot);
    await db
      .update(contents)
      .set({ status: "scheduled", scheduledFor: slot, updatedAt: new Date() })
      .where(and(eq(contents.id, draft.id), eq(contents.status, "draft")));
    slotted++;
  }
  logger.info({ slotted }, "[PublishScheduler] Auto-slotted approved drafts");
  return slotted;
}

/** Publish every `scheduled` article whose time has come. Returns count. */
export async function runPublishSchedulerTick(): Promise<number> {
  const now = new Date();

  // Recover articles a crash left mid-publish: a row stuck in 'publishing'
  // for over five minutes was abandoned, so return it to 'scheduled' and let
  // this tick pick it up. The publish claim is atomic, so a live publish in
  // progress will have a fresh updatedAt and is not touched.
  const staleClaim = new Date(now.getTime() - 5 * 60 * 1000);
  await db
    .update(contents)
    .set({ status: "scheduled", updatedAt: now })
    .where(and(eq(contents.status, "publishing"), lt(contents.updatedAt, staleClaim)));
  const due = await db
    .select({ id: contents.id, slug: contents.slug })
    .from(contents)
    .where(and(eq(contents.status, "scheduled"), lte(contents.scheduledFor, now)));

  let published = 0;
  for (const row of due) {
    try {
      const result = await publishContentById(row.id);
      if (result.ok) published += 1;
    } catch (error) {
      logger.error(
        { error, contentId: row.id, slug: row.slug },
        "[PublishScheduler] Failed to publish scheduled article"
      );
    }
  }

  lastRun = now;
  lastPublished = published;
  if (published > 0) {
    logger.info({ published }, "[PublishScheduler] Published scheduled articles");
  }
  return published;
}

export function startPublishScheduler(): void {
  if (timer) return;
  // Advisory-locked so only one replica publishes each tick.
  const tick = () =>
    withTickLock(TICK_LOCKS.publish, async () => {
      await autoSlotDrafts();
      return runPublishSchedulerTick();
    }).catch(err =>
      logger.error({ error: err }, "[PublishScheduler] Tick failed")
    );
  // Fire once shortly after boot, then on the interval.
  void tick();
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  logger.info("[PublishScheduler] started (1 tick/min)");
}

export function stopPublishScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("[PublishScheduler] stopped");
  }
}

export function getPublishSchedulerStatus(): {
  running: boolean;
  lastRun: string | null;
  lastPublished: number;
} {
  return {
    running: timer !== null,
    lastRun: lastRun ? lastRun.toISOString() : null,
    lastPublished,
  };
}
