import { describe, it, expect } from "vitest";
import { scoreRelevance, rankCandidates, type Candidate } from "./relevance.js";

/**
 * The fixtures below are REAL results captured from live Pixabay and Pexels
 * searches for the first customer's topic. They are the reason this module
 * exists: every one is correctly licensed, and most are completely wrong.
 */
const TOPIC = "LED truck mobile advertising campaign";

const REAL_PIXABAY_RESULTS: Candidate[] = [
  { id: "1", url: "u1", width: 5632, height: 3754, provider: "pixabay",
    description: "truck, snow, winter, nature, landscape, trees, red truck" },
  { id: "2", url: "u2", width: 7087, height: 4724, provider: "pixabay",
    description: "christmas, ornament, lights, blue, bokeh, reflection" },
  { id: "3", url: "u3", width: 3000, height: 4000, provider: "pixabay",
    description: "led light, light, advertisement, hookah, multicoloured" },
];

const REAL_PEXELS_RESULTS: Candidate[] = [
  { id: "p1", url: "v1", width: 4240, height: 2832, provider: "pexels",
    description: "City street view of Kuala Lumpur showcasing traffic and billboard advertising" },
  { id: "p2", url: "v2", width: 6240, height: 4160, provider: "pexels",
    description: "A vibrant city street scene captured at night with long exposure" },
];

describe("relevance scoring", () => {
  it("rejects the snow truck that a live search actually returned", () => {
    // Shares only "truck" out of five topic terms — a real photo of the wrong thing.
    const r = scoreRelevance(TOPIC, REAL_PIXABAY_RESULTS[0].description);
    expect(r.relevant).toBe(false);
  });

  it("rejects the christmas ornament and the hookah", () => {
    expect(scoreRelevance(TOPIC, REAL_PIXABAY_RESULTS[1].description).relevant).toBe(false);
    expect(scoreRelevance(TOPIC, REAL_PIXABAY_RESULTS[2].description).relevant).toBe(false);
  });

  it("accepts the billboard-advertising street scene", () => {
    const r = scoreRelevance("billboard advertising in the city", REAL_PEXELS_RESULTS[0].description);
    expect(r.relevant).toBe(true);
    expect(r.matched).toContain("billboard");
  });

  it("folds plurals so 'trucks' matches 'truck'", () => {
    expect(scoreRelevance("delivery trucks", "truck, delivery, road").matched).toContain("truck");
  });

  it("ignores filler words that would otherwise fake a match", () => {
    // Without stop-words, "the best guide to X" matches almost anything.
    const r = scoreRelevance("the best guide to digital signage", "guide, best, the, top");
    expect(r.relevant).toBe(false);
  });

  it("refuses rather than guesses when there is nothing to compare", () => {
    expect(scoreRelevance("led truck", "").relevant).toBe(false);
    expect(scoreRelevance("", "truck").relevant).toBe(false);
  });
});

describe("candidate ranking", () => {
  it("returns nothing when every real result is irrelevant", () => {
    // This is the actual Pixabay response for the customer's topic. Publishing
    // with no image beats publishing a hookah.
    expect(rankCandidates(TOPIC, REAL_PIXABAY_RESULTS)).toHaveLength(0);
  });

  it("drops images too small or too tall for a header", () => {
    const tooSmall: Candidate = { id: "s", url: "u", width: 800, height: 600, provider: "x",
      description: "led truck mobile advertising campaign" };
    const portrait: Candidate = { id: "p", url: "u", width: 2000, height: 3000, provider: "x",
      description: "led truck mobile advertising campaign" };
    expect(rankCandidates(TOPIC, [tooSmall, portrait])).toHaveLength(0);
  });

  it("orders by topical match, then resolution, so a re-run is stable", () => {
    const weak: Candidate = { id: "w", url: "u", width: 6000, height: 3000, provider: "x",
      description: "advertising campaign" };
    const strong: Candidate = { id: "s", url: "u", width: 2000, height: 1200, provider: "x",
      description: "led truck mobile advertising campaign on the road" };
    const ranked = rankCandidates(TOPIC, [weak, strong]);
    expect(ranked[0].id).toBe("s");
    expect(rankCandidates(TOPIC, [weak, strong]).map((c) => c.id))
      .toEqual(ranked.map((c) => c.id));
  });
});
