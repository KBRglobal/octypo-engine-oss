import { describe, it, expect } from "vitest";

import { DEFAULT_QUALITY_GATE_CONFIG } from "../config.js";
import { referencedYears, scoreTitleFreshness } from "./title-freshness.js";

const now = new Date("2026-09-15T08:00:00Z");
const config = DEFAULT_QUALITY_GATE_CONFIG;

describe("referencedYears", () => {
  it("collapses a season range to its last year", () => {
    expect(referencedYears("Lantern Park is back: when does the 2025-2026 season open")).toEqual([2026]);
    expect(referencedYears("Season 2025/26 dates")).toEqual([2026]);
    expect(referencedYears("Season 2025–2026")).toEqual([2026]);
  });

  it("reads single years", () => {
    expect(referencedYears("Northport Comedy Festival 2026 line-up")).toEqual([2026]);
  });

  it("ignores numbers that are not years, and history", () => {
    expect(referencedYears("Top 10 restaurants, 1200 euros per night, 2000 words", now)).toEqual([]);
    expect(referencedYears("Northport in 1998: how the city looked", now)).toEqual([]);
  });
});

describe("scoreTitleFreshness", () => {
  it("holds the live defect: a 2025-2026 season title in September 2026 passes (the season ends in 2026)", () => {
    // The range's last year equals the current year, so the season is still
    // current by the calendar alone; the CONTENT check (source-primary /
    // the model's clock) handles whether it actually ended. What must never
    // pass is a range that ended last year.
    const r = scoreTitleFreshness({ title: "When does the 2025-2026 season open", now }, config);
    expect(r.status).toBe("pass");
  });

  it("blocks a title whose year is already over", () => {
    const r = scoreTitleFreshness({ title: "Lantern Park 2024-2025 opening dates", now }, config);
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.details[0]).toContain("2025");
  });

  it("checks the meta title too", () => {
    const r = scoreTitleFreshness({ title: "Lantern Park dates", metaTitle: "Lantern Park 2025 dates", now }, config);
    expect(r.status).toBe("fail");
    expect(r.details[0]).toContain("metaTitle");
  });

  it("passes a title without a year", () => {
    const r = scoreTitleFreshness({ title: "How to get a Northport parking permit", now }, config);
    expect(r.status).toBe("pass");
    expect(r.details[0]).toContain("no year");
  });

  it("passes next year's edition", () => {
    const r = scoreTitleFreshness({ title: "Expo 2027 tickets", now }, config);
    expect(r.status).toBe("pass");
  });
});
