import { describe, it, expect } from "vitest";

import { evaluateSiteCheck } from "./site-check.js";
import type { SiteInventory } from "./site-inventory.js";

const inventory: SiteInventory = {
  origin: "https://northport.example.com",
  paths: ["/", "/attractions/", "/events/", "/articles/a/", "/articles/b/", "/articles/c/", "/guides/x/"],
  fetchedAt: "2026-09-15T08:00:00.000Z",
  error: "",
};

describe("evaluateSiteCheck", () => {
  it("passes when articles live under the configured prefix", () => {
    const c = evaluateSiteCheck(inventory, "https://northport.example.com", "/articles");
    expect(c.sitemapOk).toBe(true);
    expect(c.prefixOk).toBe(true);
    expect(c.pageCount).toBe(7);
  });

  it("catches the live defect: /insights configured, /articles on the site", () => {
    const c = evaluateSiteCheck(inventory, "https://northport.example.com", "/insights");
    expect(c.sitemapOk).toBe(true);
    expect(c.prefixOk).toBe(false);
    expect(c.observedPrefixes[0]).toBe("/articles/");
  });

  it("does not blame the prefix when the sitemap itself is unreadable", () => {
    const c = evaluateSiteCheck({ ...inventory, paths: [], error: "HTTP 404" }, "https://northport.example.com", "/insights");
    expect(c.sitemapOk).toBe(false);
    expect(c.prefixOk).toBe(true);
    expect(c.error).toBe("HTTP 404");
  });
});
