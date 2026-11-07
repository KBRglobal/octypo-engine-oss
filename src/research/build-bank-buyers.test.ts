import { describe, expect, it } from "vitest";

import { onlyBuyers } from "./bank-buyers.js";
import type { KeywordMetrics } from "./keyword-data.js";

const phrase = (keyword: string, searchVolume: number): KeywordMetrics => ({
  keyword,
  searchVolume,
  competition: null,
  cpc: null,
});

/**
 * Measured on the first client this ran for: 17 of the 40 phrases the provider
 * suggested for "event production" were job seekers and students. Ranked on
 * volume alone they sat near the top of the bank, and the engine would have
 * written a job-listings page for a company that is not hiring.
 */
describe("onlyBuyers", () => {
  it("keeps the customers and drops everyone else before they become articles", () => {
    const kept = onlyBuyers(
      [
        phrase("corporate event production", 880),
        phrase("event production jobs", 140),
        phrase("event production course", 210),
        phrase("event production company", 590),
      ],
      "events"
    );
    expect(kept.map((row) => row.keyword)).toEqual(["corporate event production", "event production company"]);
  });

  it("leaves a clean list untouched", () => {
    const rows = [phrase("led screens for events", 210), phrase("conference production", 320)];
    expect(onlyBuyers(rows, "events")).toEqual(rows);
  });
});
