import { describe, it, expect } from "vitest";
import { BankImageProvider, isBankManifest, scoreImage, tokenize } from "./bank-provider.js";
import type { ArticleImageResult, ImageProvider } from "../lib/image-provider.js";

const manifest = {
  version: 1,
  images: [
    {
      url: "https://cdn.example/bank/screen/night.webp",
      alt: "A mobile LED screen lit at night with an opening ad for a shopping centre",
      caption: "LED screen unit in an opening campaign",
      tags: ["led screen", "night", "campaign"],
      category: "screen",
    },
    {
      url: "https://cdn.example/bank/event/crowd.webp",
      alt: "A large crowd at a city event facing a lit stage on a summer evening",
      caption: "City event",
      tags: ["event", "crowd", "stage"],
      category: "event",
    },
    {
      url: "https://cdn.example/bank/crew/setup.webp",
      alt: "A technical crew mounts an LED screen on a trailer before an event",
      caption: "Setup on site",
      tags: ["crew", "setup", "led screen"],
      category: "crew",
    },
  ],
};

const fetchImpl = (async () => new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch;

class FakeFallback implements ImageProvider {
  calls = 0;
  async getArticleImage(): Promise<ArticleImageResult | null> {
    this.calls++;
    return { url: "https://cdn.example/generated.webp", altText: "generated", source: "generated" };
  }
  async getBodyImages(_t: string, _k: string[], _c: string, count: number): Promise<ArticleImageResult[]> {
    this.calls++;
    return Array.from({ length: count }, (_, i) => ({
      url: `https://cdn.example/stock-${i}.webp`,
      altText: "stock",
      source: "stock",
    }));
  }
}

describe("image bank provider", () => {
  it("tokenizes any script into words", () => {
    expect(tokenize("Mobile LED, screen!")).toEqual(["mobile", "led", "screen"]);
    expect(tokenize("夜の地下鉄の駅")).toEqual(expect.arrayContaining(["地下鉄"]));
    expect(tokenize("شاشة عرض")).toEqual(["شاشة", "عرض"]);
  });

  it("scores tag matches above alt-only matches", () => {
    const led = scoreImage(manifest.images[0], "advertising on a mobile led screen", ["led screen"]);
    const crowd = scoreImage(manifest.images[1], "advertising on a mobile led screen", ["led screen"]);
    expect(led).toBeGreaterThan(crowd);
  });

  it("rejects manifests with short alt text or non-webp urls", () => {
    expect(isBankManifest(manifest)).toBe(true);
    expect(isBankManifest({ images: [{ url: "https://x/a.jpg", alt: "A mobile LED screen lit at night with an ad" }] })).toBe(false);
    expect(isBankManifest({ images: [{ url: "https://x/a.webp", alt: "Too short" }] })).toBe(false);
  });

  it("takes the hero from the bank and leaves the fallback idle", async () => {
    const fallback = new FakeFallback();
    const provider = new BankImageProvider({ manifestUrl: "https://cdn.example/manifest.json", fallback, fetchImpl });
    const hero = await provider.getArticleImage("advertising on a mobile led screen", ["led screen"], "guide");
    expect(hero?.url).toBe("https://cdn.example/bank/screen/night.webp");
    expect(hero?.source).toBe("bank");
    expect(fallback.calls).toBe(0);
  });

  it("skips excluded urls so two articles never share a hero", async () => {
    const provider = new BankImageProvider({ manifestUrl: "https://cdn.example/manifest.json", fetchImpl });
    const hero = await provider.getArticleImage("advertising on a mobile led screen", ["led screen"], "guide", {
      excludeUrls: ["https://cdn.example/bank/screen/night.webp"],
    });
    expect(hero?.url).toBe("https://cdn.example/bank/crew/setup.webp");
  });

  it("falls back when the bank has nothing about the topic", async () => {
    const fallback = new FakeFallback();
    const provider = new BankImageProvider({ manifestUrl: "https://cdn.example/manifest.json", fallback, fetchImpl });
    const hero = await provider.getArticleImage("car insurance", ["policy"], "guide");
    expect(hero?.source).toBe("generated");
    expect(fallback.calls).toBe(1);
  });

  it("fills body slots from the bank and tops up from the fallback", async () => {
    const fallback = new FakeFallback();
    const provider = new BankImageProvider({ manifestUrl: "https://cdn.example/manifest.json", fallback, fetchImpl });
    const body = await provider.getBodyImages("led screen at night", ["led screen"], "guide", 3);
    expect(body.length).toBe(3);
    expect(body.filter((img) => img.source === "bank").length).toBe(2);
    expect(new Set(body.map((img) => img.url)).size).toBe(3);
  });

  it("survives an unreachable manifest by using the fallback", async () => {
    const fallback = new FakeFallback();
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const provider = new BankImageProvider({ manifestUrl: "https://cdn.example/manifest.json", fallback, fetchImpl: failing });
    const hero = await provider.getArticleImage("led screen", ["led screen"], "guide");
    expect(hero?.source).toBe("generated");
  });

  it("hands an explicit art-direction prompt to the fallback instead of the closest bank photo", async () => {
    const fallback = new FakeFallback();
    const bank = new BankImageProvider({ manifestUrl: "https://cdn.example/m.json", fallback, fetchImpl });
    const result = await bank.getArticleImage("mobile led screen at night", ["led screen"], "screen", {
      prompt: "A mobile LED screen at night",
      altText: "Illustration of a mobile LED screen at night",
    });
    expect(result?.url).toBe("https://cdn.example/generated.webp");
    expect(fallback.calls).toBe(1);
  });
});
