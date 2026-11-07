import { describe, it, expect } from "vitest";

import { normaliseArticle, renderBlocksToHtml } from "./normalise.js";
import type { ContentBlock } from "../schema/index.js";

const block = (type: string, data: Record<string, unknown>, id = type): ContentBlock => ({
  id,
  type,
  data,
});

const source = {
  id: "c_1",
  title: "Deposit rules explained",
  slug: "deposit-rules",
  summary: "What a landlord may keep.",
  heroImage: "https://pub-abc.r2.dev/guides/2026/deposit-rules-9f2a.png",
  heroImageAlt: "Keys on a contract",
  category: "guide",
  tags: ["rental-market", "deposits"],
  blocks: [
    block("heading", { text: "What to expect", level: 2 }),
    block("text", { content: '<p>Read the <a href="/topics/deposits">deposit guide</a>.</p>' }),
  ],
  seoSchema: [{ "@type": "Article", headline: "Deposit rules explained" }],
  publishedAt: new Date("2026-08-19T09:00:00.000Z"),
};

describe("renderBlocksToHtml", () => {
  it("renders the four pipeline block types", () => {
    const html = renderBlocksToHtml([
      block("heading", { text: "What to expect", level: 2 }),
      block("text", { content: "<p>Hello</p>" }),
      block("image", { url: "https://cdn.test/a.png", alt: "A door", caption: "Photo: Octypo" }),
      block("faq", { items: [{ question: "Is it refundable?", answer: "<p>Usually.</p>" }] }),
    ]);

    expect(html).toContain("<h2>What to expect</h2>");
    expect(html).toContain("<p>Hello</p>");
    expect(html).toContain('<img src="https://cdn.test/a.png" alt="A door"');
    expect(html).toContain("<figcaption>Photo: Octypo</figcaption>");
    expect(html).toContain("<h3>Is it refundable?</h3>");
    expect(html).toContain("<p>Usually.</p>");
  });

  // The engine sanitises on write (src/lib/sanitize-html.ts). Escaping here a
  // second time would ship literal "&lt;p&gt;" onto a customer's live site.
  it("passes body HTML through untouched — it is already sanitised upstream", () => {
    const html = renderBlocksToHtml([
      block("text", { content: '<p><strong>Bold</strong> and <a href="https://x.dev">a link</a></p>' }),
    ]);
    expect(html).toContain('<a href="https://x.dev">a link</a>');
    expect(html).not.toContain("&lt;");
  });

  // Plain-text fields are stored unescaped (sanitizeText strips tags but leaves
  // "&"), so they must be encoded when they become HTML.
  it("escapes plain-text fields so an ampersand cannot break the markup", () => {
    const html = renderBlocksToHtml([
      block("heading", { text: "Tom & Jerry", level: 2 }),
      block("image", { url: "https://cdn.test/a.png", alt: 'He said "hi"' }),
    ]);
    expect(html).toContain("<h2>Tom &amp; Jerry</h2>");
    expect(html).toContain('alt="He said &quot;hi&quot;"');
  });

  // A block type added to the engine next quarter must still land on the
  // customer's site. A block that renders as nothing is a missing section that
  // no error surface reports.
  it("never silently drops an unknown block that carries text", () => {
    const html = renderBlocksToHtml([block("pullquote", { content: "<p>Quote me</p>" })]);
    expect(html).toContain("<p>Quote me</p>");
  });

  it("clamps heading levels to real elements", () => {
    const html = renderBlocksToHtml([block("heading", { text: "Deep", level: 9 })]);
    expect(html).toContain("<h4>Deep</h4>");
    expect(html).not.toContain("<h9");
  });
});

describe("normaliseArticle", () => {
  it("builds a target-agnostic payload from a content row", () => {
    const article = normaliseArticle(source);

    expect(article.id).toBe("c_1");
    expect(article.title).toBe("Deposit rules explained");
    expect(article.slug).toBe("deposit-rules");
    expect(article.excerpt).toBe("What a landlord may keep.");
    expect(article.state).toBe("published");
    expect(article.html).toContain("<h2>What to expect</h2>");
    expect(article.structuredData).toEqual([
      { "@type": "Article", headline: "Deposit rules explained" },
    ]);
  });

  it("turns slugs into taxonomy terms a CMS can create", () => {
    const article = normaliseArticle(source);
    expect(article.category).toEqual({ slug: "guide", name: "Guide" });
    expect(article.tags).toEqual([
      { slug: "rental-market", name: "Rental Market" },
      { slug: "deposits", name: "Deposits" },
    ]);
  });

  it("derives a media filename from the hero URL", () => {
    const article = normaliseArticle(source);
    expect(article.heroImage).toEqual({
      url: "https://pub-abc.r2.dev/guides/2026/deposit-rules-9f2a.png",
      alt: "Keys on a contract",
      filename: "deposit-rules-9f2a.png",
    });
  });

  it("falls back to the slug when the hero URL has no usable filename", () => {
    const article = normaliseArticle({ ...source, heroImage: "https://cdn.test/render?id=9" });
    expect(article.heroImage?.filename).toBe("deposit-rules.png");
  });

  it("drops legacy FAQPage schema while retaining current article schema", () => {
    const article = normaliseArticle({ ...source, seoSchema: { "@type": "FAQPage" } });
    expect(article.structuredData).toEqual([]);

    const mixed = normaliseArticle({
      ...source,
      seoSchema: [{ "@type": "Article" }, { "@type": "HowTo" }],
    });
    expect(mixed.structuredData).toEqual([{ "@type": "Article" }]);
  });

  it("tolerates a JSON-LD string, because older rows stored it that way", () => {
    const article = normaliseArticle({ ...source, seoSchema: '[{"@type":"Article"}]' });
    expect(article.structuredData).toEqual([{ "@type": "Article" }]);
  });

  it("ignores unparseable JSON-LD rather than throwing mid-publish", () => {
    const article = normaliseArticle({ ...source, seoSchema: "{not json" });
    expect(article.structuredData).toEqual([]);
  });

  // Root-relative engine links (/topics/deposits) are dead on a third-party CMS
  // that has no topic hubs. Absolutising them is opt-in per target.
  it("absolutises root-relative links when the target supplies a base", () => {
    const article = normaliseArticle(source, { internalLinkBase: "https://example.com" });
    expect(article.html).toContain('href="https://example.com/topics/deposits"');
  });

  it("leaves links alone when no base is configured", () => {
    const article = normaliseArticle(source);
    expect(article.html).toContain('href="/topics/deposits"');
  });

  it("never rewrites absolute or anchor links", () => {
    const article = normaliseArticle(
      {
        ...source,
        blocks: [
          block("text", {
            content: '<p><a href="https://x.dev">a</a><a href="#top">b</a><a href="//cdn.io/c">c</a></p>',
          }),
        ],
      },
      { internalLinkBase: "https://example.com" }
    );
    expect(article.html).toContain('href="https://x.dev"');
    expect(article.html).toContain('href="#top"');
    expect(article.html).toContain('href="//cdn.io/c"');
  });
});

describe("contentHash", () => {
  it("is stable for identical input", () => {
    expect(normaliseArticle(source).contentHash).toBe(normaliseArticle(source).contentHash);
  });

  it("changes when anything the target would write changes", () => {
    const base = normaliseArticle(source).contentHash;
    expect(normaliseArticle({ ...source, title: "Different" }).contentHash).not.toBe(base);
    expect(normaliseArticle({ ...source, tags: ["deposits"] }).contentHash).not.toBe(base);
    expect(normaliseArticle({ ...source, heroImage: "https://cdn.test/z.png" }).contentHash).not.toBe(
      base
    );
    expect(
      normaliseArticle({ ...source, blocks: [block("text", { content: "<p>new</p>" })] }).contentHash
    ).not.toBe(base);
  });
});
