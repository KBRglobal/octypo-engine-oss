import { describe, it, expect } from "vitest";

import { commercialSystemPrompt } from "./commercial.js";
import { editorialRulesBlock } from "../config/domain.js";

const RULES = "- Every article opens with the opening date.\n- Never invent prices.";

describe("editorialRulesBlock", () => {
  it("is empty when the publisher supplied no rules — prompts read exactly as before", () => {
    expect(editorialRulesBlock({})).toBe("");
    expect(editorialRulesBlock({ EDITORIAL_RULES: "   " })).toBe("");
  });

  it("carries the publisher's rules verbatim under a mandatory heading", () => {
    const block = editorialRulesBlock({ EDITORIAL_RULES: RULES });
    expect(block).toContain("MANDATORY");
    expect(block).toContain(RULES);
  });
});

describe("commercialSystemPrompt with EDITORIAL_RULES", () => {
  it("returns the authored prompt untouched when no rules are set", () => {
    const prompt = commercialSystemPrompt({});
    expect(prompt).toContain("Rules:");
    expect(prompt).toContain("Do not invent data");
  });

  it("replaces the rules section with the editor's rules but keeps the machine contract", () => {
    const prompt = commercialSystemPrompt({ EDITORIAL_RULES: RULES });
    expect(prompt).toContain(`Rules:\n${RULES}`);
    // The original built-in rules are gone…
    expect(prompt).not.toContain("Do not invent data");
    // …but the input contract, the STOP rule and the exact output format survive,
    // because the parser depends on them.
    expect(prompt).toContain("buyer_query:");
    expect(prompt).toContain("STOP:");
    expect(prompt).toContain("Return exactly:");
    for (const field of ["title:", "meta:", "slug:", "h1:", "body:", "internal_links:", "facts_used:", "sources_used:"]) {
      expect(prompt).toContain(field);
    }
  });
});
