import { describe, expect, it } from "vitest";

import { estimateUsd, findPrice } from "./prices.js";

/**
 * Shaped like the real rate card, including the part that makes this awkward:
 * the card drops the segments it does not price separately, and which ones
 * those are differs per family. `serp` prices `live.advanced` with no
 * `google/organic` in between; `keywords_data` keeps every segment.
 */
const CARD = {
  dataforseo_labs: {
    ranked_keywords: {
      live: {
        priority_normal: [
          { cost_type: "per_result", cost: 0.00012 },
          { cost_type: "per_request", cost: 0.012 },
        ],
      },
    },
  },
  serp: {
    live: {
      advanced: { priority_normal: [{ cost_type: "per_request", cost: 0.002 }] },
    },
  },
  keywords_data: {
    google_ads: {
      search_volume: {
        live: { priority_normal: [{ cost_type: "per_request", cost: 0.09 }] },
      },
    },
  },
};

describe("findPrice", () => {
  it("steps over the segments the rate card does not price", () => {
    expect(findPrice(CARD, "/dataforseo_labs/google/ranked_keywords/live")).toEqual({
      perRequestUsd: 0.012,
      perResultUsd: 0.00012,
    });
    expect(findPrice(CARD, "/serp/google/organic/live/advanced")).toEqual({
      perRequestUsd: 0.002,
      perResultUsd: 0,
    });
  });

  it("reads a path the card keeps in full", () => {
    expect(findPrice(CARD, "/keywords_data/google_ads/search_volume/live")).toEqual({
      perRequestUsd: 0.09,
      perResultUsd: 0,
    });
  });

  it("reports null for an endpoint the card does not price", () => {
    expect(findPrice(CARD, "/business_data/google/reviews/live")).toBeNull();
    expect(findPrice({}, "/serp/google/organic/live/advanced")).toBeNull();
  });
});

describe("estimateUsd", () => {
  it("charges the request once and the rows each", () => {
    expect(estimateUsd(CARD, "/dataforseo_labs/google/ranked_keywords/live", 100)).toBeCloseTo(
      0.024,
      6
    );
  });

  it("stays null rather than guessing when the price is unknown", () => {
    expect(estimateUsd(CARD, "/on_page/instant_pages", 10)).toBeNull();
  });
});
