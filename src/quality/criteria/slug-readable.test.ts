import { describe, it, expect } from "vitest";

import { DEFAULT_QUALITY_GATE_CONFIG } from "../config.js";
import { judgeSlug, looksEnglish, scoreSlugReadable } from "./slug-readable.js";

const config = DEFAULT_QUALITY_GATE_CONFIG;

describe("looksEnglish", () => {
  it("accepts ordinary English words, including consonant-heavy ones", () => {
    for (const w of ["flights", "strengths", "months", "global", "village", "opening", "dates", "visa", "checklist", "brunch", "yacht"]) {
      expect(looksEnglish(w), w).toBe(true);
    }
  });

  it("rejects mechanical transliterations", () => {
    for (const w of ["mdobrt", "chozrt", "mkom", "shmoshk", "lbdok", "lfni", "tzrich", "shmzminim", "atrktzih"]) {
      expect(looksEnglish(w), w).toBe(false);
    }
  });
});

describe("judgeSlug", () => {
  it("rejects the live defect: a vowel-less transliteration", () => {
    const v = judgeSlug("atrktzih-mdobrt-chozrt-mkom-shmoshk-milionim");
    expect(v.ok).toBe(false);
    expect(v.unreadable).toContain("atrktzih");
    expect(v.reason).toContain("transliteration");
  });

  it("accepts English keywords", () => {
    expect(judgeSlug("lantern-park-northport-opening-dates-2026-2027").ok).toBe(true);
    expect(judgeSlug("northport-visa-for-visitors").ok).toBe(true);
  });

  it("tolerates one odd token such as a brand or acronym", () => {
    expect(judgeSlug("kfc-menu-prices-guide").ok).toBe(true);
    expect(judgeSlug("city-rta-nol-card-guide").ok).toBe(true);
  });

  it("rejects a single word, too many words, and bad characters", () => {
    expect(judgeSlug("northport").ok).toBe(false);
    expect(judgeSlug("a-b-c-d-e-f-g-h-i-j").ok).toBe(false);
    expect(judgeSlug("東京-地下鉄").ok).toBe(false);
  });
});

describe("scoreSlugReadable", () => {
  it("is skipped when no slug was supplied", () => {
    expect(scoreSlugReadable({ title: "x" }, config).status).toBe("skipped");
  });

  it("blocks an unreadable slug", () => {
    const r = scoreSlugReadable({ title: "x", slug: "tzrich-lbdok-lfni-shmzminim" }, config);
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
  });

  it("passes a readable one", () => {
    expect(scoreSlugReadable({ title: "x", slug: "booking-flights-to-northport" }, config).status).toBe("pass");
  });
});

describe("slug must not name the outlet", () => {
  it("blocks the live defect: a slug made of the source domain", () => {
    const r = scoreSlugReadable(
      { title: "x", slug: "cityherald-example-com", sourceUrls: ["https://www.cityherald.example.com/travel/article/21415461"] },
      config
    );
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.details[0]).toContain("source outlet");
  });

  it("lets a topical slug through even when the source is a big outlet", () => {
    const r = scoreSlugReadable(
      { title: "x", slug: "easton-northport-direct-flights-ban-extended", sourceUrls: ["https://www.cityherald.example.com/x"] },
      config
    );
    expect(r.status).toBe("pass");
  });

  it("lets the outlet name through when the article is about the outlet", () => {
    const r = scoreSlugReadable(
      {
        title: "Inside GitHub’s new Git storage architecture",
        slug: "github-git-storage-architecture",
        sourceUrls: ["https://github.blog/engineering/storage/"],
      },
      config
    );
    expect(r.status).toBe("pass");
  });
});
