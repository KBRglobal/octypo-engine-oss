import { describe, it, expect } from "vitest";

import { describeDegradation } from "./capabilities.js";
import { normaliseArticle } from "./normalise.js";
import { capabilities } from "./types.js";

const rich = normaliseArticle({
  id: "c_1",
  title: "Deposit rules",
  slug: "deposit-rules",
  summary: "Short answer.",
  heroImage: "https://cdn.test/hero.png",
  heroImageAlt: "Keys",
  category: "guide",
  tags: ["deposits"],
  blocks: [{ id: "t", type: "text", data: { content: "<p>Body</p>" } }],
  seoSchema: [{ "@type": "Article" }],
  publishedAt: new Date("2030-01-01T00:00:00.000Z"),
});

const bare = normaliseArticle({ id: "c_2", title: "Bare", slug: "bare", blocks: [] });

describe("describeDegradation", () => {
  it("reports nothing when the target can carry everything", () => {
    expect(describeDegradation(capabilities({}), rich)).toEqual([]);
  });

  // The whole point of the capability declaration: a target that cannot take a
  // field must make the loss visible instead of dropping it on the floor.
  it("names every field the target cannot take", () => {
    const degraded = describeDegradation(
      capabilities({ categories: false, tags: false, excerpt: false, structuredData: false }),
      rich
    );
    expect(degraded.map(d => d.feature).sort()).toEqual([
      "categories",
      "excerpt",
      "structuredData",
      "tags",
    ]);
    for (const entry of degraded) expect(entry.detail).not.toBe("");
  });

  // hostsMedia:false is not data loss — the URL still travels in the payload.
  // Only a target that can neither host nor carry the image degrades.
  it("does not call a hot-linked hero image a degradation", () => {
    expect(describeDegradation(capabilities({ hostsMedia: false }), rich)).toEqual([]);
  });

  it("reports a future publish date a target cannot honour", () => {
    const degraded = describeDegradation(capabilities({ scheduling: false }), rich);
    expect(degraded.map(d => d.feature)).toEqual(["scheduling"]);
  });

  it("reports nothing for data the article does not have", () => {
    const degraded = describeDegradation(
      capabilities({ categories: false, tags: false, excerpt: false, structuredData: false }),
      bare
    );
    expect(degraded).toEqual([]);
  });
});
