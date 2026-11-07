import { describe, it, expect } from "vitest";

import { siteLinks, siteLinksBlock } from "./domain.js";

describe("siteLinks", () => {
  it("is empty when the publisher listed no pages", () => {
    expect(siteLinks({})).toEqual([]);
    expect(siteLinksBlock({})).toBe("");
  });

  it("parses path=label pairs, with optional extra anchor phrases after |", () => {
    const links = siteLinks({
      SITE_LINKS: "/hotels/=City hotels,/checklist/=Pre-flight checklist|Before you fly,/food/=Where to eat",
    });
    expect(links).toEqual([
      { path: "/hotels/", label: "City hotels", keywords: [] },
      { path: "/checklist/", label: "Pre-flight checklist", keywords: ["Before you fly"] },
      { path: "/food/", label: "Where to eat", keywords: [] },
    ]);
  });

  it("keeps non-Latin labels intact", () => {
    expect(siteLinks({ SITE_LINKS: "/hotels/=ホテル案内" })).toEqual([
      { path: "/hotels/", label: "ホテル案内", keywords: [] },
    ]);
  });

  it("skips malformed entries instead of throwing — a bad env must not stop the writer", () => {
    const links = siteLinks({ SITE_LINKS: "no-equals,search/=No slash,/ok/=Valid,/empty-label/=" });
    expect(links).toEqual([{ path: "/ok/", label: "Valid", keywords: [] }]);
  });

  it("renders the allow-list as a prompt block with exact paths", () => {
    const block = siteLinksBlock({ SITE_LINKS: "/hotels/=City hotels" });
    expect(block).toContain("ONLY these pages");
    expect(block).toContain("- /hotels/ — City hotels");
  });
});
