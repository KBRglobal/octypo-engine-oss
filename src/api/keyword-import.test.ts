import { describe, it, expect } from "vitest";

import { CAMPAIGN_CORE_MAX, parseKeywordExport, shortlist } from "./keyword-import.js";

/**
 * Reading a keyword tool's export.
 *
 * The point of importing rather than integrating is that it works with
 * whichever tool the operator pays for this year, so the parser is tested
 * against the shapes those tools actually produce: unknown headers, tab
 * separation, thousands separators, "1.3K", and "<10", which is a real
 * answer meaning "some demand, below what we report".
 */

const ok = (result: ReturnType<typeof parseKeywordExport>) => {
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("reading an export", () => {
  it("reads a comma-separated export", () => {
    const r = ok(
      parseKeywordExport(
        // A real CSV quotes a thousands separator; an unquoted one would be
        // two fields, which is the file being wrong rather than the parser.
        ["keyword,search volume,difficulty", '"vegan catering","1,300",42', "vegan food in lisbon,210,18"].join(
          "\n"
        )
      )
    );
    expect(r.keywords).toHaveLength(2);
    expect(r.keywords[0]).toMatchObject({ keyword: "vegan catering", difficulty: 42 });
    expect(r.columns.volume).toBe("search volume");
  });

  it("reads an English tab-separated export", () => {
    const r = ok(
      parseKeywordExport(
        ["Keyword\tSearch Volume\tKD\tCPC", "vegan catering\t2400\t55\t3.20"].join("\n")
      )
    );
    expect(r.keywords[0]).toEqual({
      keyword: "vegan catering",
      volume: 2400,
      difficulty: 55,
      cpc: 3.2,
    });
  });

  it("understands the shapes tools write numbers in", () => {
    const r = ok(
      parseKeywordExport(
        ["keyword,volume", 'a,"1,300"', "b,1.3K", "c,<10", "d,—", "e,n/a"].join("\n")
      )
    );
    expect(r.keywords.map((k) => k.volume)).toEqual([1300, 1300, 10, null, null]);
  });

  it("refuses a table with no keyword column instead of guessing one", () => {
    // Importing the wrong column silently would put invented phrases into a
    // client's campaign.
    const r = parseKeywordExport("city,population\nLisbon,545000");
    expect("error" in r && r.error).toContain("no keyword column");
  });

  it("refuses a paste with nothing but a header", () => {
    expect("error" in parseKeywordExport("keyword,volume")).toBe(true);
  });

  it("drops repeats and counts them", () => {
    const r = ok(parseKeywordExport(["keyword,volume", "a,10", "A,20", "b,5"].join("\n")));
    expect(r.keywords).toHaveLength(2);
    expect(r.skipped).toBe(1);
  });

  it("copes with a missing volume column", () => {
    const r = ok(parseKeywordExport(["keyword", "vegan catering"].join("\n")));
    expect(r.keywords[0].volume).toBeNull();
    expect(r.columns.volume).toBeUndefined();
  });
});

describe("a table headed in another language", () => {
  // Japanese headers, none of which the name patterns know: keyword, search
  // volume, difficulty, cost per click.
  const header = "\u30AD\u30FC\u30EF\u30FC\u30C9,\u691C\u7D22\u30DC\u30EA\u30E5\u30FC\u30E0,\u96E3\u6613\u5EA6,\u30AF\u30EA\u30C3\u30AF\u5358\u4FA1";
  const hotel = "\u6771\u4EAC \u30DB\u30C6\u30EB";

  it("reads the columns from what they hold, and names what it read", () => {
    const r = ok(parseKeywordExport([header, `${hotel},"1,300",42,1.50`, "\u5927\u962A \u30DB\u30C6\u30EB,720,31,0.80"].join("\n")));
    expect(r.keywords[0]).toEqual({ keyword: hotel, volume: 1300, difficulty: 42, cpc: 1.5 });
    expect(r.columns.keyword).toBe("\u30AD\u30FC\u30EF\u30FC\u30C9");
    expect(r.columns.cpc).toBe("\u30AF\u30EA\u30C3\u30AF\u5358\u4FA1");
  });

  it("reads a Latin-script export whose names it does not know", () => {
    const r = ok(
      parseKeywordExport(["Suchbegriff;Suchvolumen", "hotel in berlin;1200", "hotel in hamburg;800"].join("\n"))
    );
    expect(r.keywords[1]).toMatchObject({ keyword: "hotel in hamburg", volume: 800 });
  });

  it("still refuses a table of single words, whatever its size", () => {
    const r = parseKeywordExport(["city,population", "Lisbon,545000", "Porto,232000", "Braga,193000"].join("\n"));
    expect("error" in r).toBe(true);
  });

  it("refuses when two columns could be the phrases", () => {
    const r = parseKeywordExport(["a,b", "red shoes,blue hats", "green socks,black ties"].join("\n"));
    expect("error" in r).toBe(true);
  });

  it("does not take a column of addresses for phrases", () => {
    const r = parseKeywordExport(["page,visits", "https://example.com/a b,10", "https://example.com/c d,20"].join("\n"));
    expect("error" in r).toBe(true);
  });
});

describe("cutting it down to a campaign", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    keyword: `phrase ${i}`,
    volume: 1000 - i * 10,
    difficulty: 20,
    cpc: null,
  }));

  it("keeps a campaign's worth, not the whole export", () => {
    const out = shortlist({ keywords: rows, businessSeeds: [], weakClient: false });
    expect(out.filter((k) => k.keep)).toHaveLength(CAMPAIGN_CORE_MAX);
    expect(out.find((k) => !k.keep)?.reason).toContain("beyond the campaign core");
  });

  it("drops a phrase with no volume and no business behind it", () => {
    const out = shortlist({
      keywords: [{ keyword: "nobody searches this", volume: 0, difficulty: 5, cpc: null }],
      businessSeeds: [],
      weakClient: false,
    });
    expect(out[0].keep).toBe(false);
    expect(out[0].reason).toContain("no volume");
  });

  it("keeps a zero-volume phrase the business itself named", () => {
    // The client knowing customers ask for it outranks a tool reporting nothing.
    const out = shortlist({
      keywords: [{ keyword: "weekend meal boxes lisbon", volume: 0, difficulty: 5, cpc: null }],
      businessSeeds: ["weekend meal boxes lisbon"],
      weakClient: false,
    });
    expect(out[0].keep).toBe(true);
  });

  it("turns a weak site away from a hard phrase, and says where to go", () => {
    const hard = [{ keyword: "catering", volume: 9000, difficulty: 60, cpc: null }];
    const weak = shortlist({ keywords: hard, businessSeeds: [], weakClient: true });
    expect(weak[0].keep).toBe(false);
    expect(weak[0].reason).toContain("longer phrase");

    const strong = shortlist({ keywords: hard, businessSeeds: [], weakClient: false });
    expect(strong[0].keep).toBe(true);
  });
});

describe("intent, in a language with no word list", () => {
  it("treats the phrase as a bare service phrase rather than dropping it", () => {
    const out = shortlist({
      keywords: [{ keyword: "\u6771\u4EAC \u30DB\u30C6\u30EB", volume: 500, difficulty: 10, cpc: null }],
      businessSeeds: [],
      weakClient: false,
    });
    expect(out[0]).toMatchObject({ intent: "commercial", keep: true });
  });
});

describe("intent, applied to a measured list", () => {
  const info = [{ keyword: "what is vegan certification", volume: 5000, difficulty: 10, cpc: null }];

  it("refuses broad information when there is no page to convert on", () => {
    // The big volume is exactly what makes this tempting and wrong.
    const out = shortlist({ keywords: info, businessSeeds: [], weakClient: false });
    expect(out[0].keep).toBe(false);
    expect(out[0].reason).toContain("no page that converts");
  });

  it("allows it once a page exists", () => {
    const out = shortlist({
      keywords: info,
      businessSeeds: [],
      weakClient: false,
      landingPages: ["/certification"],
    });
    expect(out[0].keep).toBe(true);
  });

  it("puts buying and local phrases ahead of bigger informational ones", () => {
    const out = shortlist({
      keywords: [
        { keyword: "what is catering", volume: 9000, difficulty: 10, cpc: null },
        { keyword: "vegan catering prices", volume: 300, difficulty: 10, cpc: null },
      ],
      businessSeeds: [],
      weakClient: false,
      landingPages: ["/catering"],
    });
    expect(out.filter((k) => k.keep)[0].keyword).toBe("vegan catering prices");
  });
});

describe("a Keyword Surfer paste", () => {
  // Surfer is a sidebar in Google, not an export, so what lands on the
  // clipboard is bare rows. This is the shape a browser-extension copy produces.
  const surfer = ["vegan catering\t1300", "vegan catering lisbon\t320", "vegan restaurant\t880"].join("\n");

  it("reads rows with no header at all", () => {
    const r = ok(parseKeywordExport(surfer));
    expect(r.keywords).toHaveLength(3);
    expect(r.keywords[0]).toMatchObject({ keyword: "vegan catering", volume: 1300 });
    expect(r.columns.keyword).toContain("no header");
  });

  it("reads a single column of phrases with no volume", () => {
    const r = ok(parseKeywordExport(["vegan catering", "vegan restaurant"].join("\n")));
    expect(r.keywords.map((k) => k.keyword)).toEqual(["vegan catering", "vegan restaurant"]);
    expect(r.keywords[0].volume).toBeNull();
  });

  it("still refuses a table that is plainly not keywords", () => {
    expect("error" in parseKeywordExport("city,population\nLisbon,545000")).toBe(true);
  });
});

describe("step 6: no page, no campaign", () => {
  const rows = [
    { keyword: "vegan catering lisbon", volume: 320, difficulty: 20, cpc: null },
    { keyword: "vegan restaurant", volume: 880, difficulty: 20, cpc: null },
  ];

  it("holds back a phrase that has not been given a page", () => {
    const out = shortlist({
      keywords: rows,
      businessSeeds: [],
      weakClient: false,
      landingPages: ["/catering"],
      pageFor: { "vegan catering lisbon": "/catering-lisbon" },
    });
    const byKeyword = Object.fromEntries(out.map((k) => [k.keyword, k]));
    expect(byKeyword["vegan catering lisbon"].keep).toBe(true);
    expect(byKeyword["vegan restaurant"].keep).toBe(false);
    expect(byKeyword["vegan restaurant"].reason).toContain("target page");
  });

  it('counts "build a page" as a decided page', () => {
    const out = shortlist({
      keywords: rows,
      businessSeeds: [],
      weakClient: false,
      landingPages: ["/catering"],
      pageFor: {
        "vegan catering lisbon": "/catering-lisbon",
        "vegan restaurant": "build a page",
      },
    });
    expect(out.every((k) => k.keep)).toBe(true);
  });

  it("does not gate at all until pages are being assigned", () => {
    // Before step 5 the list is still a candidate list, not a campaign.
    const out = shortlist({
      keywords: rows,
      businessSeeds: [],
      weakClient: false,
      landingPages: ["/catering"],
    });
    expect(out.every((k) => k.keep)).toBe(true);
  });
});
