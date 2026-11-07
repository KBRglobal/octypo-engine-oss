import { describe, it, expect, vi } from "vitest";

import { decodeGoogleNewsUrl, isAggregatorUrl, looksLikeNewsOrSocialHost, resolveSourceUrl } from "./source-url.js";

/** A Google News RSS id of the older kind: the publisher URL sits in clear text inside. */
function googleNewsId(publisherUrl: string): string {
  const inner = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22]),
    Buffer.from([publisherUrl.length]),
    Buffer.from(publisherUrl, "latin1"),
    Buffer.from([0xd2, 0x01, 0x00]),
  ]);
  return "CBMi" + inner.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("isAggregatorUrl", () => {
  it("flags Google News and redirectors", () => {
    expect(isAggregatorUrl("https://news.google.com/rss/articles/CBMiAAA?oc=5")).toBe(true);
    expect(isAggregatorUrl("https://feedproxy.google.com/~r/x/y")).toBe(true);
    expect(isAggregatorUrl("https://t.co/abc")).toBe(true);
    expect(isAggregatorUrl("https://news.google.fr/articles/abc")).toBe(true);
  });

  it("lets a publisher through", () => {
    expect(isAggregatorUrl("https://www.cityherald.example.com/news/article/123")).toBe(false);
    expect(isAggregatorUrl("https://www.lanternpark.example.org/")).toBe(false);
  });

  it("does not choke on garbage", () => {
    expect(isAggregatorUrl("not a url")).toBe(false);
  });
});

describe("decodeGoogleNewsUrl", () => {
  it("recovers the publisher URL from a CBMi id", () => {
    const publisher = "https://www.timeout.example.com/news/lantern-park-season-31";
    const url = `https://news.google.com/rss/articles/${googleNewsId(publisher)}?oc=5`;
    expect(decodeGoogleNewsUrl(url)).toBe(publisher);
  });

  it("returns null for an opaque id", () => {
    expect(decodeGoogleNewsUrl("https://news.google.com/rss/articles/AU_yqLPCQsDvGTehpVyUlIo?oc=5")).toBeNull();
  });

  it("returns null for a non-Google host", () => {
    expect(decodeGoogleNewsUrl("https://example.com/articles/CBMiAAA")).toBeNull();
  });
});

describe("resolveSourceUrl", () => {
  it("leaves a publisher URL untouched without touching the network", async () => {
    const fetchImpl = vi.fn();
    const out = await resolveSourceUrl("https://www.cityherald.example.com/news/1", fetchImpl as never);
    expect(out).toEqual({ url: "https://www.cityherald.example.com/news/1", via: "as-is" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("decodes before it fetches", async () => {
    const publisher = "https://gulfnews.com/uae/story";
    const fetchImpl = vi.fn();
    const out = await resolveSourceUrl(
      `https://news.google.com/rss/articles/${googleNewsId(publisher)}?oc=5`,
      fetchImpl as never
    );
    expect(out).toEqual({ url: publisher, via: "decoded" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows the redirect for an opaque id", async () => {
    const fetchImpl = vi.fn(async () => ({
      url: "https://www.khaleejtimes.com/uae/story",
      status: 200,
      ok: true,
      text: async () => "",
    }));
    const out = await resolveSourceUrl("https://news.google.com/rss/articles/AU_yqLopaque?oc=5", fetchImpl as never);
    expect(out).toEqual({ url: "https://www.khaleejtimes.com/uae/story", via: "redirect" });
  });

  it("reads the publisher link out of Google's interstitial HTML", async () => {
    const fetchImpl = vi.fn(async () => ({
      url: "https://news.google.com/rss/articles/AU_yqLopaque",
      status: 200,
      ok: true,
      text: async () => `<html><body><a href="https://www.thenationalnews.com/uae/story" rel="nofollow">Open</a></body></html>`,
    }));
    const out = await resolveSourceUrl("https://news.google.com/rss/articles/AU_yqLopaque?oc=5", fetchImpl as never);
    expect(out).toEqual({ url: "https://www.thenationalnews.com/uae/story", via: "html-redirect" });
  });

  it("marks an unresolvable link instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await resolveSourceUrl("https://news.google.com/rss/articles/AU_yqLopaque?oc=5", fetchImpl as never);
    expect(out.via).toBe("unresolved");
    expect(out.url).toContain("news.google.com");
  });
});

describe("looksLikeNewsOrSocialHost", () => {
  it("treats news outlets and social networks as secondary", () => {
    expect(looksLikeNewsOrSocialHost("https://www.cityherald.example.com/x")).toBe(true);
    expect(looksLikeNewsOrSocialHost("https://www.instagram.com/lanternparkofficial")).toBe(true);
  });

  it("treats an organiser's own site as primary", () => {
    expect(looksLikeNewsOrSocialHost("https://www.lanternpark.example.org/")).toBe(false);
    expect(looksLikeNewsOrSocialHost("https://www.northportairport.example.org/")).toBe(false);
  });
});

describe("resolveGoogleNewsViaSplash", () => {
  it("exchanges the page signature for the publisher URL", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push(url);
      if (url.includes("/rss/articles/")) {
        return { url, status: 200, ok: true, text: async () => `<c-wiz data-n-a-id="x" data-n-a-sg="SIGNATURE" data-n-a-ts="1789465528"></c-wiz>` };
      }
      expect(init?.body).toContain("garturlreq");
      expect(init?.body).toContain("SIGNATURE");
      return {
        url,
        status: 200,
        ok: true,
        text: async () =>
          `)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.cityherald.example.com/travel/article/21415461\\",\\"https://www.cityherald.example.com/travel/article/21415461?amp\\"]",null,null,null,"generic"]]`,
      };
    });
    const out = await resolveSourceUrl("https://news.google.com/rss/articles/AU_yqLopaqueId?oc=5", fetchImpl as never);
    expect(out).toEqual({ url: "https://www.cityherald.example.com/travel/article/21415461", via: "decoded" });
    expect(calls[1]).toContain("batchexecute");
  });
});
