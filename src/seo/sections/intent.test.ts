import { describe, expect, it } from "vitest";

import { isBuyerPhrase, nonBuyerReason, splitBuyers } from "./intent.js";

/**
 * Measured on a real prospect: of 5,340 monthly searches presented as "your
 * category", 810 were people looking for a job in the trade or a course in
 * it. Both sit in the same keyword set with the same shape and similar
 * volumes, and DataForSEO's own intent field calls a course "commercial" —
 * it is, for somebody else's product.
 */
describe("nonBuyerReason", () => {
  it("recognises someone looking for work", () => {
    expect(nonBuyerReason("event production jobs")).toBe("employment");
    expect(nonBuyerReason("event production assistant hiring")).toBe("employment");
    expect(nonBuyerReason("event production jobs")).toBe("employment");
  });

  it("recognises someone looking to study", () => {
    expect(nonBuyerReason("event production course")).toBe("study");
    expect(nonBuyerReason("event production course price")).toBe("study");
    expect(nonBuyerReason("event planning course")).toBe("study");
  });

  it("leaves a customer alone", () => {
    expect(isBuyerPhrase("corporate event production")).toBe(true);
    expect(isBuyerPhrase("event production company")).toBe(true);
    expect(isBuyerPhrase("led screens for events")).toBe(true);
  });

  // Whole words only: a marker buried inside a longer word is not a marker.
  it("does not match on letters inside another word", () => {
    expect(isBuyerPhrase("digital courses")).toBe(false);
    expect(isBuyerPhrase("concourse")).toBe(true);
    expect(isBuyerPhrase("paint jobsite")).toBe(true);
  });
});

describe("splitBuyers", () => {
  // Removed, not discarded: a number that quietly shrank is a number nobody
  // can check, and the operator has to see what came out of the total.
  it("keeps what it removed, and why", () => {
    const { buyers, removed } = splitBuyers([
      { keyword: "corporate event production" },
      { keyword: "event production jobs" },
      { keyword: "event production course" },
    ]);
    expect(buyers.map((row) => row.keyword)).toEqual(["corporate event production"]);
    expect(removed).toEqual([
      { keyword: "event production jobs", reason: "employment" },
      { keyword: "event production course", reason: "study" },
    ]);
  });
});
