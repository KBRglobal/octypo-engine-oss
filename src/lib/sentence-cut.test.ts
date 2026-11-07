import { describe, it, expect } from "vitest";

import { endsLikeSentence, firstSentencesWithin, splitSentences } from "./sentence-cut.js";

describe("splitSentences", () => {
  it("splits prose on terminators", () => {
    expect(splitSentences("Lantern Park opens in October. Tickets go on sale later! What else?")).toEqual([
      "Lantern Park opens in October.",
      "Tickets go on sale later!",
      "What else?",
    ]);
  });

  it("splits non-Latin prose on its own terminators", () => {
    expect(splitSentences("公園は十月に開園します。チケットは後日発売！")).toEqual(["公園は十月に開園します。", "チケットは後日発売！"]);
    expect(splitSentences("متى يفتح المنتزه؟ يفتح في أكتوبر.")).toEqual(["متى يفتح المنتزه؟", "يفتح في أكتوبر."]);
  });

  it("keeps a trailing fragment", () => {
    expect(splitSentences("One. two three")).toEqual(["One.", "two three"]);
  });
});

describe("firstSentencesWithin", () => {
  const text = "The park opens on 14 October 2026. It runs until May 2027. Opening hours follow soon.";

  it("takes whole sentences up to the budget", () => {
    expect(firstSentencesWithin(text, 60)).toBe("The park opens on 14 October 2026. It runs until May 2027.");
  });

  it("returns an empty string rather than a fragment when nothing fits", () => {
    expect(firstSentencesWithin(text, 10)).toBe("");
  });

  it("never cuts a sentence in half", () => {
    const out = firstSentencesWithin(text, 40);
    expect(out).toBe("The park opens on 14 October 2026.");
    expect(endsLikeSentence(out)).toBe(true);
  });
});

describe("endsLikeSentence", () => {
  it("accepts terminators with a closing quote", () => {
    expect(endsLikeSentence('He said "no".')).toBe(true);
    expect(endsLikeSentence("Done!”")).toBe(true);
    expect(endsLikeSentence("公園は十月に開園します。")).toBe(true);
    expect(endsLikeSentence("متى يفتح المنتزه؟")).toBe(true);
  });

  it("rejects the live defect: a description clipped mid-sentence", () => {
    expect(endsLikeSentence("According to the operator, Park Holding Entertainment, millions of visitors arrive from every")).toBe(false);
  });
});
