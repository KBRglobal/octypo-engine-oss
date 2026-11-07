import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildCoverageIndex,
  fetchSiteCoverage,
  findCoveringPage,
  headingHead,
  isHubPath,
  resetSiteCoverageCache,
  siteCoverage,
  titleAndH1,
  type CoveragePage,
} from "./site-coverage.js";

/** A fictional city guide, shaped like a real hub-and-articles site. */
const SITE_PAGES: Array<[string, string]> = [
  ["/", "Lakeview for visitors: hotels, flights, attractions, food and more"],
  ["/areas/", "Neighbourhoods in Lakeview: where to stay and what defines each one"],
  ["/attractions/", "Attractions in Lakeview: tickets and outings that suit you"],
  ["/attractions/river-cruises/", "River cruises in Lakeview: routes, transfers and what is included"],
  ["/attractions/water-activities/", "Water sports in Lakeview: kayaks, paddleboards and activities on the lake"],
  ["/babysitters/", "Babysitters in Lakeview: how to find a sitter and what to check"],
  ["/beaches/", "Beaches in Lakeview: which beach suits your day?"],
  ["/best-time/", "Best time to visit Lakeview? Weather in Lakeview by month"],
  ["/car-rental/", "Car rental in Lakeview: when it pays and what to check in the price?"],
  ["/checklist/", "Checklist before a flight to Lakeview"],
  ["/cruises/", "River cruises from Lakeview: how to choose a trip and what to check?"],
  ["/events/", "Events and concerts in Lakeview: what is on this week and month"],
  ["/families/", "Lakeview with kids: how to choose attractions without overdoing it?"],
  ["/ferry-times/", "Ferry departure and holiday times in Lakeview: exact times for Lakeview"],
  ["/fishing-charters/", "Fishing charters on the lake: boats, skippers and licences"],
  ["/flights/", "Flights to Lakeview today: live flight board to Lakeview and back"],
  ["/getting-around/", "Metro and taxis in Lakeview: prices, hours and how to get there from the airport"],
  ["/hotels/", "Hotels in Lakeview: recommended hotels by area and type of holiday"],
  ["/hotels/grand-harbor/pools-beach/", "Pools and beach at the Grand Harbor: hours and access by hotel"],
  ["/hotels/luxury/", "Luxury hotels in Lakeview: how to choose a resort"],
  ["/hotels/waterpark/", "Hotels with a water park in Lakeview: what is really included"],
  ["/news/", "Lakeview news: what opened, what is on and what changed in the city"],
  ["/prices/", "Lakeview costs: prices in dollars at today's rate"],
  ["/property/", "Real estate in Lakeview"],
  ["/restaurants/", "Restaurants in Lakeview: 373 restaurants, bars and beach clubs by area and cuisine"],
  ["/shopping/", "Shopping in Lakeview: malls, markets, tax refunds and sale seasons"],
  ["/shopping/all-malls/", "All the malls in Lakeview: full list by area"],
  ["/shopping/malls/", "Malls in Lakeview: a broad guide by area and type of shopping"],
  ["/topics/", "All topics on Lakeview Guide: site index by topic"],
  ["/vegan/", "Vegan food in Lakeview: restaurants, hotel delivery and weekend meals"],
  ["/visa/", "Visa to Lakeview for visitors: exemptions, 90 days and temporary passports"],
];

const ORIGIN = "https://example.com";
const pages: CoveragePage[] = SITE_PAGES.map(([path, heading]) => ({
  url: `${ORIGIN}${path}`,
  path,
  title: `${heading} | Lakeview Guide`,
  h1: heading,
}));
const index = buildCoverageIndex({ pages, siteGeneric: ["lakeview"] });

describe("findCoveringPage — topics a hub already owns (must be caught)", () => {
  // Each of these once produced an /articles/ guide beside the hub.
  const pairs: Array<[string, string[]]> = [
    ["ferry times in lakeview", ["/ferry-times/"]],
    ["vegan food in lakeview", ["/vegan/"]],
    ["vegan restaurants in lakeview", ["/vegan/"]],
    ["visa to lakeview visitors", ["/visa/"]],
    ["flights to lakeview", ["/flights/"]],
    ["hotels in lakeview", ["/hotels/"]],
    ["attractions in lakeview", ["/attractions/"]],
    ["metro lakeview", ["/getting-around/"]],
    ["beaches in lakeview", ["/beaches/"]],
    ["babysitters in lakeview", ["/babysitters/"]],
    ["families in lakeview", ["/families/"]],
    ["real estate in lakeview", ["/property/"]],
    ["prices in lakeview", ["/prices/"]],
    ["malls in lakeview", ["/shopping/all-malls/", "/shopping/malls/"]],
    ["river cruises in lakeview", ["/attractions/river-cruises/", "/cruises/"]],
    ["festivals in lakeview", ["/events/"]],
    ["events and concerts in lakeview", ["/events/"]],
    // Spelling variants of the same queries
    ["best time to visit lakeview", ["/best-time/"]],
    ["real-estate in lakeview", ["/property/"]],
    ["lakeview with kids", ["/families/"]],
    ["hotel in lakeview", ["/hotels/"]],
  ];

  it.each(pairs)("%s", (keyword, winners) => {
    const match = findCoveringPage(keyword, index);
    expect(match, keyword).not.toBeNull();
    expect(winners).toContain(match!.path);
    expect(match!.url).toBe(`${ORIGIN}${match!.path}`);
  });
});

describe("findCoveringPage — different topics (must NOT be caught)", () => {
  const free = [
    // kept on purpose
    "neighbourhoods lakeview housing",
    "apartments in lakeview for visitors",
    "moving to lakeview",
    "lakeview guide",
    // ideas with no owning page
    "health insurance lakeview visitors",
    "duty free lakeview",
    "language schools lakeview",
    // near misses: one shared word is not a shared topic
    "holidays in lakeview", // the ferry page mentions holidays; public holidays are a different topic
    "sports in lakeview", // "water sports" is water sports only
    "fishing in lakeview", // "fishing charters" is a modifier, not a list
    "hotels on the beach in lakeview", // "hotels with a water park" is water parks
    "free attractions in lakeview",
    "bus times in lakeview",
    "kindergartens in lakeview",
    "yacht rental in lakeview",
    "flight cancellations",
    "",
  ];

  it.each(free)("%s", (keyword) => {
    expect(findCoveringPage(keyword, index)).toBeNull();
  });

  it("never matches the home page, whose title lists every topic", () => {
    const homeOnly = buildCoverageIndex({ pages: pages.filter((page) => page.path === "/"), siteGeneric: ["lakeview"] });
    expect(findCoveringPage("vegan food", homeOnly)).toBeNull();
    expect(findCoveringPage("hotels", homeOnly)).toBeNull();
  });

  it("never matches an article page", () => {
    const articleOnly = buildCoverageIndex({
      pages: [{ url: `${ORIGIN}/articles/ferry-times-lakeview/`, path: "/articles/ferry-times-lakeview/", title: "Ferry times in Lakeview", h1: "Ferry times in Lakeview" }],
      siteGeneric: [],
    });
    expect(findCoveringPage("ferry times in lakeview", articleOnly)).toBeNull();
  });

  it("does not block a long tail even when every word is on a hub", () => {
    expect(findCoveringPage("flights lakeview hotels attractions vegan prices", index)).toBeNull();
  });
});

describe("coordination follows the caller's language", () => {
  const hub = (heading: string): CoveragePage => ({ url: `${ORIGIN}/hub/`, path: "/hub/", title: heading, h1: heading });

  it("reads a conjunction joined to the next word, for a language that writes one", () => {
    // "metro and buses" in Arabic: the "and" is the first letter of "buses".
    const metro = "\u0645\u062A\u0631\u0648";
    const page = hub(`${metro} \u0648\u062D\u0627\u0641\u0644\u0627\u062A`);
    const arabic = buildCoverageIndex({ pages: [page], siteGeneric: [] }, [], { language: "ar", country: "EG" });
    expect(findCoveringPage(metro, arabic)?.rule).toBe("R1");
    const english = buildCoverageIndex({ pages: [page], siteGeneric: [] }, [], { language: "en", country: "US" });
    expect(findCoveringPage(metro, english)).toBeNull();
  });

  it("reads a word that language has for 'and' when it stands alone", () => {
    const page = hub("Metro und Busse");
    const german = buildCoverageIndex({ pages: [page], siteGeneric: [] }, [], { language: "de", country: "DE" });
    expect(findCoveringPage("metro", german)?.rule).toBe("R1");
  });

  it("reads Japanese list punctuation, and a following noun as a modifier", () => {
    const subway = "\u5730\u4E0B\u9244";
    const listed = buildCoverageIndex(
      { pages: [hub(`${subway}\u3001\u30BF\u30AF\u30B7\u30FC`)], siteGeneric: [] },
      [],
      { language: "ja", country: "JP" }
    );
    expect(findCoveringPage(subway, listed)?.rule).toBe("R1");
    const museum = buildCoverageIndex(
      { pages: [hub(`${subway}\u535A\u7269\u9928`)], siteGeneric: [] },
      [],
      { language: "ja", country: "JP" }
    );
    expect(findCoveringPage(subway, museum)).toBeNull();
  });
});

describe("page parsing", () => {
  it("reads title and H1, stripping tags and entities", () => {
    const html = `<html><head><title>Hotels in Lakeview &amp; more | Lakeview Guide</title></head><body><h1 class="x">Hotels <em>in Lakeview</em></h1></body></html>`;
    expect(titleAndH1(html)).toEqual({ title: "Hotels in Lakeview & more | Lakeview Guide", h1: "Hotels in Lakeview" });
  });

  it("cuts the heading at the first colon/question mark and drops the site name", () => {
    expect(headingHead("What does Lakeview cost? Prices in dollars | Lakeview Guide")).toBe("What does Lakeview cost");
    expect(headingHead("Real estate in Lakeview | Lakeview Guide")).toBe("Real estate in Lakeview");
  });

  it("classifies hub paths", () => {
    expect(isHubPath("/vegan/", ["/articles/"])).toBe(true);
    expect(isHubPath("/", ["/articles/"])).toBe(false);
    expect(isHubPath("/articles/", ["/articles/"])).toBe(false);
    expect(isHubPath("/articles/x/", ["/articles/"])).toBe(false);
    expect(isHubPath("/feed.xml", ["/articles/"])).toBe(false);
  });
});

// ---------- loading, cache, concurrency, timeouts ----------

function siteFetch(options: { hang?: string[]; fail?: string[] } = {}) {
  let active = 0;
  const stats = { calls: 0, pageCalls: 0, maxActive: 0 };
  const sitemap = `<?xml version="1.0"?><urlset>${[...SITE_PAGES.map(([p]) => p), "/articles/ferry-times-lakeview/", "/hang/", "/broken/"]
    .map((p) => `<url><loc>${ORIGIN}${p}</loc></url>`)
    .join("")}</urlset>`;
  const impl = async (input: string, init?: { signal?: AbortSignal }) => {
    stats.calls++;
    const url = new URL(input);
    if (url.pathname === "/sitemap.xml") return { ok: true, status: 200, text: async () => sitemap };
    stats.pageCalls++;
    if (url.pathname.startsWith("/articles/")) throw new Error("article pages must not be fetched");
    active++;
    stats.maxActive = Math.max(stats.maxActive, active);
    try {
      if (options.hang?.includes(url.pathname)) {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (options.fail?.includes(url.pathname)) return { ok: false, status: 500, text: async () => "" };
      const row = SITE_PAGES.find(([p]) => p === url.pathname);
      if (!row) return { ok: false, status: 404, text: async () => "" };
      return { ok: true, status: 200, text: async () => `<title>${row[1]} | Lakeview Guide</title><h1>${row[1]}</h1>` };
    } finally {
      active--;
    }
  };
  return { impl, stats };
}

describe("fetchSiteCoverage / siteCoverage", () => {
  beforeEach(() => {
    resetSiteCoverageCache();
    delete process.env.ARTICLE_PATH_PREFIX;
  });

  it("loads every non-article page with bounded concurrency and a per-page timeout", async () => {
    const { impl, stats } = siteFetch({ hang: ["/hang/"], fail: ["/broken/"] });
    const started = Date.now();
    const coverage = await fetchSiteCoverage(ORIGIN, { fetchImpl: impl, concurrency: 3, timeoutMs: 100 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(coverage.error).toBe("");
    // "/" is skipped as a hub candidate; the hanging and broken pages drop out.
    expect(coverage.pages.map((page) => page.path)).not.toContain("/articles/ferry-times-lakeview/");
    expect(coverage.pages).toHaveLength(SITE_PAGES.length - 1);
    expect(stats.maxActive).toBeLessThanOrEqual(3);
    // The site's city is learnt from its own headings.
    expect(coverage.siteGeneric).toContain("lakeview");
    const learnt = buildCoverageIndex(coverage);
    expect(findCoveringPage("ferry times in lakeview", learnt)?.path).toBe("/ferry-times/");
  });

  it("caches for 12 hours, then reloads", async () => {
    const { impl, stats } = siteFetch();
    const t0 = new Date("2026-09-27T00:00:00Z");
    await siteCoverage(ORIGIN, { fetchImpl: impl, now: t0 });
    const first = stats.calls;
    await siteCoverage(ORIGIN, { fetchImpl: impl, now: new Date(t0.getTime() + 11 * 3600_000) });
    expect(stats.calls).toBe(first);
    await siteCoverage(ORIGIN, { fetchImpl: impl, now: new Date(t0.getTime() + 13 * 3600_000) });
    expect(stats.calls).toBeGreaterThan(first);
  });

  it("returns no pages (blocks nothing) when the sitemap is unreachable, and retries within the hour", async () => {
    let calls = 0;
    const down = async () => {
      calls++;
      return { ok: false, status: 503, text: async () => "" };
    };
    const t0 = new Date("2026-09-27T00:00:00Z");
    const coverage = await siteCoverage(ORIGIN, { fetchImpl: down, now: t0 });
    expect(coverage.pages).toHaveLength(0);
    expect(coverage.error).not.toBe("");
    const afterFirst = calls;
    await siteCoverage(ORIGIN, { fetchImpl: down, now: new Date(t0.getTime() + 31 * 60_000) });
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it("asks the site for the caller's language, and caches each locale apart", async () => {
    const seen: Array<string | undefined> = [];
    const { impl } = siteFetch();
    const spying: typeof impl = (input, init) => {
      seen.push((init as { headers?: Record<string, string> } | undefined)?.headers?.["accept-language"]);
      return impl(input, init);
    };
    const now = new Date("2026-09-27T00:00:00Z");
    await siteCoverage(ORIGIN, { fetchImpl: spying, now, locale: { language: "ja", country: "JP" } });
    expect(seen).toContain("ja-JP,ja;q=0.9");
    seen.length = 0;
    await siteCoverage(ORIGIN, { fetchImpl: spying, now, locale: { language: "de", country: "DE" } });
    expect(seen).toContain("de-DE,de;q=0.9");
  });

  it("is empty without SITE_URL", async () => {
    const coverage = await siteCoverage("");
    expect(coverage.pages).toHaveLength(0);
    expect(coverage.error).toMatch(/SITE_URL/);
  });
});
