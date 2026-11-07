/**
 * The kind of article that taught us the rules, replayed through the gate.
 *
 * A fictional site publishes "Lantern Park is back: when does the 2025-2026
 * season open" with an aggregator link as its only source, a transliterated
 * slug, a description clipped mid-sentence, no internal links, and a "not yet
 * officially announced" claim made without opening the organiser's site, which
 * by then listed the dates. The gate must hold that article. When the same
 * article is written the way the rules demand, it must pass.
 */
import { describe, it, expect } from "vitest";

import { scoreArticle } from "../score-article.js";
import type { ArticleQualityInput } from "../types.js";

const now = new Date("2026-09-15T08:00:00Z");
const publishedSlugs = ["attractions", "events", "families", "best-time", "checklist", "getting-there"];

const paragraph = (html: string) => ({ type: "text", data: { content: `<p>${html}</p>` } });
const heading = (text: string) => ({ type: "heading", data: { text, level: 2 } });
const filler = (n: number) =>
  Array.from({ length: n }, () => "The park combines culture pavilions, markets, live shows and street food stalls from around the world, and draws millions of visitors each season.").join(" ");

const asPublished: ArticleQualityInput = {
  title: "Lantern Park is back: when does the 2025-2026 season open",
  metaTitle: "Lantern Park is back: when does the 2025-2026 season open",
  metaDescription:
    "Lantern Park, the seasonal culture and entertainment park in Northport, reopens for the 2025-2026 season and ranks among the most wanted attractions in the region, and according to the operator, Park Holding Entertainment, millions of visitors arrive from every",
  primaryKeyword: "lantern park",
  answerCapsule:
    "Lantern Park usually opens in October or November and runs until April or May. The exact opening date for the 2025-2026 season has not been officially announced by Park Holding Entertainment. Before you book a flight, check the official site for confirmed dates, so that you do not arrive before the opening or after the closing.",
  slug: "atrktzih-mdobrt-chozrt-mkom-shmoshk-milionim",
  sourceUrls: ["https://news.google.com/rss/articles/CBMidEFVX3lxTE4yNWFMbUdNeFJy?oc=5"],
  primarySources: [],
  publishedSlugs,
  siteUrl: "https://northport.example.com",
  heroImage: "https://cdn.northport.example.com/articles/x-1200.webp",
  heroImageAlt: "Illustration for the article",
  blocks: [
    paragraph("Lantern Park has not been officially confirmed an opening date for the 2025-2026 season at the time of writing. " + filler(6)),
    heading("Why Lantern Park only runs for half the year"),
    paragraph(filler(8)),
    heading("How opening dates are announced"),
    paragraph(filler(8)),
  ],
  now,
};

const schema = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Lantern Park 2026-2027: the official opening date and what it means for visitors",
  description: "Lantern Park in Northport opens for the 2026-2027 season on 14 October 2026.",
  image: ["https://cdn.northport.example.com/articles/x-1200.webp"],
  datePublished: "2026-09-14T21:14:00.000Z",
  dateModified: "2026-09-15T08:00:00.000Z",
  author: { "@type": "Organization", name: "Northport Daily" },
  publisher: { "@type": "Organization", name: "Northport Daily", url: "https://northport.example.com" },
  mainEntityOfPage: { "@type": "WebPage", "@id": "https://northport.example.com/articles/lantern-park-opening-dates-2026-2027/" },
});

const asItShouldBe: ArticleQualityInput = {
  ...asPublished,
  structuredData: schema,
  title: "Lantern Park 2026-2027: the official opening date and what it means for visitors",
  metaTitle: "Lantern Park 2026-2027: opens on 14 October",
  metaDescription:
    "Lantern Park in Northport opens for the 2026-2027 season on 14 October 2026 and runs until May 2027, according to the park's official site.",
  answerCapsule:
    "Lantern Park in Northport opens for the 2026-2027 season on 14 October 2026 and runs until May 2027, according to the park's official site. Opening hours and tickets for the new season follow later. Anyone booking a trip between mid-October and April can plan a visit with confidence. Near the opening or closing, check the official site again.",
  slug: "lantern-park-northport-opening-dates-2026-2027",
  sourceUrls: ["https://www.lanternpark.example.org/"],
  primarySources: [{ url: "https://www.lanternpark.example.org/", checkedAt: "2026-09-15T07:30:00Z" }],
  blocks: [
    paragraph("Lantern Park has published the dates of season 31 on its official site: from 14 October 2026 until May 2027. Opening hours and tickets follow later. " + filler(6)),
    heading("What is already certain about the 2026-2027 season"),
    paragraph(filler(8)),
    heading("What this means for visitors planning a winter trip"),
    paragraph(
      `More ideas for your route are in the <a href="/attractions/">attractions guide</a> and the <a href="/families/">guide for families</a>, and anyone who has not fixed dates yet can use the guide to <a href="/best-time/">the best time to visit</a>. ` +
        filler(6)
    ),
  ],
};

describe("the seasonal park article", () => {
  it("is held by the gate exactly as it went live", () => {
    const report = scoreArticle(asPublished);
    expect(report.passed).toBe(false);
    expect(report.blockingFailures).toEqual(
      expect.arrayContaining(["source-primary", "slug-readable", "meta-lengths", "internal-links"])
    );
    const source = report.criteria.find(c => c.id === "source-primary")!;
    expect(source.details.join(" ")).toContain("aggregator");
    expect(source.details.join(" ")).toContain("no official page was checked today");
  });

  it("passes once written the way the rules demand", () => {
    const report = scoreArticle(asItShouldBe);
    const gates = ["source-primary", "slug-readable", "meta-lengths", "internal-links", "title-freshness", "answer-capsule"] as const;
    for (const id of gates) {
      const c = report.criteria.find(x => x.id === id)!;
      expect(c.status, `${id}: ${c.details.join(" | ")}`).toBe("pass");
    }
    expect(report.blockingFailures).toEqual([]);
  });
});
