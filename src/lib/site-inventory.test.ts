import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  fetchSiteInventory,
  linkablePaths,
  parseSitemapPaths,
  resetSiteInventoryCache,
  siteInventory,
  slugsFromPaths,
} from "./site-inventory.js";

const SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://northport.example.com/</loc></url>
  <url><loc>https://northport.example.com/attractions/</loc></url>
  <url><loc>https://northport.example.com/events/</loc></url>
  <url><loc>https://northport.example.com/articles/getting-there/</loc></url>
  <url><loc>https://northport.example.com/articles/lantern-park-opening-dates-2026-2027/</loc></url>
  <url><loc>https://other.example/ignored/</loc></url>
</urlset>`;

function fetchStub(bodies: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const body = bodies[url];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? "" };
  });
}

beforeEach(() => resetSiteInventoryCache());

describe("parseSitemapPaths", () => {
  it("keeps only this origin's paths, normalised with a trailing slash", () => {
    expect(parseSitemapPaths(SITEMAP, "https://northport.example.com")).toEqual([
      "/",
      "/attractions/",
      "/events/",
      "/articles/getting-there/",
      "/articles/lantern-park-opening-dates-2026-2027/",
    ]);
  });
});

describe("fetchSiteInventory", () => {
  it("reads sitemap.xml and follows a sitemap index", async () => {
    const index = `<sitemapindex><sitemap><loc>https://northport.example.com/sitemap-0.xml</loc></sitemap></sitemapindex>`;
    const fetchImpl = fetchStub({
      "https://northport.example.com/sitemap.xml": index,
      "https://northport.example.com/sitemap-0.xml": SITEMAP,
    });
    const inv = await fetchSiteInventory("https://northport.example.com/", fetchImpl as never);
    expect(inv.error).toBe("");
    expect(inv.paths).toContain("/attractions/");
    expect(inv.paths).toContain("/articles/getting-there/");
  });

  it("reports a missing sitemap instead of throwing", async () => {
    const inv = await fetchSiteInventory("https://northport.example.com", fetchStub({}) as never);
    expect(inv.paths).toEqual([]);
    expect(inv.error).toContain("HTTP 404");
  });

  it("rejects a bad SITE_URL", async () => {
    const inv = await fetchSiteInventory("nope", fetchStub({}) as never);
    expect(inv.error).toContain("not a valid URL");
  });
});

describe("siteInventory cache", () => {
  it("fetches once a day and serves the cache after", async () => {
    const fetchImpl = fetchStub({ "https://northport.example.com/sitemap.xml": SITEMAP });
    const t0 = new Date("2026-09-15T00:00:00Z");
    await siteInventory("https://northport.example.com", fetchImpl as never, t0);
    await siteInventory("https://northport.example.com", fetchImpl as never, new Date(t0.getTime() + 60_000));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await siteInventory("https://northport.example.com", fetchImpl as never, new Date(t0.getTime() + 25 * 3600_000));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("is empty without SITE_URL", async () => {
    const inv = await siteInventory("", fetchStub({}) as never);
    expect(inv.paths).toEqual([]);
    expect(inv.error).toContain("SITE_URL");
  });
});

describe("helpers", () => {
  const paths = parseSitemapPaths(SITEMAP, "https://northport.example.com");

  it("slugsFromPaths yields the last segment the link audit compares on", () => {
    expect(slugsFromPaths(paths)).toEqual(
      expect.arrayContaining(["attractions", "events", "getting-there", "lantern-park-opening-dates-2026-2027"])
    );
  });

  it("linkablePaths offers hubs first, then articles under the prefix", () => {
    expect(linkablePaths(paths, "/articles")).toEqual([
      "/attractions/",
      "/events/",
      "/articles/getting-there/",
      "/articles/lantern-park-opening-dates-2026-2027/",
    ]);
  });
});

describe("sitemap discovery", () => {
  it("falls back to Astro's sitemap-index.xml when sitemap.xml is missing", async () => {
    const index = `<sitemapindex><sitemap><loc>https://client.example.org/sitemap-0.xml</loc></sitemap></sitemapindex>`;
    const body = `<urlset><url><loc>https://client.example.org/services/</loc></url><url><loc>https://client.example.org/insights/a/</loc></url></urlset>`;
    const fetchImpl = fetchStub({ "https://client.example.org/sitemap-index.xml": index, "https://client.example.org/sitemap-0.xml": body });
    const inv = await fetchSiteInventory("https://client.example.org", fetchImpl as never);
    expect(inv.error).toBe("");
    expect(inv.paths).toEqual(["/insights/a/", "/services/"]);
  });

  it("reads the Sitemap line from robots.txt as a last resort", async () => {
    const fetchImpl = fetchStub({
      "https://example.com/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://example.com/maps/site.xml\n",
      "https://example.com/maps/site.xml": `<urlset><url><loc>https://example.com/about/</loc></url></urlset>`,
    });
    const inv = await fetchSiteInventory("https://example.com", fetchImpl as never);
    expect(inv.paths).toEqual(["/about/"]);
  });

  it("sends a browser-like user agent", async () => {
    const fetchImpl = fetchStub({ "https://northport.example.com/sitemap.xml": SITEMAP });
    await fetchSiteInventory("https://northport.example.com", fetchImpl as never);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
    expect(init.headers["user-agent"]).toContain("Mozilla/5.0");
  });
});
