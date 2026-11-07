import { describe, expect, it } from "vitest";
import { parseAngleVerdict, passesRequiredAngle } from "./required-angle.js";

describe("required news angle", () => {
  it("passes everything when no angle is set", async () => {
    expect(await passesRequiredAngle("Dover cliffs projection", "", "", async () => false)).toBe(true);
  });
  it("follows the judge when an angle is set", async () => {
    expect(await passesRequiredAngle("Lisbon LED wall", "", "Portugal", async () => true)).toBe(true);
    expect(await passesRequiredAngle("Dover cliffs projection", "", "Portugal", async () => false)).toBe(false);
  });
  it("skips when the judge cannot answer", async () => {
    expect(await passesRequiredAngle("x", "", "Portugal", async () => null)).toBe(false);
    expect(await passesRequiredAngle("x", "", "Portugal", async () => { throw new Error("down"); })).toBe(false);
  });
  it("parses yes/no answers", () => {
    expect(parseAngleVerdict("YES")).toBe(true);
    expect(parseAngleVerdict("No.")).toBe(false);
    expect(parseAngleVerdict("maybe")).toBeNull();
  });
});
