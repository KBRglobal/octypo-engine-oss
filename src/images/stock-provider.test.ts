import { describe, it, expect, vi } from "vitest";
import { StockImageProvider, toSearchQuery, buildAltText } from "./stock-provider.js";

const upload = async (_d: Buffer, key: string) => `https://cdn.test/${key}`;

/** A tiny real JPEG so sharp has something genuine to decode. */
async function tinyJpeg(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 40, g: 90, b: 160 } },
  })
    .jpeg()
    .toBuffer();
}

function pexelsResponse(alt: string) {
  return {
    photos: [
      {
        id: 1,
        width: 4000,
        height: 2600,
        alt,
        photographer: "A Photographer",
        url: "https://pexels.test/photo/1",
        src: { original: "https://images.test/1.jpg" },
      },
    ],
  };
}

describe("search query construction", () => {
  it("uses the keyword rather than the headline", () => {
    // Stock engines match nouns; a full headline finds nothing.
    expect(toSearchQuery("How LED trucks reach customers in Lyon, and what it costs", ["led truck advertising"]))
      .toBe("led truck advertising");
  });

  it("falls back to significant words from the title", () => {
    const q = toSearchQuery("The complete guide to digital signage for retail", []);
    expect(q).not.toContain("The");
    expect(q.split(" ").length).toBeLessThanOrEqual(5);
  });
});

describe("alt text", () => {
  it("prefers the photo's own description over the headline", () => {
    // Google ranks a description of the image above a repeat of the topic.
    expect(buildAltText("LED truck advertising", "City street at night with an illuminated billboard truck"))
      .toBe("City street at night with an illuminated billboard truck");
  });

  it("falls back to the topic when the description is useless", () => {
    expect(buildAltText("LED truck advertising", "")).toBe("LED truck advertising");
  });
});

describe("StockImageProvider — hero reuse guard (SEO-E)", () => {
  it("skips a candidate already in use and takes the next one", async () => {
    const jpeg = await tinyJpeg();
    const twoCandidates = {
      photos: [
        {
          id: 1,
          width: 4000,
          height: 2600,
          alt: "Billboard truck advertising on a city street",
          photographer: "P1",
          url: "https://pexels.test/photo/1",
          src: { original: "https://images.test/X.jpg" },
        },
        {
          id: 2,
          width: 4000,
          height: 2600,
          alt: "Billboard truck advertising near a stadium",
          photographer: "P2",
          url: "https://pexels.test/photo/2",
          src: { original: "https://images.test/Y.jpg" },
        },
      ],
    };
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      fetched.push(url);
      if (url.includes("api.pexels.com")) {
        return new Response(JSON.stringify(twoCandidates), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fetchImpl });

    const result = await provider.getArticleImage("billboard truck advertising", [], "news", {
      excludeUrls: ["https://images.test/X.jpg"],
    });
    expect(result).not.toBeNull();
    // The in-use candidate X was never even downloaded; Y was stored instead.
    expect(fetched).not.toContain("https://images.test/X.jpg");
    expect(fetched).toContain("https://images.test/Y.jpg");
  });

  it("recognises an in-use CDN URL — what contents.heroImage actually stores", async () => {
    // The row stores the UPLOADED delivery URL, not the stock download URL, so
    // the guard must match by the candidate identity embedded in the key.
    const jpeg = await tinyJpeg();
    const twoCandidates = {
      photos: [
        {
          id: 1,
          width: 4000,
          height: 2600,
          alt: "Billboard truck advertising on a city street",
          photographer: "P1",
          url: "https://pexels.test/photo/1",
          src: { original: "https://images.test/X.jpg" },
        },
        {
          id: 2,
          width: 4000,
          height: 2600,
          alt: "Billboard truck advertising near a stadium",
          photographer: "P2",
          url: "https://pexels.test/photo/2",
          src: { original: "https://images.test/Y.jpg" },
        },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("api.pexels.com")) {
        return new Response(JSON.stringify(twoCandidates), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fetchImpl });

    // First run stores candidate 1 and returns its CDN URL.
    const first = await provider.getArticleImage("billboard truck advertising", [], "news");
    expect(first!.url).toContain("-pexels-1.");

    // Second run, excluding the STORED URL (with an R2-style content hash too),
    // must take candidate 2 — never the same photo twice.
    for (const inUse of [first!.url, first!.url.replace(".webp", "-abc123.webp")]) {
      const second = await provider.getArticleImage("billboard truck advertising", [], "news", {
        excludeUrls: [inUse],
      });
      expect(second).not.toBeNull();
      expect(second!.url).toContain("-pexels-2.");
    }
  });
});

describe("StockImageProvider", () => {
  it("uses a relevant stock photo and stores it optimised", async () => {
    const jpeg = await tinyJpeg();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("api.pexels.com")) {
        return new Response(JSON.stringify(pexelsResponse("Billboard truck advertising on a city street")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({
      keys: { pexels: "k" },
      upload,
      fetchImpl,
    });

    const result = await provider.getArticleImage("billboard truck advertising", [], "news");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("stock:pexels");
    expect(result!.url).toMatch(/\.webp$/);
    expect(result!.altText).toContain("Billboard");
  });

  it("stores the original bytes when the customer has not bought optimisation", async () => {
    // Optimisation is a paid add-on. Withholding it must not break the image —
    // and the stored key must not claim .webp for a JPEG, because a CDN will
    // cache that mismatch for a year.
    const jpeg = await tinyJpeg();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("api.pexels.com")) {
        return new Response(JSON.stringify(pexelsResponse("Billboard truck advertising on a city street")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;

    const stored: { key: string; type: string; bytes: number }[] = [];
    const provider = new StockImageProvider({
      keys: { pexels: "k" },
      upload: async (data: Buffer, key: string, contentType: string) => {
        stored.push({ key, type: contentType, bytes: data.length });
        return `https://cdn.test/${key}`;
      },
      fetchImpl,
      optimise: false,
    });

    const result = await provider.getArticleImage("billboard truck advertising", [], "news");
    expect(result).not.toBeNull();
    expect(result!.url).toMatch(/\.jpg$/);
    expect(stored[0].type).toBe("image/jpeg");
    expect(stored[0].bytes).toBe(jpeg.length); // untouched
  });

  it("refuses stock for a political topic and hands off to generation", async () => {
    // Pixabay forbids their content in a political context outright. Nobody
    // reviews these, so the refusal has to be automatic.
    const fallback = { getArticleImage: vi.fn(async () => ({ url: "g", altText: "a", source: "generated" })) };
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback, fetchImpl });
    const result = await provider.getArticleImage("Election campaign coverage", [], "news");

    expect(fetchImpl).not.toHaveBeenCalled(); // never even searched
    expect(fallback.getArticleImage).toHaveBeenCalled();
    expect(result!.source).toBe("generated");
  });

  it("falls back rather than publishing an irrelevant photo", async () => {
    // The real failure this guards: a live search for "led truck advertising"
    // returned a Christmas ornament.
    const fallback = { getArticleImage: vi.fn(async () => ({ url: "g", altText: "a", source: "generated" })) };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(pexelsResponse("christmas ornament lights bokeh")), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback, fetchImpl });
    const result = await provider.getArticleImage("led truck advertising campaign", [], "news");

    expect(fallback.getArticleImage).toHaveBeenCalled();
    expect(result!.source).toBe("generated");
  });

  it("returns null rather than throwing when everything declines", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ photos: [] }), { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback: null, fetchImpl });
    expect(await provider.getArticleImage("some topic", [], "news")).toBeNull();
  });

  it("survives a provider outage without breaking the article", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback: null, fetchImpl });
    expect(await provider.getArticleImage("some topic", [], "news")).toBeNull();
  });
});

describe("hero vs body slots", () => {
  /** Pexels answers `query` with a photo whose alt is taken from `byQuery`. */
  function searchStub(jpeg: Buffer, byQuery: Record<string, string>) {
    return vi.fn(async (url: string) => {
      if (url.includes("api.pexels.com")) {
        const query = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
        const alt = byQuery[query];
        return new Response(JSON.stringify(alt ? pexelsResponse(alt) : { photos: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(jpeg, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("generates the hero rather than accepting a merely thematic photo", async () => {
    // The measured failure: a broad rung returned a laptop on a desk for an
    // article about LED advertising trucks. Good enough beside the text, not
    // good enough as the image the article is known by.
    const jpeg = await tinyJpeg();
    const fallback = { getArticleImage: vi.fn(async () => ({ url: "g", altText: "a", source: "generated" })) };
    const fetchImpl = searchStub(jpeg, { "marketing team office": "Laptop on a desk in an office" });

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback, fetchImpl });
    const result = await provider.getArticleImage("LED truck advertising campaigns", ["led truck advertising"], "news");

    expect(result!.source).toBe("generated");
  });

  it("accepts that same thematic photo for a body image", async () => {
    const jpeg = await tinyJpeg();
    const fetchImpl = searchStub(jpeg, { "marketing team office": "Marketing team working in a bright office" });

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fetchImpl });
    const images = await provider.getBodyImages("LED truck advertising campaigns", ["led truck advertising"], "news", 2);

    expect(images.length).toBeGreaterThan(0);
    expect(images[0].source).toBe("stock:pexels");
  });

  it("never generates a body image, even when stock finds nothing", async () => {
    const fallback = { getArticleImage: vi.fn(async () => ({ url: "g", altText: "a", source: "generated" })) };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ photos: [] }), { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;

    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fallback, fetchImpl });

    expect(await provider.getBodyImages("some topic", [], "news", 2)).toEqual([]);
    expect(fallback.getArticleImage).not.toHaveBeenCalled();
  });

  it("refuses body images for a restricted subject without generating instead", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = new StockImageProvider({ keys: { pexels: "k" }, upload, fetchImpl });

    expect(await provider.getBodyImages("Election campaign coverage", [], "news", 2)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
