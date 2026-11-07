/**
 * Database-backed job queue for background processing
 * Handles tasks like translation, AI generation, email sending
 * Persists jobs to PostgreSQL for reliability
 */

import { randomUUID, randomInt } from "node:crypto";
import { db } from "./db.js";
import { backgroundJobs } from "./schema/index.js";
import { eq, desc, and, lt, lte, or, isNull, inArray, count } from "drizzle-orm";

/** A processing job older than this is treated as abandoned by a dead replica. */
const STUCK_JOB_MS = 10 * 60 * 1000;
import { safeLogValue } from "./lib/safe-error.js";
import { nextAttemptAt } from "./lib/backoff.js";
import { logger } from "./lib/logger.js";

export type JobStatus = "pending" | "processing" | "completed" | "failed";
export type JobType =
  | "ai_generate"
  | "octypo_write"
  | "octypo_rewrite"
  | "gatekeeper_review"
  | "gatekeeper_revision"
  | "gatekeeper_queued"
  | "library_extract_ideas"
  | "library_write"
  | "regenerate_image"
  | "render_article_video"
  | "idea_write"
  | "backfill_meta";

export interface Job<T = unknown> {
  id: string;
  type: JobType;
  status: JobStatus;
  data: T;
  result?: unknown;
  error?: string;
  retries: number;
  maxRetries: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  priority: number;
}

type JobHandler<T = unknown> = (data: T) => Promise<unknown>;

// Helper to convert DB row to Job type
function dbToJob(row: typeof backgroundJobs.$inferSelect): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    data: row.data,
    result: row.result || undefined,
    error: row.error || undefined,
    retries: row.retries,
    maxRetries: row.maxRetries,
    createdAt: row.createdAt,
    startedAt: row.startedAt || undefined,
    completedAt: row.completedAt || undefined,
    priority: row.priority,
  };
}

class JobQueue {
  private readonly handlers: Map<JobType, JobHandler> = new Map();
  private readonly processing: Set<string> = new Set();
  private readonly maxConcurrent: number = 5;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private reaperIntervalId: NodeJS.Timeout | null = null;
  private lastProcessedAt: Date | null = null;
  private lastTickAt: Date | null = null;

  /**
   * Register a handler for a job type
   */
  registerHandler<T>(type: JobType, handler: JobHandler<T>) {
    this.handlers.set(type, handler as JobHandler);
  }

  /**
   * Add a job to the queue
   */
  async addJob<T extends Record<string, unknown>>(
    type: JobType,
    data: T,
    options?: { priority?: number; maxRetries?: number }
  ): Promise<string> {
    const [job] = await db
      .insert(backgroundJobs)
      .values({
        type,
        status: "pending",
        data,
        retries: 0,
        maxRetries: options?.maxRetries ?? 3,
        priority: options?.priority ?? 0,
      } as any)
      .returning();

    return job.id;
  }

  /**
   * Synchronous add (for backward compatibility) - queues async insert
   */
  addJobSync<T extends Record<string, unknown>>(
    type: JobType,
    data: T,
    options?: { priority?: number; maxRetries?: number }
  ): string {
    const id = `${type}-${Date.now()}-${randomUUID().slice(0, 9)}`;

    // Insert async
    db.insert(backgroundJobs)
      .values({
        id,
        type,
        status: "pending",
        data,
        retries: 0,
        maxRetries: options?.maxRetries ?? 3,
        priority: options?.priority ?? 0,
      } as any)
      .then(() => {})
      .catch(err => {
        console.error(`[JobQueue] Failed to insert job ${safeLogValue(id)}:`, err);
      });

    return id;
  }

  /**
   * Get job status
   */
  async getJob(id: string): Promise<Job | undefined> {
    const [row] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).limit(1);

    return row ? dbToJob(row) : undefined;
  }

  /**
   * Get all jobs by status
   */
  async getJobsByStatus(status: JobStatus): Promise<Job[]> {
    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, status))
      .orderBy(desc(backgroundJobs.priority), backgroundJobs.createdAt);

    return rows.map(dbToJob);
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    total: number;
  }> {
    const [pending] = await db
      .select({ count: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, "pending"));

    const [processing] = await db
      .select({ count: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, "processing"));

    const [completed] = await db
      .select({ count: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, "completed"));

    const [failed] = await db
      .select({ count: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, "failed"));

    const total =
      (pending?.count || 0) +
      (processing?.count || 0) +
      (completed?.count || 0) +
      (failed?.count || 0);

    return {
      pending: pending?.count || 0,
      processing: processing?.count || 0,
      completed: completed?.count || 0,
      failed: failed?.count || 0,
      total,
    };
  }

  /**
   * Get recent jobs (for admin dashboard)
   */
  async getRecentJobs(limit: number = 20): Promise<Job[]> {
    const rows = await db
      .select()
      .from(backgroundJobs)
      .orderBy(desc(backgroundJobs.createdAt))
      .limit(limit);

    return rows.map(dbToJob);
  }

  /**
   * Start processing jobs
   */
  private startProcessing() {
    if (this.isRunning) return;

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.lastTickAt = new Date();
      this.processNext();
    }, 1000);

    // The stuck-job reaper runs on its OWN timer. It used to be invoked from
    // inside processNext with a 2% chance, but only after a job had been
    // claimed — so when every job was stuck in "processing" nothing was
    // claimed, the reaper never ran, and the queue stayed dead exactly in the
    // failure mode the reaper exists for.
    this.reaperIntervalId = setInterval(() => {
      this.resetStuckJobs();
    }, 60_000);

    // Recover any stuck "processing" jobs on startup
    this.recoverStuckJobs();
  }

  /**
   * Recover jobs a crashed instance left mid-flight.
   *
   * Resets only jobs whose lock has expired — a job still being worked by a
   * live sibling replica has a fresh `updatedAt` and is left alone. Resetting
   * ALL processing rows would double-run whatever the other replica is doing.
   */
  private async recoverStuckJobs() {
    try {
      const staleBefore = new Date(Date.now() - STUCK_JOB_MS);
      const result = await db
        .update(backgroundJobs)
        .set({ status: "pending" } as any)
        .where(
          and(
            eq(backgroundJobs.status, "processing"),
            lt(backgroundJobs.startedAt, staleBefore)
          )
        )
        .returning();

      if (result.length > 0) {
        /* Stale processing jobs reset to pending */
      }
    } catch {
      void 0;
    }
  }

  /**
   * Detect and reset jobs stuck in "processing" for > 8 minutes.
   * These are jobs whose handler crashed without cleanup.
   * Called periodically from the processing loop.
   */
  private async resetStuckJobs() {
    try {
      const stuckThreshold = new Date(Date.now() - 8 * 60 * 1000); // 8 minutes ago

      // Reclaiming counts as a failed attempt. Without this a job that reliably
      // crashes the process is reset forever, re-running paid work each time.
      const stuck = await db
        .select()
        .from(backgroundJobs)
        .where(
          and(eq(backgroundJobs.status, "processing"), lt(backgroundJobs.startedAt, stuckThreshold))
        );

      for (const job of stuck) {
        const retries = job.retries + 1;
        if (retries < job.maxRetries) {
          await db
            .update(backgroundJobs)
            .set({ status: "pending", retries, nextAttemptAt: nextAttemptAt(retries) } as any)
            .where(eq(backgroundJobs.id, job.id));
        } else {
          await db
            .update(backgroundJobs)
            .set({
              status: "failed",
              retries,
              error: "Job exceeded its runtime and ran out of retries",
              completedAt: new Date(),
            } as any)
            .where(eq(backgroundJobs.id, job.id));
        }
      }

      if (stuck.length > 0) {
        logger.warn({ count: stuck.length }, "[JobQueue] Reclaimed stuck job(s)");
      }
    } catch {
      void 0;
    }
  }

  /**
   * Start job processing (public method)
   */
  start() {
    this.startProcessing();
  }

  /**
   * Stop processing jobs
   */
  stopProcessing() {
    if (this.reaperIntervalId) {
      clearInterval(this.reaperIntervalId);
      this.reaperIntervalId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  /**
   * Process next available job
   */
  private async processNext() {
    if (this.processing.size >= this.maxConcurrent) return;

    try {
      // Get next pending job (highest priority first)
      const [jobRow] = await db
        .select()
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.status, "pending"),
            // NULL means "eligible now"; a scheduled retry waits its turn.
            or(
              isNull(backgroundJobs.nextAttemptAt),
              lte(backgroundJobs.nextAttemptAt, new Date())
            )
          )
        )
        .orderBy(desc(backgroundJobs.priority), backgroundJobs.createdAt)
        .limit(1);

      if (!jobRow) return;

      const handler = this.handlers.get(jobRow.type as JobType);
      if (!handler) {
        // Returning here used to leave the row pending. Since the claim query
        // takes exactly one row ordered by priority, a single job with no
        // registered handler blocked the entire queue permanently and silently —
        // a paying client simply stopped receiving articles. Fail it instead.
        logger.error(
          { jobId: jobRow.id, type: jobRow.type },
          "[JobQueue] No handler registered for job type — failing it so the queue keeps moving"
        );
        await db
          .update(backgroundJobs)
          .set({
            status: "failed",
            error: `No handler registered for job type "${jobRow.type}"`,
            completedAt: new Date(),
          } as any)
          .where(eq(backgroundJobs.id, jobRow.id));
        return;
      }

      // Atomically claim the job: the UPDATE only succeeds if it is STILL pending.
      // Across multiple replicas this is a compare-and-swap — the loser's update
      // matches zero rows, so it backs off instead of double-processing the job.
      const claimed = await db
        .update(backgroundJobs)
        .set({ status: "processing", startedAt: new Date() } as any)
        .where(and(eq(backgroundJobs.id, jobRow.id), eq(backgroundJobs.status, "pending")))
        .returning({ id: backgroundJobs.id });

      if (claimed.length === 0) return; // another worker/replica claimed it first

      this.processing.add(jobRow.id);

      try {
        const result = await handler(jobRow.data);

        await db
          .update(backgroundJobs)
          .set({
            status: "completed",
            result: result as Record<string, unknown>,
            completedAt: new Date(),
          } as any)
          .where(eq(backgroundJobs.id, jobRow.id));

        this.lastProcessedAt = new Date();
      } catch (error) {
        const newRetries = jobRow.retries + 1;

        if (newRetries < jobRow.maxRetries) {
          // Retry, but not instantly — see src/lib/backoff.ts for why.
          const retryAt = nextAttemptAt(newRetries);
          logger.warn(
            { jobId: jobRow.id, type: jobRow.type, retries: newRetries, retryAt },
            "[JobQueue] Job failed — scheduling retry with backoff"
          );
          await db
            .update(backgroundJobs)
            .set({ status: "pending", retries: newRetries, nextAttemptAt: retryAt } as any)
            .where(eq(backgroundJobs.id, jobRow.id));
        } else {
          // Failed permanently
          await db
            .update(backgroundJobs)
            .set({
              status: "failed",
              retries: newRetries,
              error: error instanceof Error ? error.message : String(error),
              completedAt: new Date(),
            } as any)
            .where(eq(backgroundJobs.id, jobRow.id));
        }
      } finally {
        this.processing.delete(jobRow.id);
      }

      // Clean up old completed/failed jobs periodically (1% chance each run)
      if (randomInt(0, 100) === 0) {
        await this.cleanup();
      }

    } catch {
      void 0;
    }
  }

  /**
   * Clean up old jobs to prevent DB bloat
   */
  private async cleanup() {
    const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days old

    try {
      const result = await db
        .delete(backgroundJobs)
        .where(
          and(
            inArray(backgroundJobs.status, ["completed", "failed"]),
            lt(backgroundJobs.completedAt, cutoffDate)
          )
        )
        .returning();

      if (result.length > 0) {
        /* Old completed/failed jobs cleaned up */
      }
    } catch {
      void 0;
    }
  }

  /**
   * Cancel a pending job
   */
  async cancelJob(id: string): Promise<boolean> {
    const result = await db
      .delete(backgroundJobs)
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "pending")))
      .returning();

    if (result.length > 0) {
      return true;
    }
    return false;
  }

  /**
   * Retry a failed job
   */
  async retryJob(id: string): Promise<boolean> {
    const result = await db
      .update(backgroundJobs)
      .set({
        status: "pending",
        retries: 0,
        error: null,
        completedAt: null,
      } as any)
      .where(and(eq(backgroundJobs.id, id), eq(backgroundJobs.status, "failed")))
      .returning();

    if (result.length > 0) {
      return true;
    }
    return false;
  }
}

// Singleton instance
export const jobQueue = new JobQueue();

/**
 * Get queue health status for sanity checks
 */
export function getQueueHealth(): {
  isRunning: boolean;
  available: boolean;
  lastProcessedAt: string | null;
  lastTickAt: string | null;
} {
  return {
    isRunning: (jobQueue as any).isRunning || false,
    available: !!jobQueue,
    lastProcessedAt: (jobQueue as any).lastProcessedAt?.toISOString() || null,
    lastTickAt: (jobQueue as any).lastTickAt?.toISOString() || null,
  };
}

// Export types for handlers
export interface AiGenerateJobData {
  type: string;
  topic: string;
  keywords?: string[];
  priority?: number;
}
