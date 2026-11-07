import { describe, expect, it } from "vitest";
import { autowriteDelayMs } from "./autowrite-start.js";

describe("autowrite start date", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  it("is zero when unset, past or invalid", () => {
    expect(autowriteDelayMs(now, undefined)).toBe(0);
    expect(autowriteDelayMs(now, "2026-10-01")).toBe(0);
    expect(autowriteDelayMs(now, "not a date")).toBe(0);
  });
  it("waits until a future date", () => {
    expect(autowriteDelayMs(now, "2026-10-07T12:00:00Z")).toBe(24 * 3600 * 1000);
  });
});
