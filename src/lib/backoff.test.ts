import { describe, it, expect } from 'vitest';
import { backoffMs, nextAttemptAt, MAX_MS } from './backoff.js';

describe('retry backoff', () => {
  it('never returns an instant retry', () => {
    // The original bug: a failed job went straight back to "pending" and the
    // 1s poll picked it up immediately, re-running a paid generation.
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(backoffMs(attempt, () => 0)).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('grows exponentially with the attempt number', () => {
    const full = () => 1; // no jitter, take the ceiling
    expect(backoffMs(1, full)).toBe(30_000);
    expect(backoffMs(2, full)).toBe(60_000);
    expect(backoffMs(3, full)).toBe(120_000);
  });

  it('is capped so a job cannot be parked for hours', () => {
    expect(backoffMs(50, () => 1)).toBe(MAX_MS);
  });

  it('applies jitter so replicas do not retry in lockstep', () => {
    const low = backoffMs(5, () => 0.1);
    const high = backoffMs(5, () => 0.9);
    expect(low).toBeLessThan(high);
  });

  it('tolerates nonsense attempt numbers rather than throwing', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(backoffMs(bad, () => 1)).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('schedules into the future', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(nextAttemptAt(1, now, () => 1).getTime()).toBe(now.getTime() + 30_000);
  });
});
