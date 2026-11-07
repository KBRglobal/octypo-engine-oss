import { describe, expect, it } from "vitest";

import { marketFromDomain } from "./seo-report";

/**
 * This guard exists because the mistake was made for real: the desk remembered
 * "United States" from an earlier lookup, a `.co.uk` prospect was measured in
 * it, and the report came back with every section empty — an authoritative
 * document about the wrong country.
 */
describe("marketFromDomain", () => {
  it("reads the country a country-code domain declares", () => {
    expect(marketFromDomain("acme-events.co.uk")).toEqual({ code: 2826, name: "United Kingdom" });
    expect(marketFromDomain("https://www.example-kitchen.ae/menu")).toEqual({
      code: 2784,
      name: "United Arab Emirates",
    });
    expect(marketFromDomain("  Example.CO.UK  ")).toEqual({ code: 2826, name: "United Kingdom" });
  });

  // Guessing a market from .com would be the same mistake in reverse.
  it("says nothing about a domain that says nothing", () => {
    expect(marketFromDomain("notion.so")).toBeNull();
    expect(marketFromDomain("example.com")).toBeNull();
    expect(marketFromDomain("")).toBeNull();
  });
});
