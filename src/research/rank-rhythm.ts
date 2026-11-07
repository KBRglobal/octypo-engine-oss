/**
 * When a rankings reading is due.
 *
 * Kept apart from the tracker because the tracker imports the database, and
 * the database refuses to load without a connection string — so the one rule
 * worth testing without a database lives here, where a test can reach it.
 */

const DAY = 86_400_000;

/** A reading is fresh for this long; the tracker measures again after it. */
export const MEASURE_EVERY_MS = 30 * DAY;

/**
 * Never two readings in a month by accident: each one is a purchase, and a
 * client's "where were we last month" needs the months to be a month apart.
 */
export function isDue(last: Date | null, now: Date): boolean {
  return !last || now.getTime() - last.getTime() >= MEASURE_EVERY_MS;
}
