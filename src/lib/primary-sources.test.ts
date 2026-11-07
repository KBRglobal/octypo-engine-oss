import { describe, it, expect, vi } from "vitest";

import { candidatePrimaryLinks, discoverPrimarySources, usablePrimarySources } from "./primary-sources.js";

const PUBLISHER = "https://www.timeout.example.com/news/lantern-park-season-31";
const HTML = `
<html><body>
<a href="https://www.timeout.example.com/things-to-do">More</a>
<a href="https://www.lanternpark.example.org/">Lantern Park</a>
<a href="https://www.instagram.com/lanternparkofficial">Instagram</a>
<a href="https://citynews.example.com/local/x">City News</a>
<a href="https://www.parkholding.example.org/en/">Park Holding</a>
<a href="https://www.googletagmanager.com/gtm.js">tag</a>
<a href="https://www.lanternpark.example.org/tickets">Tickets</a>
</body></html>`;

describe("candidatePrimaryLinks", () => {
  it("keeps official outbound sites, one per host, and drops news, social and trackers", () => {
    expect(candidatePrimaryLinks(HTML, PUBLISHER)).toEqual([
      "https://www.lanternpark.example.org/",
      "https://www.parkholding.example.org/en/",
    ]);
  });
});

describe("discoverPrimarySources", () => {
  it("opens the candidates and records what it saw, reachable first", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === PUBLISHER) return { ok: true, status: 200, url, text: async () => HTML };
      if (url.startsWith("https://www.parkholding.example.org")) return { ok: false, status: 503, url, text: async () => "" };
      return { ok: true, status: 200, url, text: async () => "<html/>" };
    });
    const now = new Date("2026-09-15T08:00:00Z");
    const checks = await discoverPrimarySources(PUBLISHER, fetchImpl as never, now);
    expect(checks.map(c => [c.url, c.httpStatus])).toEqual([
      ["https://www.lanternpark.example.org/", 200],
      ["https://www.parkholding.example.org/en/", 503],
    ]);
    expect(checks[0].checkedAt).toBe("2026-09-15T08:00:00.000Z");
    expect(usablePrimarySources(checks)).toEqual([{ url: "https://www.lanternpark.example.org/", checkedAt: "2026-09-15T08:00:00.000Z" }]);
  });

  it("returns nothing for an aggregator or an unreachable publisher", async () => {
    const dead = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await discoverPrimarySources("https://news.google.com/rss/articles/x", dead as never)).toEqual([]);
    expect(await discoverPrimarySources(PUBLISHER, dead as never)).toEqual([]);
  });
});
