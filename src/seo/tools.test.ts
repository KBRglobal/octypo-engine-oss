import { afterEach, describe, expect, it } from "vitest";

import { SeoApiError } from "./client.js";
import { deskDefaultMarket, deskEnabled, quote } from "./desk.js";
import { cacheKey } from "./store.js";
import { SEO_TOOLS, SEO_TOOL_IDS, cleanDomain, normaliseInput } from "./tools.js";

describe("cleanDomain", () => {
  it("reduces whatever was pasted to a bare host", () => {
    expect(cleanDomain("https://www.Example-Kitchen.ae/menu?x=1")).toBe("example-kitchen.ae");
    expect(cleanDomain("  EXAMPLE.com  ")).toBe("example.com");
    expect(cleanDomain("http://localhost:3000/admin")).toBe("localhost");
  });

  it("leaves a subdomain alone", () => {
    expect(cleanDomain("blog.example.com/posts")).toBe("blog.example.com");
  });
});

describe("normaliseInput", () => {
  it("clamps a limit to what the tool supports", () => {
    const tool = SEO_TOOLS["ranked-keywords"];
    expect(normaliseInput(tool, { target: "a.com", limit: 99_999 }).limit).toBe(tool.maxLimit);
    expect(normaliseInput(tool, { target: "a.com", limit: -5 }).limit).toBe(tool.defaultLimit);
    expect(normaliseInput(tool, { target: "a.com" }).limit).toBe(tool.defaultLimit);
  });

  // The page keeps all three boxes filled while moving between tools, so a
  // domain lookup would otherwise carry a stale keyword into the cache key and
  // pay again for a question already answered.
  it("keeps only the fields the tool actually uses", () => {
    const kept = normaliseInput(SEO_TOOLS["domain-overview"], {
      target: "https://www.Example.com/pricing",
      keyword: "left over from the last tool",
      rival: "also left over",
    });
    expect(kept).toEqual({ target: "example.com", limit: 1 });
  });

  it("carries the market through, because it is part of the question", () => {
    const kept = normaliseInput(SEO_TOOLS.serp, {
      keyword: "event hall",
      locationCode: 2826,
      languageCode: "en",
    });
    expect(kept).toMatchObject({ locationCode: 2826, languageCode: "en" });
  });

  it("refuses a run that is missing an input, before it costs anything", () => {
    expect(() => normaliseInput(SEO_TOOLS["ranked-keywords"], {})).toThrow(SeoApiError);
    expect(() => normaliseInput(SEO_TOOLS["keyword-gap"], { target: "a.com" })).toThrow(/domain/);
    expect(() => normaliseInput(SEO_TOOLS.serp, { target: "a.com" })).toThrow(/keyword/);
  });
});

describe("cacheKey", () => {
  it("is the same for the same question", () => {
    const a = cacheKey("serp", { keyword: "weekend meals", limit: 20 });
    const b = cacheKey("serp", { keyword: "weekend meals", limit: 20 });
    expect(a).toBe(b);
  });

  it("changes when anything about the question changes", () => {
    const base = cacheKey("serp", { keyword: "weekend meals", limit: 20 });
    expect(cacheKey("serp", { keyword: "weekend meals", limit: 50 })).not.toBe(base);
    expect(cacheKey("serp", { keyword: "weekend meal", limit: 20 })).not.toBe(base);
    expect(cacheKey("keywords", { keyword: "weekend meals", limit: 20 })).not.toBe(base);
  });

  // The same phrase in two countries gives two different
  // answers, so they must be two different purchases.
  it("treats a different market as a different question", () => {
    const uk = cacheKey("serp", { keyword: "hall", limit: 20, locationCode: 2826, languageCode: "en" });
    const uae = cacheKey("serp", { keyword: "hall", limit: 20, locationCode: 2784, languageCode: "en" });
    const arabic = cacheKey("serp", { keyword: "hall", limit: 20, locationCode: 2826, languageCode: "ar" });
    expect(new Set([uk, uae, arabic]).size).toBe(3);
  });
});

describe("quote", () => {
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
  };

  it("prices a single-call tool from the account's own card", () => {
    expect(quote("ranked-keywords", 100, CARD)).toBeCloseTo(0.024, 6);
  });

  // A tool that makes three calls and prices only one would under-promise,
  // and the number beside the button is the whole point of the desk.
  it("reports null when any call in a multi-call tool is unpriced", () => {
    expect(quote("backlinks", 100, CARD)).toBeNull();
  });
});

describe("every tool", () => {
  it("declares the calls it will make, so it can be priced", () => {
    for (const id of SEO_TOOL_IDS) {
      const tool = SEO_TOOLS[id];
      const calls = tool.calls({ limit: tool.defaultLimit });
      expect(calls.length, id).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.path, id).toMatch(/^\//);
        expect(call.rows, id).toBeGreaterThan(0);
      }
    }
  });

  it("keeps its default within its own maximum", () => {
    for (const id of SEO_TOOL_IDS) {
      expect(SEO_TOOLS[id].defaultLimit, id).toBeLessThanOrEqual(SEO_TOOLS[id].maxLimit);
    }
  });
});

describe("deskEnabled", () => {
  const creds = { DATAFORSEO_LOGIN: "a", DATAFORSEO_PASSWORD: "b" };

  it("stays off unless the flag is set, whatever the entitlements say", () => {
    expect(deskEnabled({ ...creds } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      deskEnabled({ ...creds, OCTYPO_ENTITLEMENTS: "all" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("stays off when the flag is set but there is no login to use", () => {
    expect(deskEnabled({ SEO_TOOLS_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(
      deskEnabled({ SEO_TOOLS_ENABLED: "1", DATAFORSEO_LOGIN: "a" } as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("opens only with both", () => {
    expect(deskEnabled({ ...creds, SEO_TOOLS_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(deskEnabled({ ...creds, SEO_TOOLS_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(deskEnabled({ ...creds, SEO_TOOLS_ENABLED: "off" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("the desk's own market", () => {
  const client = { defaults: { locationCode: 2840, languageCode: "en" } } as never;

  afterEach(() => {
    delete process.env.SEO_DESK_LOCATION_CODE;
    delete process.env.SEO_DESK_LANGUAGE_CODE;
  });

  // The engine's location is the customer's country. Researching a rival in
  // the desk must not silently open in it and answer about the wrong market.
  it("does not inherit the engine's country when it has one of its own", () => {
    process.env.SEO_DESK_LOCATION_CODE = "2826";
    process.env.SEO_DESK_LANGUAGE_CODE = "en";
    expect(deskDefaultMarket(client)).toEqual({ locationCode: 2826, languageCode: "en" });
  });

  it("falls back to the engine's market when it has none", () => {
    expect(deskDefaultMarket(client)).toEqual({ locationCode: 2840, languageCode: "en" });
  });

  it("ignores a junk value rather than asking about country zero", () => {
    process.env.SEO_DESK_LOCATION_CODE = "not a country";
    expect(deskDefaultMarket(client).locationCode).toBe(2840);
  });
});
