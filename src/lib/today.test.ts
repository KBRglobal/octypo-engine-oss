import { describe, it, expect } from "vitest";

import { todayContextBlock, todayIso } from "./today.js";

describe("todayContextBlock", () => {
  const now = new Date("2026-09-15T10:00:00Z");

  it("names the date, the weekday and the year", () => {
    const block = todayContextBlock(now);
    expect(block).toContain("CURRENT DATE: 2026-09-15 (Tuesday)");
    expect(block).toContain("The current year is 2026.");
  });

  it("tells the model that the current year is not the future", () => {
    const block = todayContextBlock(now);
    expect(block).toMatch(/never "the future" and never fictional/);
    expect(block).toContain("dated 2026 or 2027 is current");
  });

  it("forbids a past year in a forward-looking title", () => {
    expect(todayContextBlock(now)).toMatch(/never put a past year in a title/);
  });

  it("todayIso is the UTC calendar date", () => {
    expect(todayIso(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });
});
