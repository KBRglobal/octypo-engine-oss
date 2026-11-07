import { describe, expect, it } from "vitest";

import { classify, labelFor, undouble } from "./catalogue.js";
import { cacheTtlFor, adHocEndpoint, canonicalise } from "./explorer.js";
import { templateFor, withTaskId } from "./params.js";

describe("undouble", () => {
  // Measured against the live API: the doubled path 404s, the single one
  // answers. Without this the whole AI-optimization reference set is dead.
  it("drops a tail the provider repeated", () => {
    expect(
      undouble(["ai_optimization", "ai_keyword_data", "available_filters", "ai_keyword_data", "available_filters"])
    ).toEqual(["ai_optimization", "ai_keyword_data", "available_filters"]);
  });

  it("leaves a path whose repetition is real", () => {
    // "organic" twice is not a doubled suffix — the segments between differ.
    const path = ["serp", "google", "organic", "live", "advanced"];
    expect(undouble(path)).toEqual(path);
    expect(undouble(["backlinks", "domain_pages", "live"])).toEqual([
      "backlinks",
      "domain_pages",
      "live",
    ]);
  });

  // `domain_analytics/technologies/technologies` is a live endpoint and
  // `domain_analytics/technologies` is a 404 — both verified against the API.
  // A single repeated segment is a real name, not the listing glitch.
  it("never trims a single repeated segment", () => {
    expect(undouble(["domain_analytics", "technologies", "technologies"])).toEqual([
      "domain_analytics",
      "technologies",
      "technologies",
    ]);
    expect(undouble(["a", "b", "b"])).toEqual(["a", "b", "b"]);
    expect(undouble(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("classify", () => {
  it("reads what a path is for", () => {
    expect(classify("/serp/google/organic/live/advanced")).toBe("live");
    expect(classify("/serp/google/organic/task_post")).toBe("task_post");
    expect(classify("/serp/google/organic/tasks_ready")).toBe("tasks_ready");
    expect(classify("/serp/google/organic/task_get/advanced/$id")).toBe("task_get");
    expect(classify("/serp/google/locations")).toBe("reference");
    expect(classify("/on_page/available_filters")).toBe("reference");
    expect(classify("/on_page/summary")).toBe("result");
  });

  // A queued endpoint served from a cache would hand back someone else's job,
  // and a cached "what has finished" would hide the job that just finished.
  it("only allows caching where caching is safe", () => {
    expect(cacheTtlFor("reference")).toBeGreaterThan(0);
    expect(cacheTtlFor("live")).toBeGreaterThan(0);
    expect(cacheTtlFor("task_post")).toBe(0);
    expect(cacheTtlFor("tasks_ready")).toBe(0);
    expect(cacheTtlFor("task_get")).toBe(0);
    expect(cacheTtlFor("result")).toBe(0);
  });
});

describe("labelFor", () => {
  it("turns a path into something readable", () => {
    expect(labelFor("/serp/google/organic/live/advanced", "serp")).toBe(
      "Google · Organic · Live · Advanced"
    );
    expect(labelFor("/dataforseo_labs/google/ranked_keywords/live", "dataforseo_labs")).toBe(
      "Google · Ranked Keywords · Live"
    );
  });
});

describe("adHocEndpoint", () => {
  // The catalogue is up to six hours stale. Refusing an endpoint because our
  // copy of the menu is old is exactly the failure this desk exists to avoid.
  it("accepts a path the catalogue has not heard of", () => {
    const endpoint = adHocEndpoint("v3/serp/google/brand_new/live", "serp");
    expect(endpoint.path).toBe("/serp/google/brand_new/live");
    expect(endpoint.kind).toBe("live");
    expect(endpoint.method).toBe("POST");
    expect(endpoint.price).toBeNull();
  });

  it("normalises however the path was pasted", () => {
    expect(adHocEndpoint("serp/google/locations", "serp").path).toBe("/serp/google/locations");
    expect(adHocEndpoint("/serp/google/locations", "serp").method).toBe("GET");
  });
});

describe("templateFor", () => {
  const endpoint = (path: string, method: "GET" | "POST" = "POST") => ({
    ...adHocEndpoint(path, "serp"),
    method,
  });

  it("prefills the fields a path's shape implies", () => {
    const params = templateFor(endpoint("/serp/google/organic/live/advanced"), {
      locationCode: 2826,
      languageCode: "en",
    });
    expect(params).toMatchObject({ keyword: expect.any(String), location_code: 2826, language_code: "en" });
  });

  // The backlink index is global. Sending it a country looks like it narrows
  // the answer, and it does not.
  it("leaves the market off the endpoints that have no market", () => {
    const params = templateFor(
      { ...adHocEndpoint("/backlinks/summary/live", "backlinks") },
      { locationCode: 2826 }
    );
    expect(params.location_code).toBeUndefined();
  });

  it("sends no body to a GET", () => {
    expect(templateFor(endpoint("/serp/google/locations", "GET"))).toEqual({});
  });

  it("offers an empty body rather than a guess when it has no rule", () => {
    expect(templateFor(endpoint("/some_family/nothing/we/know"))).toEqual({});
  });
});

describe("request identity", () => {
  it("keys a call on what was asked, not on key order", () => {
    expect(canonicalise({ b: 1, a: [{ d: 2, c: 3 }] })).toEqual({ a: [{ c: 3, d: 2 }], b: 1 });
    expect(JSON.stringify(canonicalise({ a: 1, b: 2 }))).toBe(JSON.stringify(canonicalise({ b: 2, a: 1 })));
  });

  it("puts a task id into the path it belongs in", () => {
    expect(withTaskId("/serp/google/organic/task_get/advanced/$id", "09171342-1")).toBe(
      "/serp/google/organic/task_get/advanced/09171342-1"
    );
  });
});
