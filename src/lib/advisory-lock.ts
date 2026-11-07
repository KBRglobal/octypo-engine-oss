/**
 * Distributed tick lock — lets the engine run safely on more than one replica.
 *
 * Each periodic scheduler tick is wrapped so that, across all replicas, only the
 * one that grabs the Postgres advisory lock runs the tick that round; the others
 * skip it. Without this, N replicas would each fetch the same feeds and publish
 * the same articles N times.
 *
 * Uses a transaction-scoped lock (`pg_try_advisory_xact_lock`), which Postgres
 * releases automatically on commit/rollback — so the lock can never leak, even if
 * the tick throws or the replica dies mid-tick. It is non-blocking: a replica that
 * doesn't get the lock returns immediately instead of queueing.
 */

import { client } from "../db.js";

// Distinct, stable lock IDs. Arbitrary — they only must not collide across ticks.
export const TICK_LOCKS = {
  rss: 918001,
  library: 918002,
  publish: 918003,
  ideaScheduler: 918004,
  rankTracker: 918005,
  growthPlanner: 918006,
  octyGate: 918007,
} as const;

export async function withTickLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const result = await client.begin(async (sql) => {
    const rows = await sql<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(${key}) as locked`;
    if (!rows[0]?.locked) return undefined; // another replica owns this tick — skip
    return await fn();
  });
  return result as T | undefined;
}
