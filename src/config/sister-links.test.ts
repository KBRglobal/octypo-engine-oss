import { describe, expect, it } from "vitest";
import { sisterLinks, sisterLinksBlock } from "./domain.js";

describe("sisterLinks", () => {
  it("parses https entries and skips anything else", () => {
    const env = { SISTER_LINKS: "https://sister.example.com/services/sound/=Sound systems,/local/=x,http://a.b/=y,https://c.d/=" };
    expect(sisterLinks(env)).toEqual([{ url: "https://sister.example.com/services/sound/", label: "Sound systems" }]);
  });

  it("is empty without the variable, so prompts stay unchanged", () => {
    expect(sisterLinks({})).toEqual([]);
    expect(sisterLinksBlock({})).toBe("");
  });

  it("names the sister site and caps it at one link", () => {
    const block = sisterLinksBlock({ SISTER_LINKS: "https://x.example.com/a/=A", SISTER_SITE_NAME: "Sister Co" });
    expect(block).toContain("Sister Co");
    expect(block).toContain("ONCE");
    expect(block).toContain("https://x.example.com/a/ — A");
  });
});
