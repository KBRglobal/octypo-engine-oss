import { describe, it, expect } from "vitest";
import { checkImageTopicSafety } from "./topic-safety.js";

/**
 * These rules exist because of licence clauses, not taste. A false negative is a
 * licence breach on a paying customer's live site; a false positive silently
 * costs them an image. Both directions are tested.
 */
describe("sensitive topic detection", () => {
  it.each([
    ["Election coverage: what the new ballot means", "political"],
    ["The prime minister called early elections", "political"],
    ["Living with diabetes: a patient guide", "medical"],
    ["Symptoms of a chronic illness", "medical"],
    ["The rise of dating app fatigue", "dating"],
    ["Funeral costs are climbing", "tragedy"],
  ])("blocks %j", (title, category) => {
    const verdict = checkImageTopicSafety(title);
    expect(verdict.safe).toBe(false);
    if (!verdict.safe) {
      expect(verdict.category).toBe(category);
      expect(verdict.reason.length).toBeGreaterThan(10);
    }
  });

  it.each([
    "How LED trucks reach customers in Lyon",
    "Mobile advertising versus static billboards",
    "LED truck rental for events",
    "Choosing a digital signage supplier",
    "Restaurant marketing on a small budget",
  ])("allows ordinary business topic %j", (title) => {
    expect(checkImageTopicSafety(title).safe).toBe(true);
  });

  it("does not fire on words that merely contain a sensitive term", () => {
    // "selection" contains "election"; "drugstore" contains "drug". Word
    // boundaries stop an ordinary retail article from losing its image.
    expect(checkImageTopicSafety("Product selection for retail chains").safe).toBe(true);
    expect(checkImageTopicSafety("Drugstore chain opens new branch").safe).toBe(true);
    // "Presidential suite" is a hotel room, not a political context — the
    // licence clause is about parties, candidates and officials. Blocking this
    // would cost a legitimate hospitality article its image.
    expect(checkImageTopicSafety("Presidential suite at the hotel").safe).toBe(true);
    expect(checkImageTopicSafety("The president addressed the nation").safe).toBe(false);
  });

  it("judges all supplied parts, not just the title", () => {
    // The keyword or tags can reveal a context the title hides.
    expect(checkImageTopicSafety("A quiet Tuesday", "election campaign").safe).toBe(false);
    expect(checkImageTopicSafety("Market update", null, undefined).safe).toBe(true);
  });

  it("treats an empty topic as safe rather than throwing", () => {
    expect(checkImageTopicSafety().safe).toBe(true);
    expect(checkImageTopicSafety("", null, undefined).safe).toBe(true);
  });
});
