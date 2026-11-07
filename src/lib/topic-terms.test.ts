import { describe, expect, it } from "vitest";

import { contentTerms, frequentTokens, normaliseText, termsMatch } from "./topic-terms.js";

describe("normaliseText", () => {
  it("drops quotes and punctuation, keeping one space between tokens", () => {
    expect(normaliseText("O'Brien's  “Guide”: part-two!")).toBe("obriens guide part two");
  });

  it("ignores optional vowel pointing", () => {
    expect(normaliseText("مَدِينَة")).toBe(normaliseText("مدينة"));
  });

  it("keeps marks that are part of a word", () => {
    expect(normaliseText("हिन्दी समाचार").split(" ")).toEqual(["हिन्दी", "समाचार"]);
    expect(normaliseText("ข่าว").split(" ").join("")).toBe("ข่าว");
  });

  it("splits a script written without spaces into words", () => {
    const tokens = normaliseText("東京都が新しい地下鉄路線を発表").split(" ");
    expect(tokens).toEqual(expect.arrayContaining(["地下鉄"]));
    expect(tokens.length).toBeGreaterThan(3);
  });
});

describe("contentTerms", () => {
  it("drops English function words, numbers and generic words", () => {
    expect(contentTerms("The best guide to Northport harbor 2026").map((t) => t.raw)).toEqual(["northport", "harbor"]);
  });

  it("treats an English plural as the same term", () => {
    expect(termsMatch(contentTerms("hotels")[0], contentTerms("hotel")[0])).toBe(true);
    expect(termsMatch(contentTerms("cities")[0], contentTerms("city")[0])).toBe(true);
    expect(termsMatch(contentTerms("glass")[0], contentTerms("glas")[0])).toBe(false);
  });

  it("keeps words of any script as terms", () => {
    expect(contentTerms("東京都の地下鉄").map((t) => t.raw)).toEqual(expect.arrayContaining(["地下鉄"]));
    expect(contentTerms("مترو المدينة")).toHaveLength(2);
  });

  it("folds a concept across its phrases, on whole tokens only", () => {
    const concepts = [{ id: "beach", phrases: ["beach", "seaside"] }];
    const [one] = contentTerms("seaside", { concepts });
    const [two] = contentTerms("beach", { concepts });
    expect(one.concept).toBe(true);
    expect(termsMatch(one, two)).toBe(true);
    expect(contentTerms("beachwear", { concepts })[0].concept).toBe(false);
  });
});

describe("frequentTokens", () => {
  it("needs a corpus, then finds what every document repeats", () => {
    expect(frequentTokens(["northport one"], 0.3, 8).size).toBe(0);
    const docs = Array.from({ length: 8 }, (_, i) => `northport topic${i}`);
    expect([...frequentTokens(docs, 0.3, 8)]).toEqual(["northport"]);
  });
});
