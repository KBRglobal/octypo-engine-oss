import { describe, expect, it } from "vitest";

import {
  mapRows,
  toBacklinkSummaryRow,
  toCompetitorRow,
  toDomainOverviewRow,
  toIntersectionRow,
  toKeywordRow,
  toRankedKeywordRow,
  toSerpRow,
} from "./rows.js";

describe("toKeywordRow", () => {
  it("reads the nested shape the Labs endpoints use", () => {
    expect(
      toKeywordRow({
        keyword: "led truck advertising",
        keyword_info: { search_volume: 720, cpc: 4.2, competition: 0.31 },
        keyword_properties: { keyword_difficulty: 38 },
        search_intent_info: { main_intent: "commercial" },
      })
    ).toEqual({
      keyword: "led truck advertising",
      volume: 720,
      difficulty: 38,
      cpc: 4.2,
      competition: 0.31,
      intent: "commercial",
    });
  });

  it("unwraps the extra keyword_data level related_keywords adds", () => {
    const row = toKeywordRow({
      keyword_data: { keyword: "mobile billboard", keyword_info: { search_volume: 90 } },
      depth: 1,
    });
    expect(row?.keyword).toBe("mobile billboard");
    expect(row?.volume).toBe(90);
  });

  // A zero here would be a claim — "nobody searches this" — and phrases get
  // dropped from a plan on exactly that number. Absent must stay absent.
  it("keeps a missing number null rather than zero", () => {
    const row = toKeywordRow({ keyword: "a phrase nobody sells data for" });
    expect(row).toEqual({
      keyword: "a phrase nobody sells data for",
      volume: null,
      difficulty: null,
      cpc: null,
      competition: null,
      intent: null,
    });
  });

  it("drops a row with no keyword", () => {
    expect(toKeywordRow({ keyword_info: { search_volume: 10 } })).toBeNull();
    expect(toKeywordRow(null)).toBeNull();
  });
});

describe("toRankedKeywordRow", () => {
  it("takes the position and url out of the serp element", () => {
    const row = toRankedKeywordRow({
      keyword_data: { keyword: "wedding catering chicago", keyword_info: { search_volume: 210 } },
      ranked_serp_element: {
        serp_item: { rank_absolute: 4, url: "https://x.ae/catering", etv: 31.5 },
      },
    });
    expect(row).toMatchObject({ position: 4, url: "https://x.ae/catering", trafficEstimate: 31.5 });
  });
});

describe("toIntersectionRow", () => {
  // Named first/second on purpose: which side is "mine" depends on the order
  // the caller sent the domains in, and the gap tool sends the rival first.
  it("keeps both sides, in the endpoint's own order", () => {
    const row = toIntersectionRow({
      keyword_data: { keyword: "weekend meals", keyword_info: { search_volume: 140 } },
      first_domain_serp_element: { rank_absolute: 2, url: "https://rival.com/weekend" },
      second_domain_serp_element: null,
    });
    expect(row).toMatchObject({
      firstPosition: 2,
      firstUrl: "https://rival.com/weekend",
      secondPosition: null,
    });
  });
});

describe("toDomainOverviewRow", () => {
  it("builds the position buckets the endpoint has no field for", () => {
    const row = toDomainOverviewRow([
      {
        metrics: {
          organic: { count: 412, etv: 900.5, pos_1: 3, pos_2_3: 7, pos_4_10: 22 },
          paid: { count: 5 },
        },
      },
    ]);
    expect(row).toMatchObject({ organicKeywords: 412, top3: 10, top10: 32, paidKeywords: 5 });
  });

  it("reports null when the domain has no metrics at all", () => {
    expect(toDomainOverviewRow([])).toBeNull();
  });
});

describe("toBacklinkSummaryRow", () => {
  it("reads the summary endpoint's bare result", () => {
    const row = toBacklinkSummaryRow({
      target: "x.ae",
      rank: 142,
      backlinks: 903,
      referring_domains: 71,
      referring_main_domains: 64,
      broken_backlinks: 4,
      backlinks_spam_score: 12,
      referring_domains_nofollow: 12,
    });
    expect(row).toMatchObject({ backlinks: 903, referringDomains: 71, nofollowDomains: 12 });
  });

  it("reports null for a body that is not a summary", () => {
    expect(toBacklinkSummaryRow({ target: "x.ae" })).toBeNull();
  });
});

describe("toCompetitorRow and toSerpRow", () => {
  it("prefers the full-domain metrics a competitor row carries", () => {
    const row = toCompetitorRow({
      domain: "rival.com",
      intersections: 88,
      avg_position: 12.4,
      metrics: { organic: { count: 10, etv: 5 } },
      full_domain_metrics: { organic: { count: 2100, etv: 4300 } },
    });
    expect(row).toMatchObject({ organicKeywords: 2100, organicTraffic: 4300 });
  });

  it("keeps organic results and drops the ads and boxes", () => {
    const rows = mapRows(
      [
        { type: "paid", rank_absolute: 1, domain: "ads.com" },
        { type: "organic", rank_absolute: 2, domain: "real.com", url: "https://real.com/a" },
        { type: "people_also_ask", rank_absolute: 3 },
      ],
      toSerpRow
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position: 2, domain: "real.com" });
  });
});
