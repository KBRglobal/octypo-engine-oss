/**
 * The safety net under the publish webhook.
 *
 * A dropped webhook is silent — the article is live in the engine, the blog's
 * edge cache still holds the old listing, and nothing anywhere reports it. So
 * the webhook is the fast path and this is the floor: every five minutes, ask
 * the engine what changed since the last watermark and purge those tags.
 *
 * The watermark is a timestamp, not a cursor, because it has to survive across
 * runs and across a redeploy of the Worker. Cursors are per-page state; the
 * watermark is the durable one.
 */

import { isTombstone, type SyncItem } from './engine-client';

export interface ReconcileResult {
  /** Cache tags to purge, deduplicated. */
  tags: string[];
  /** Slugs whose pages must disappear (unpublished or deleted). */
  removedSlugs: string[];
  /** Slugs that changed and are still live. */
  changedSlugs: string[];
  /** The `updatedSince` value for the next run. */
  watermark: string | null;
}

/**
 * Overlap the next window by a second. Two rows can share `updatedAt` and land
 * on either side of a run boundary; re-purging one tag costs nothing, missing
 * one leaves a customer's article invisible until the next edit.
 */
const WATERMARK_OVERLAP_MS = 1000;

export function reconcile(
  items: SyncItem[],
  tenantSlug: string,
  previousWatermark: string | null
): ReconcileResult {
  const tags = new Set<string>();
  const removed: string[] = [];
  const changed: string[] = [];
  // Only a row actually seen in this window may move the watermark. Rewinding
  // the previous value on an empty window would walk it backwards a second per
  // run, so the reconcile window would grow without bound.
  let observedMax = Number.NaN;

  for (const item of items) {
    const parsed = Date.parse(item.updatedAt);
    if (Number.isFinite(parsed)) {
      observedMax = Number.isFinite(observedMax) ? Math.max(observedMax, parsed) : parsed;
    }

    tags.add(`article:${tenantSlug}:${item.slug}`);
    if (isTombstone(item)) removed.push(item.slug);
    else changed.push(item.slug);
  }

  // Any change at all reorders the index, the sitemap and the feed.
  if (items.length > 0) tags.add(`listing:${tenantSlug}`);

  return {
    tags: [...tags],
    removedSlugs: [...new Set(removed)],
    changedSlugs: [...new Set(changed)],
    watermark: nextWatermark(observedMax, previousWatermark),
  };
}

function nextWatermark(observedMax: number, previous: string | null): string | null {
  if (!Number.isFinite(observedMax)) return previous;
  const candidate = observedMax - WATERMARK_OVERLAP_MS;
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  // Never go backwards: a late row with an old timestamp must not re-open a
  // window that has already been reconciled.
  const next = Number.isFinite(previousMs) ? Math.max(candidate, previousMs) : candidate;
  return new Date(next).toISOString();
}
