import { describe, expect, it, vi } from "vitest";

import { buildSerpOwnersSection } from "./serp-owners.js";
import type { SeoClient } from "../client.js";

const serp = (items: { domain: string; rank: number }[], cost = 0.002) => ({
  rows: items.map((item) => ({
    type: "organic",
    rank_absolute: item.rank,
    domain: item.domain,
    url: `https://${item.domain}/page`,
    title: "t",
    description: "d",
  })),
  head: null,
  results: [],
  costUsd: cost,
  taskId: null,
  statusMessage: "Ok.",
});

function clientReturning(pages: Record<string, ReturnType<typeof serp>>): SeoClient {
  return {
    post: vi.fn(async (_path: string, params: Record<string, unknown>) => {
      const page = pages[params.keyword as string];
      if (!page) throw new Error("no fixture");
      return page;
    }),
  } as unknown as SeoClient;
}

describe("buildSerpOwnersSection", () => {
  const pages = {
    "event hall": serp([
      { domain: "rival-a.co.uk", rank: 1 },
      { domain: "rival-b.co.uk", rank: 2 },
      { domain: "www.prospect.co.uk", rank: 7 },
    ]),
    "event garden": serp([
      { domain: "rival-a.co.uk", rank: 1 },
      { domain: "rival-c.co.uk", rank: 4 },
    ]),
  };

  it("names the domains that keep appearing, not the ones that appear once", async () => {
    const section = await buildSerpOwnersSection(clientReturning(pages), {
      domain: "prospect.co.uk",
      keywords: [
        { keyword: "event hall", volume: 500 },
        { keyword: "event garden", volume: 300 },
      ],
    });
    expect(section.owners.map((owner) => owner.domain)).toEqual(["rival-a.co.uk"]);
    expect(section.owners[0]).toMatchObject({ appearances: 2, bestPosition: 1 });
    // rival-b and rival-c each showed up once: noise, not an owner.
    expect(section.notes).toEqual([]);
  });

  // A prospect sitting at #7 as "www.prospect.co.uk" would otherwise be
  // reported as absent — telling a business it is nowhere when it is there.
  it("recognises the prospect however the SERP spells its host", async () => {
    const section = await buildSerpOwnersSection(clientReturning(pages), {
      domain: "https://prospect.co.uk/",
      keywords: [{ keyword: "event hall", volume: 500 }],
    });
    expect(section.keywords[0].prospectPosition).toBe(7);
    expect(section.prospectAppearances).toBe(1);
    // And it is never listed as one of its own competitors.
    expect(section.owners.some((owner) => owner.domain === "prospect.co.uk")).toBe(false);
  });

  it("buys the highest-demand phrases first, and no more than asked", async () => {
    const client = clientReturning(pages);
    await buildSerpOwnersSection(client, {
      domain: "prospect.co.uk",
      keywords: [
        { keyword: "event garden", volume: 300 },
        { keyword: "event hall", volume: 500 },
      ],
      limit: 1,
    });
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.post).mock.calls[0][1]).toMatchObject({ keyword: "event hall" });
  });

  // One phrase failing must not lose the other seven that were paid for.
  it("keeps the phrases that answered when one fails", async () => {
    const client = {
      post: vi.fn(async (_p: string, params: Record<string, unknown>) =>
        params.keyword === "bad" ? Promise.reject(new Error("boom")) : pages["event hall"]
      ),
    } as unknown as SeoClient;

    const section = await buildSerpOwnersSection(client, {
      domain: "prospect.co.uk",
      keywords: [
        { keyword: "event hall", volume: 500 },
        { keyword: "bad", volume: 400 },
      ],
    });
    expect(section.keywords).toHaveLength(1);
    expect(section.notes).toContain("serp-failed:1");
    expect(section.costUsd).toBeCloseTo(0.002, 6);
  });

  it("says so rather than guessing when there are no phrases to look at", async () => {
    const section = await buildSerpOwnersSection(clientReturning({}), {
      domain: "prospect.co.uk",
      keywords: [],
    });
    expect(section).toMatchObject({ keywords: [], owners: [], costUsd: 0, notes: ["no-keywords"] });
  });
});
