/**
 * Fleet status — the one cheap, read-only answer the fleet monitor polls.
 *
 * `/api/admin/fleet-status` (behind requireAdmin) reports what /health and
 * /api/pipeline/status between them do NOT: the cost ceiling state and whether
 * anything was published in the last 7 days. Polled every 15 minutes per
 * install, so everything here must stay count-and-state cheap.
 *
 * "Nothing published in 7 days" on its own is NOT a fault, and reporting it as
 * one taught everybody to ignore the log. An install on a drip schedule can sit
 * quiet for weeks by design, with hundreds of articles queued and a deliberate
 * gap before the next one. What IS a fault is an article whose publish time has
 * PASSED and which is still sitting there, so both numbers are reported and the
 * monitor can tell the two apart.
 *
 * Dependencies are injected so the logic is testable without a live Postgres;
 * the real wiring lives in admin.ts.
 */

import type { Request, Response } from "express";

export const PUBLISHED_WINDOW_DAYS = 7;
export const HELD_AFTER_HOURS = 24;

/** The publishedAt cutoff for the "still alive?" window. */
export function publishedCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - PUBLISHED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export interface FleetStatusDeps {
  getBuildInfo(): { sha: string; builtAt: string };
  /** select-1 probe, same contract as /health: returns false, never throws. */
  probeDb(): Promise<boolean>;
  ceilingState(): { tripped: boolean; spentUsd: number; capUsd: number };
  /** COUNT of published contents with publishedAt >= cutoff. */
  countPublishedSince(cutoff: Date): Promise<number>;
  /** The soonest still-unpublished scheduledFor, or null if nothing is queued. */
  nextScheduledAt(): Promise<Date | null>;
  /** COUNT of scheduled contents whose time has passed and which are still not published. */
  countOverdueScheduled(now: Date): Promise<number>;
  /**
   * COUNT of articles sitting in review, untouched since the cutoff. A review
   * loop finishes in minutes; a day later the article is waiting for a person.
   * Optional for older callers.
   */
  countHeldSince?(cutoff: Date): Promise<number>;
  /** Does the configuration match the live site? Cached by the implementation; optional for older callers. */
  siteCheck?(): Promise<SiteCheckSummary>;
}

export interface SiteCheckSummary {
  siteUrl: string | null;
  articlePathPrefix: string;
  sitemapOk: boolean;
  prefixOk: boolean;
  observedPrefixes: string[];
  pageCount: number;
  checkedAt: string;
  error: string;
}

export interface FleetStatusPayload {
  version: string;
  builtAt: string;
  db: boolean;
  ceiling: { tripped: boolean; spentUsd: number; capUsd: number };
  publishedLast7d: number;
  /** ISO, or null. Quiet WITH something queued is a healthy drip, not a stall. */
  nextScheduledAt: string | null;
  /** Above zero means the schedule is being missed — that one is a real fault. */
  overdueScheduled: number;
  /**
   * Articles held in review for more than a day. Written articles can sit
   * there unnoticed while the site shows far fewer, so this is reported.
   */
  heldInReview?: number;
  /**
   * Whether the install's article path matches the site it publishes to.
   * `prefixOk: false` means every liveness check and IndexNow ping is aimed at
   * a URL that does not exist — a configuration fault, fixed by an operator.
   */
  site?: SiteCheckSummary;
}

export async function buildFleetStatus(deps: FleetStatusDeps): Promise<FleetStatusPayload> {
  const build = deps.getBuildInfo();
  const now = new Date();
  const [db, publishedLast7d, next, overdueScheduled, site, heldInReview] = await Promise.all([
    deps.probeDb(),
    deps.countPublishedSince(publishedCutoff(now)),
    deps.nextScheduledAt(),
    deps.countOverdueScheduled(now),
    // A site check that throws must not take the whole status down with it.
    deps.siteCheck ? deps.siteCheck().catch(() => undefined) : Promise.resolve(undefined),
    deps.countHeldSince
      ? deps.countHeldSince(new Date(now.getTime() - HELD_AFTER_HOURS * 3600 * 1000)).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const ceiling = deps.ceilingState();
  return {
    version: build.sha,
    builtAt: build.builtAt,
    db,
    ceiling: { tripped: ceiling.tripped, spentUsd: ceiling.spentUsd, capUsd: ceiling.capUsd },
    publishedLast7d,
    nextScheduledAt: next ? next.toISOString() : null,
    overdueScheduled,
    ...(heldInReview !== undefined ? { heldInReview } : {}),
    ...(site ? { site } : {}),
  };
}

/** Express handler factory. Mount behind requireAdmin. */
export function fleetStatusHandler(deps: FleetStatusDeps) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await buildFleetStatus(deps));
    } catch {
      res.status(500).json({ error: "Failed to build fleet status" });
    }
  };
}
