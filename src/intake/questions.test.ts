import { describe, it, expect } from "vitest";
import { DEFAULT_SECTIONS, answersToFacts, loadSections, questionCount } from "./questions.js";

describe("client questionnaire", () => {
  it("has unique question ids and a fact subject for each", () => {
    const ids = DEFAULT_SECTIONS.flatMap((s) => s.questions.map((q) => q.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of DEFAULT_SECTIONS) for (const q of s.questions) expect(q.fact.length).toBeGreaterThan(5);
    expect(questionCount(DEFAULT_SECTIONS)).toBeGreaterThanOrEqual(30);
  });

  it("turns answers into subject: answer facts in the question's cluster", () => {
    const facts = answersToFacts({ price_range: "from $250 per job", constraints: "  we stop  above 40 km/h wind ", unknown: "x" });
    expect(facts).toEqual([
      { cluster: "*", fact: "Typical price range for the main product or service: from $250 per job", source: "questionnaire:price_range" },
      { cluster: "*", fact: "Conditions that stop the work and what happens then: we stop above 40 km/h wind", source: "questionnaire:constraints" },
    ]);
  });

  it("keeps an answer in any script", () => {
    const facts = answersToFacts({ minimum: "\u6700\u4f4e\u6ce8\u6587\u306f\u3042\u308a\u307e\u305b\u3093" });
    expect(facts[0].fact).toBe("Minimum order: \u6700\u4f4e\u6ce8\u6587\u306f\u3042\u308a\u307e\u305b\u3093");
  });

  it("drops empty answers and strips markup", () => {
    const facts = answersToFacts({ price_range: "", minimum: "<b>no</b> minimum<script>x</script>" });
    expect(facts.length).toBe(1);
    expect(facts[0].fact).toBe("Minimum order: no minimumx");
  });

  it("falls back to the default set on a bad override", () => {
    expect(loadSections("not json")).toBe(DEFAULT_SECTIONS);
    expect(loadSections("")).toBe(DEFAULT_SECTIONS);
    const custom = loadSections(JSON.stringify([{ id: "a", title: "A", questions: [{ id: "x", label: "L", fact: "F", cluster: "*", type: "text" }] }]));
    expect(custom[0].questions[0].id).toBe("x");
  });
});
