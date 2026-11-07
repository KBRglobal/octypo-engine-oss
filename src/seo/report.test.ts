import { describe, expect, it } from "vitest";

import {
  auditReport,
  categoryVocabulary,
  onTopic,
  opportunityFrom,
  plausibleGap,
  qualifyCompetitors,
  toSiteCheck,
  type GapEntry,
  type ProspectReport,
} from "./report.js";
import type { CompetitorRow, KeywordRow } from "./rows.js";

const competitor = (domain: string, intersections: number, organicKeywords: number | null): CompetitorRow => ({
  domain,
  intersections,
  avgPosition: 10,
  organicKeywords,
  organicTraffic: 100,
});

const gap = (keyword: string, volume: number | null, cpc: number | null = 1): GapEntry => ({
  rival: "rival.com",
  keyword,
  volume,
  difficulty: 10,
  cpc,
  theirPosition: 3,
});

/**
 * These are the guards that stand between a real measurement and a claim in
 * front of a prospect. Each test below is a mistake this report actually made
 * against the live API before the guard existed.
 */
describe("qualifyCompetitors", () => {
  // Measured on a real site: the raw call returned facebook, instagram,
  // wikipedia and youtube as "competitors" for a site with five keywords.
  it("drops the platforms that rank for everything", () => {
    const kept = qualifyCompetitors(
      [
        competitor("facebook.com", 5, 1_000),
        competitor("instagram.com", 4, 1_000),
        competitor("wikipedia.org", 4, 1_000),
        competitor("youtube.com", 4, 1_000),
        competitor("stickers.org.uk", 3, 900),
      ],
      5
    );
    expect(kept.map((row) => row.domain)).toEqual(["stickers.org.uk"]);
  });

  it("drops the country editions of the same platforms", () => {
    expect(qualifyCompetitors([competitor("facebook.co.uk", 9, 100)], 50)).toEqual([]);
  });

  // A site with 156 million keywords is not a competitor to one with five,
  // and the gap against it is a list of head terms nobody could win.
  it("drops a rival that is out of the prospect's league", () => {
    const kept = qualifyCompetitors([competitor("giant.com", 40, 156_000_000)], 5);
    expect(kept).toEqual([]);
  });

  it("keeps a large rival when the prospect is large too", () => {
    const kept = qualifyCompetitors([competitor("rival.com", 40, 900_000)], 10_000);
    expect(kept.map((row) => row.domain)).toEqual(["rival.com"]);
  });

  it("ignores a domain that barely overlaps at all", () => {
    expect(qualifyCompetitors([competitor("rival.com", 1, 500)], 500)).toEqual([]);
  });
});

describe("plausibleGap", () => {
  it("rejects a national head term against a small prospect", () => {
    // "the weather", 2.7M searches, arrived via an otherwise sane rival.
    expect(plausibleGap(2_740_000, 1_300)).toBe(false);
    expect(plausibleGap(2_900, 1_300)).toBe(true);
  });

  it("uses an absolute ceiling when the prospect ranks for nothing yet", () => {
    expect(plausibleGap(40_000, null)).toBe(true);
    expect(plausibleGap(900_000, null)).toBe(false);
  });

  it("rejects a phrase with no measured volume", () => {
    expect(plausibleGap(null, 1_000)).toBe(false);
  });
});

describe("categoryVocabulary and onTopic", () => {
  const demand: KeywordRow[] = [
    { keyword: "corporate event production", volume: 880, difficulty: 7, cpc: 6.12, competition: null, intent: null },
    { keyword: "event production companies", volume: 590, difficulty: 18, cpc: 5.76, competition: null, intent: null },
  ];
  const vocabulary = categoryVocabulary("event production", demand);

  // Measured: a same-sized rival that sells stickers filled the gap table of
  // an events company with sticker phrases. True, and useless.
  it("keeps a phrase from the business and drops one from another business", () => {
    expect(onTopic("production hall downtown", vocabulary)).toBe(true);
    expect(onTopic("sticker packs for soldiers", vocabulary)).toBe(false);
  });

  it("treats an unnamed category as no category, rather than as a match", () => {
    expect(onTopic("anything at all", new Set())).toBe(false);
  });
});

describe("opportunityFrom", () => {
  it("counts only phrases with a measured volume", () => {
    const result = opportunityFrom([gap("a", 1_000, 2), gap("b", null), gap("c", 500, 1)]);
    expect(result).toEqual({ missedMonthlySearches: 1_500, missedMonthlyValueUsd: 2_500, keywordCount: 2 });
  });

  it("reports nothing rather than zero when nothing was measured", () => {
    expect(opportunityFrom([gap("a", null)])).toBeNull();
  });
});

describe("auditReport", () => {
  const base: ProspectReport = {
    domain: "example.com",
    clientName: "Example",
    generatedAt: new Date().toISOString(),
    market: { locationCode: 2826, languageCode: "en" },
    visibility: null,
    links: null,
    topKeywords: [],
    competitors: [],
    gaps: [],
    demand: [],
    categoryDemand: null,
    themes: [],
    serpOwners: null,
    local: null,
    crawl: null,
    aiAnswers: null,
    aiDemand: [],
    site: null,
    opportunity: null,
    omitted: [],
    costUsd: 0,
  };

  // An all-null overview is the provider having nothing, not a measurement of
  // zero. Rendered as zeros it reads as an accusation we cannot support.
  it("drops an overview that measured nothing, and says so", () => {
    const audited = auditReport({
      ...base,
      visibility: {
        organicKeywords: null,
        organicTraffic: null,
        organicTrafficCost: null,
        paidKeywords: null,
        top3: null,
        top10: null,
      },
    });
    expect(audited.visibility).toBeNull();
    expect(audited.omitted).toContain("visibility");
  });

  it("keeps an overview that genuinely measured zero", () => {
    const audited = auditReport({
      ...base,
      visibility: {
        organicKeywords: 5,
        organicTraffic: 4.6,
        organicTrafficCost: 1.8,
        paidKeywords: 0,
        top3: 0,
        top10: 0,
      },
    });
    expect(audited.visibility?.organicKeywords).toBe(5);
  });

  // The headline number has to come from the rows that survived, or the
  // document promises more than the table under it shows.
  it("recomputes the opportunity from the surviving rows", () => {
    const audited = auditReport({
      ...base,
      gaps: [gap("kept", 1_000, 2), gap("dropped", null)],
      opportunity: { missedMonthlySearches: 999_999, missedMonthlyValueUsd: 999_999, keywordCount: 2 },
    });
    expect(audited.gaps).toHaveLength(1);
    expect(audited.opportunity).toEqual({
      missedMonthlySearches: 1_000,
      missedMonthlyValueUsd: 2_000,
      keywordCount: 1,
    });
  });

  it("names every section it emptied", () => {
    const audited = auditReport(base);
    for (const name of [
      "topKeywords",
      "demand",
      "gaps",
      "competitors",
      "aiDemand",
      "site",
      "themes",
      "serpOwners",
      "local",
      "crawl",
      "aiAnswers",
    ]) {
      expect(audited.omitted, name).toContain(name);
    }
  });
});

describe("toSiteCheck", () => {
  it("reads the page and names only the problems a person can act on", () => {
    const check = toSiteCheck({
      url: "https://example.com/",
      status_code: 200,
      size: 144_384,
      meta: {
        title: "Title",
        description: "Description",
        internal_links_count: 38,
        htags: { h1: ["one"] },
      },
      page_timing: { dom_complete: 80 },
      checks: { no_image_alt: true, low_content_rate: true, seo_friendly_url: true, no_title: false },
    });
    expect(check).toMatchObject({ statusCode: 200, internalLinks: 38, h1Count: 1, loadSeconds: 0.08, sizeKb: 141 });
    expect(check?.problems).toEqual(["Images have no description", "Very little text on the page"]);
  });

  // `seo_friendly_url` reads the opposite way round to every other check.
  it("does not report a friendly url as a problem", () => {
    const check = toSiteCheck({ url: "https://example.com/", checks: { seo_friendly_url: false } });
    expect(check?.problems).toEqual(["The page address is not search friendly"]);
  });

  it("returns nothing for a body with no url", () => {
    expect(toSiteCheck({ status_code: 200 })).toBeNull();
  });
});
