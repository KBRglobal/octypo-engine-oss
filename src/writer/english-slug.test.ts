import { describe, it, expect } from "vitest";

import { sanitiseEnglishSlug, slugStyle, englishSlug } from "./english-slug.js";

describe("slugStyle", () => {
  it("defaults to english", () => {
    expect(slugStyle({} as NodeJS.ProcessEnv)).toBe("english");
    expect(slugStyle({ SLUG_STYLE: "" } as NodeJS.ProcessEnv)).toBe("english");
    expect(slugStyle({ SLUG_STYLE: "weird" } as NodeJS.ProcessEnv)).toBe("english");
  });

  it("honors native", () => {
    expect(slugStyle({ SLUG_STYLE: "native" } as NodeJS.ProcessEnv)).toBe("native");
    expect(slugStyle({ SLUG_STYLE: " Native " } as NodeJS.ProcessEnv)).toBe("native");
  });
});

describe("sanitiseEnglishSlug", () => {
  it("accepts a clean 3-6 word slug", () => {
    expect(sanitiseEnglishSlug("led-screen-rental-prices")).toBe("led-screen-rental-prices");
  });

  it("normalises case, spaces and stray punctuation", () => {
    expect(sanitiseEnglishSlug("  LED Screen Rental! ")).toBe("led-screen-rental");
    expect(sanitiseEnglishSlug("/led_screen__rental/")).toBe("led-screen-rental");
  });

  it("rejects non-Latin, single-word, and over-long output", () => {
    expect(sanitiseEnglishSlug("プロジェクター-レンタル-料金")).toBeNull();
    expect(sanitiseEnglishSlug("rental")).toBeNull();
    expect(sanitiseEnglishSlug("a-b-c-d-e-f-g-h")).toBeNull();
    expect(sanitiseEnglishSlug("x".repeat(80))).toBeNull();
    expect(sanitiseEnglishSlug("")).toBeNull();
  });
});

describe("englishSlug with injected translator", () => {
  it("returns the sanitised translator output", async () => {
    const slug = await englishSlug("プロジェクターのレンタル料金", "プロジェクター レンタル", async () => "LED Screen Rental Cost");
    expect(slug).toBe("led-screen-rental-cost");
  });

  it("returns null when the translator fails or returns junk", async () => {
    expect(await englishSlug("t", "k", async () => null)).toBeNull();
    expect(await englishSlug("t", "k", async () => "映写機")).toBeNull();
  });
});
