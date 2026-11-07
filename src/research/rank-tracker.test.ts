import { describe, expect, it } from "vitest";

import { isDue, MEASURE_EVERY_MS } from "./rank-rhythm.js";

/**
 * The rhythm is the whole point: a reading every month, on its own, and
 * never two in a month by accident — each one is a purchase, and a client's
 * "where were we last month" needs the months to be a month apart.
 */
describe("isDue", () => {
  const now = new Date("2026-09-18T10:00:00Z");

  it("measures a fresh install that has never been read", () => {
    expect(isDue(null, now)).toBe(true);
  });

  it("waits while the last reading is younger than a month", () => {
    expect(isDue(new Date(now.getTime() - 10 * 86_400_000), now)).toBe(false);
    expect(isDue(new Date(now.getTime() - MEASURE_EVERY_MS + 1), now)).toBe(false);
  });

  it("measures again once a month has passed", () => {
    expect(isDue(new Date(now.getTime() - MEASURE_EVERY_MS), now)).toBe(true);
    expect(isDue(new Date(now.getTime() - 45 * 86_400_000), now)).toBe(true);
  });
});
