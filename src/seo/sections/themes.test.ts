import { describe, expect, it } from "vitest";

import { buildThemes } from "./themes.js";

const kw = (keyword: string, volume: number | null) => ({ keyword, volume });

describe("buildThemes", () => {
  const demand = [
    kw("event hall north side", 500),
    kw("event garden north side", 300),
    kw("event hall south side", 200),
    kw("event garden south side", 100),
    kw("corporate event production", 880),
    kw("corporate event company", 120),
  ];
  const seed = "event production";

  // Every phrase in an events category contains "event", so grouping on it
  // would produce one theme containing everything — a heading, not a plan.
  it("groups on the distinctive word, not the one they all share", () => {
    const themes = buildThemes(demand, { seed });
    const labels = themes.map((theme) => theme.label);
    expect(labels).toContain("side");
    expect(labels).toContain("corporate");
    expect(labels).not.toContain("event");
  });

  // If a phrase landed in two themes its searches would be counted twice, and
  // the totals in the document would add up to more demand than exists.
  it("puts each phrase in exactly one theme", () => {
    const themes = buildThemes(demand, { seed });
    const all = themes.flatMap((theme) => theme.keywords.map((row) => row.keyword));
    expect(new Set(all).size).toBe(all.length);
  });

  it("totals each theme from the volumes it was given", () => {
    const themes = buildThemes(demand, { seed });
    expect(themes.find((theme) => theme.label === "corporate")?.monthlySearches).toBe(1000);
    expect(themes.find((theme) => theme.label === "side")?.monthlySearches).toBe(1100);
  });

  it("orders themes by demand, and phrases within a theme by demand", () => {
    const themes = buildThemes(demand, { seed });
    const volumes = themes.map((theme) => theme.monthlySearches);
    expect([...volumes].sort((a, b) => b - a)).toEqual(volumes);
    expect(themes[0].keywords[0].volume).toBeGreaterThanOrEqual(
      themes[0].keywords[themes[0].keywords.length - 1].volume ?? 0
    );
  });

  it("drops a group too small to be a theme", () => {
    const themes = buildThemes([kw("event hall north", 500), kw("something else entirely", 10)], {
      seed,
      minKeywords: 2,
    });
    expect(themes).toEqual([]);
  });

  it("treats a phrase with no measured volume as no searches, not as a guess", () => {
    const themes = buildThemes([kw("event hall north", null), kw("event garden north", 300)], { seed });
    expect(themes[0].monthlySearches).toBe(300);
    expect(themes[0].keywords).toHaveLength(2);
  });

  it("works in English too", () => {
    const themes = buildThemes(
      [
        kw("project management software for agencies", 500),
        kw("best software for agencies", 300),
        kw("project management software pricing", 200),
      ],
      { seed: "project management software", minKeywords: 2 }
    );
    expect(themes.map((theme) => theme.label)).toContain("agencies");
  });
});

describe("punctuation inside a word", () => {
  // Splitting on an in-word apostrophe turned `women's` into a theme called
  // "women" and a stray fragment.
  it("keeps a word that contains an apostrophe whole", () => {
    const themes = buildThemes(
      [
        { keyword: "event production women's conference", volume: 40 },
        { keyword: "women's networking dinner", volume: 60 },
      ],
      { seed: "event production" }
    );
    expect(themes[0].label).toBe("women's");
    expect(themes[0].monthlySearches).toBe(100);
  });
});

describe("word forms", () => {
  // Measured: the forms of one word became separate themes of two phrases each,
  // and the business was told to write several pages about one subject.
  it("groups a singular and its plural under one theme", () => {
    const themes = buildThemes(
      [
        { keyword: "event production company", volume: 590 },
        { keyword: "event production for companies", volume: 590 },
        { keyword: "event production companies", volume: 590 },
        { keyword: "event production for tech companies", volume: 140 },
      ],
      { seed: "event production" }
    );
    expect(themes).toHaveLength(1);
    expect(themes[0].monthlySearches).toBe(1910);
  });

  it("labels the theme with the spelling people actually type", () => {
    const themes = buildThemes(
      [
        { keyword: "event production companies", volume: 100 },
        { keyword: "large event companies", volume: 90 },
        { keyword: "event production company", volume: 80 },
      ],
      { seed: "event production" }
    );
    expect(themes[0].label).toBe("companies");
  });

  it("still keeps genuinely different words apart", () => {
    const themes = buildThemes(
      [
        { keyword: "event hall north", volume: 500 },
        { keyword: "event garden north", volume: 300 },
        { keyword: "corporate event production", volume: 880 },
        { keyword: "corporate event production companies", volume: 50 },
      ],
      { seed: "event production" }
    );
    expect(themes.map((theme) => theme.label).sort()).toEqual(["corporate", "north"]);
  });

  it("does not invent a singular the list never used", () => {
    const themes = buildThemes(
      [
        { keyword: "business news today", volume: 100 },
        { keyword: "local news desk", volume: 90 },
      ],
      {}
    );
    expect(themes[0].label).toBe("news");
  });
});

describe("any language", () => {
  // No spaces and no plurals to lean on: the words come from the segmenter.
  it("groups Japanese phrases on the word they share", () => {
    const themes = buildThemes(
      [
        { keyword: "\u6771\u4EAC \u30DB\u30C6\u30EB", volume: 300 }, // Tokyo hotel
        { keyword: "\u5927\u962A \u30DB\u30C6\u30EB", volume: 200 }, // Osaka hotel
        { keyword: "\u6771\u4EAC \u30E9\u30FC\u30E1\u30F3", volume: 50 }, // Tokyo ramen
      ],
      { minKeywords: 2 }
    );
    expect(themes.map((theme) => theme.label)).toContain("\u30DB\u30C6\u30EB");
    expect(themes.flatMap((theme) => theme.keywords)).toHaveLength(2);
  });

  it("groups Arabic phrases on the word they share and honours the seed", () => {
    const hotels = "\u0641\u0646\u0627\u062F\u0642"; // hotels
    const themes = buildThemes(
      [
        { keyword: `${hotels} \u0627\u0644\u0642\u0627\u0647\u0631\u0629`, volume: 300 }, // Cairo
        { keyword: `${hotels} \u0627\u0644\u0625\u0633\u0643\u0646\u062F\u0631\u064A\u0629`, volume: 200 }, // Alexandria
      ],
      { minKeywords: 2 }
    );
    expect(themes[0].label).toBe(hotels);
    expect(buildThemes(themes[0].keywords, { seed: hotels, minKeywords: 2 })).toEqual([]);
  });
});
