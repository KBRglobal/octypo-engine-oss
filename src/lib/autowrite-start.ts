/**
 * Hold the writing schedulers until a set day.
 *
 * A client can start with a hand-made reserve (thirty scheduled articles, one a
 * day) and only then let the engine write on its own. AUTOWRITE_START_DATE
 * (ISO date or datetime) delays the idea-bank and RSS schedulers until then,
 * so nobody has to remember to flip a flag on day 31. Publishing of already
 * scheduled articles is not affected.
 */

import { logger } from "./logger.js";

// setTimeout overflows above ~24.8 days; long waits are chained.
const MAX_DELAY_MS = 2_147_000_000;

export function autowriteDelayMs(now: Date = new Date(), raw = process.env.AUTOWRITE_START_DATE): number {
  const value = raw?.trim();
  if (!value) return 0;
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) {
    logger.warn({ value }, "[Engine] AUTOWRITE_START_DATE is not a date — ignoring it");
    return 0;
  }
  return Math.max(0, start.getTime() - now.getTime());
}

export function afterAutowriteStart(label: string, start: () => void): void {
  const wait = autowriteDelayMs();
  if (wait === 0) {
    start();
    logger.info(`[Engine] ${label} started`);
    return;
  }
  logger.info({ startsAt: process.env.AUTOWRITE_START_DATE }, `[Engine] ${label} waits for AUTOWRITE_START_DATE`);
  const tick = () => {
    const left = autowriteDelayMs();
    if (left > 0) {
      setTimeout(tick, Math.min(left, MAX_DELAY_MS)).unref?.();
      return;
    }
    start();
    logger.info(`[Engine] ${label} started (AUTOWRITE_START_DATE reached)`);
  };
  setTimeout(tick, Math.min(wait, MAX_DELAY_MS)).unref?.();
}
