import { describe, expect, it } from "vitest";
import { repairInWordQuotes } from "./gate2-approver.js";

describe("repairInWordQuotes", () => {
  it("makes a verdict quoting an in-word quote parse, in any script", () => {
    const raw = '{"decision":"revise","issues":[{"description":"the U"S office, 東京"都 branch"}]}';
    expect(() => JSON.parse(raw)).toThrow();
    const parsed = JSON.parse(repairInWordQuotes(raw));
    expect(parsed.issues[0].description).toBe('the U"S office, 東京"都 branch');
  });

  it("leaves JSON delimiters next to text alone", () => {
    const raw = '{"a":"مرحبا","b":["hello"]}';
    expect(repairInWordQuotes(raw)).toBe(raw);
  });

  it("leaves a quote that is already escaped alone", () => {
    const raw = '{"a":"say\\"hello"}';
    expect(repairInWordQuotes(raw)).toBe(raw);
  });
});
