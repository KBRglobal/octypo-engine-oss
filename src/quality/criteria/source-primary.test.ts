import { describe, it, expect, vi } from "vitest";

import { DEFAULT_QUALITY_GATE_CONFIG } from "../config.js";
import { extractStructure } from "../extract.js";
import type { ArticleQualityInput } from "../types.js";
import { findAbsenceClaims, scoreSourcePrimary } from "./source-primary.js";

const config = DEFAULT_QUALITY_GATE_CONFIG;
const now = new Date("2026-09-15T08:00:00Z");

function article(overrides: Partial<ArticleQualityInput>): ArticleQualityInput {
  return {
    title: "Lantern Park: when the season opens",
    blocks: [
      { type: "text", data: { content: "<p>Lantern Park usually opens in October and runs until May.</p>" } },
    ],
    now,
    ...overrides,
  };
}

function score(input: ArticleQualityInput) {
  return scoreSourcePrimary(input, extractStructure(input), config);
}

describe("findAbsenceClaims", () => {
  it("finds 'not yet officially published' phrasings", () => {
    expect(findAbsenceClaims("The dates have not been officially announced.")).toHaveLength(1);
    expect(findAbsenceClaims("There is no official date yet.")).toHaveLength(1);
    expect(findAbsenceClaims("The opening date has not been published by the operator.")).toHaveLength(1);
  });

  it("stays quiet on ordinary prose", () => {
    expect(findAbsenceClaims("The park opens on 14 October 2026, according to the official site.")).toHaveLength(0);
  });
});

describe("scoreSourcePrimary", () => {
  it("is skipped when no sources were supplied", () => {
    expect(score(article({})).status).toBe("skipped");
  });

  it("blocks an aggregator source", () => {
    const r = score(article({ sourceUrls: ["https://news.google.com/rss/articles/CBMiAAA?oc=5"] }));
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.details[0]).toContain("aggregator");
  });

  it("blocks a news article with no source at all", () => {
    const r = score(article({ sourceUrls: [] }));
    expect(r.status).toBe("fail");
    expect(r.details[0]).toContain("no source URL");
  });

  it("passes a publisher source with no absence claim", () => {
    const r = score(article({ sourceUrls: ["https://www.timeout.example.com/news/lantern-park"] }));
    expect(r.status).toBe("pass");
  });

  it("blocks 'not yet announced' without a primary source checked today", () => {
    const r = score(
      article({
        sourceUrls: ["https://www.timeout.example.com/news/lantern-park"],
        blocks: [{ type: "text", data: { content: "<p>The opening date has not been officially announced.</p>" } }],
      })
    );
    expect(r.status).toBe("fail");
    expect(r.blocking).toBe(true);
    expect(r.details[0]).toContain("no official page was checked today");
  });

  it("does not accept a news site as the primary source for that claim", () => {
    const r = score(
      article({
        sourceUrls: ["https://www.timeout.example.com/news/lantern-park"],
        blocks: [{ type: "text", data: { content: "<p>The opening date has not been officially announced.</p>" } }],
        primarySources: [{ url: "https://www.citytimes.example.com/local/x", checkedAt: "2026-09-15T07:00:00Z" }],
      })
    );
    expect(r.status).toBe("fail");
  });

  it("does not accept a primary source checked on another day", () => {
    const r = score(
      article({
        sourceUrls: ["https://www.timeout.example.com/news/lantern-park"],
        blocks: [{ type: "text", data: { content: "<p>The opening date has not been officially announced.</p>" } }],
        primarySources: [{ url: "https://www.lanternpark.example.org/", checkedAt: "2026-09-13T07:00:00Z" }],
      })
    );
    expect(r.status).toBe("fail");
  });

  it("passes the claim when the official page was opened today", () => {
    const r = score(
      article({
        sourceUrls: ["https://www.timeout.example.com/news/lantern-park"],
        blocks: [{ type: "text", data: { content: "<p>The opening date has not been officially announced.</p>" } }],
        primarySources: [{ url: "https://www.lanternpark.example.org/", checkedAt: "2026-09-15T07:00:00Z" }],
      })
    );
    expect(r.status).toBe("pass");
    expect(r.details[0]).toContain("lanternpark.example.org");
  });

  it("records that the absence rule has no vocabulary on a non-English site, and never holds for it", async () => {
    vi.resetModules();
    vi.doMock("../../config/domain.js", async (original) => ({ ...(await original<object>()), CONTENT_LANGUAGE: "Japanese" }));
    const { scoreSourcePrimary: scoreJapanese } = await import("./source-primary.js");
    const input = article({
      sourceUrls: ["https://www.timeout.example.com/news/lantern-park"],
      blocks: [{ type: "text", data: { content: "<p>開業日はまだ正式に発表されていません。</p>" } }],
    });
    const r = scoreJapanese(input, extractStructure(input), config);
    vi.doUnmock("../../config/domain.js");
    expect(r.status).toBe("pass");
    expect(r.evidence).toMatchObject({ absenceClaimCheck: "skipped: no vocabulary for this language" });
  });
});
