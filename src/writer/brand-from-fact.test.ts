import { describe, expect, it } from "vitest";
import { brandFromFact } from "./brand-from-fact.js";

describe("brandFromFact", () => {
  it("prefers the site name when the fact uses it", () => {
    expect(brandFromFact("Acme Events installs LED screens", "Acme Events")).toBe("Acme Events");
  });
  it("never picks a product word as the brand", () => {
    expect(brandFromFact("LED and AV screens by ACME-EVENTS", "")).toBe("ACME-EVENTS");
    expect(brandFromFact("LED screens only", "")).toBe("");
  });
  it("keeps the old behaviour for an all-caps brand", () => {
    expect(brandFromFact("ACME-EVENTS produces events", "Acme-events")).toBe("ACME-EVENTS");
  });
  it("finds a Latin brand inside a non-Latin fact", () => {
    expect(brandFromFact("ACME-EVENTS のイベント制作", "")).toBe("ACME-EVENTS");
  });
});
