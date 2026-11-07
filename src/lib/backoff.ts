/**
 * Retry backoff for the durable job queue.
 *
 * The queue previously re-queued a failed job as `pending` with no delay, and the
 * scheduler polls every second — so a job failing for a systemic reason (a
 * provider outage, a malformed response) retried immediately, three times, each
 * attempt a full paid article generation. Combined with the engine registry
 * resetting every provider to healthy when all are tripped, that is a hot loop
 * against paid APIs.
 *
 * Exponential with full jitter: jitter matters because multiple replicas fail at
 * the same moment and would otherwise retry in lockstep.
 */

const BASE_MS = 30_000;
const MAX_MS = 30 * 60_000;

export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const ceiling = Math.min(BASE_MS * 2 ** (safeAttempt - 1), MAX_MS);
  // Full jitter, but never less than a second — a "retry" that fires instantly
  // is the bug this module exists to prevent.
  return Math.max(1_000, Math.floor(ceiling * random()));
}

export function nextAttemptAt(
  attempt: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffMs(attempt, random));
}

export { BASE_MS, MAX_MS };
