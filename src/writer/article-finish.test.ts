import { describe, it, expect } from "vitest";
import { bodyInsertionIndex, deriveQuickFacts, ensureInternalLinks, hasInternalLink, insertBodyImages } from "./article-finish.js";
import type { ContentBlock } from "../schema/index.js";

const h = (id: string, text: string) => ({ id, type: "heading", data: { text, level: 2 } }) as ContentBlock;
const t = (id: string, content: string) => ({ id, type: "text", data: { content } }) as ContentBlock;
const faq = { id: "faq-0", type: "faq", data: { items: [{ question: "Q", answer: "A" }] } } as ContentBlock;

const article = [t("t0", "Opening"), h("h1", "What is included"), t("t1", "Body one"), h("h2", "Uses"), t("t2", "Body two"), h("h3", "Price"), t("t3", "Body three"), faq];

describe("body images", () => {
  it("places two images after paragraphs in the first and second halves, never in the FAQ", () => {
    const out = insertBodyImages(article, [
      { url: "https://x/a.webp", altText: "A projector set up at a venue entrance in the evening", source: "bank", credit: "First image caption" },
      { url: "https://x/b.webp", altText: "A bright screen at night in the town centre", source: "bank" },
    ]);
    const images = out.map((b, i) => (b.type === "image" ? i : -1)).filter((i) => i >= 0);
    expect(images.length).toBe(2);
    expect(images[0]).toBeLessThan(images[1]);
    expect(out.indexOf(faq)).toBe(out.length - 1);
    const first = out[images[0]].data as { caption: string; alt: string };
    expect(first.caption).toBe("First image caption");
    const second = out[images[1]].data as { caption: string; alt: string };
    expect(second.caption).toBe(second.alt);
  });

  it("never inserts before the opening paragraph", () => {
    expect(bodyInsertionIndex([t("t0", "x")], 0, 2)).toBeGreaterThanOrEqual(1);
  });
});

describe("internal links", () => {
  const candidates = [
    { path: "/services/mobile-screens/", label: "Mobile screens for events" },
    { path: "/contact/", label: "Contact" },
    { path: "/projects/mall-launch/", label: "The mall opening campaign" },
  ];

  it("leaves an article alone when the writer already linked internally", () => {
    const linked = [t("t0", 'See <a href="/services/x/">the mobile screen service</a>')];
    expect(hasInternalLink(linked)).toBe(true);
    expect(ensureInternalLinks(linked, candidates, "screen")).toBe(linked);
  });

  it("adds a read-also line before the FAQ with the two most relevant labelled pages", () => {
    const out = ensureInternalLinks(article, candidates, "advertising on mobile screens");
    expect(out.length).toBe(article.length + 1);
    const added = out[out.length - 2].data as { content: string };
    expect(added.content).toContain("Read also:");
    expect(added.content).toContain('href="/services/mobile-screens/"');
    expect(added.content).toContain("Mobile screens for events");
    expect(added.content).not.toContain("/contact/"); // single-word anchor is not descriptive
    expect(out[out.length - 1]).toBe(faq);
  });

  it("scores non-Latin keywords against non-Latin labels", () => {
    const out = ensureInternalLinks(article, [{ path: "/a/", label: "Прокат проектора для мероприятий" }, { path: "/b/", label: "Наши контакты здесь" }], "прокат проектора");
    const added = out[out.length - 2].data as { content: string };
    expect(added.content).toContain('href="/a/"');
    expect(added.content).not.toContain('href="/b/"');
  });

  it("does nothing without candidates", () => {
    expect(ensureInternalLinks(article, [], "screen")).toBe(article);
  });
});

describe("quick facts", () => {
  it("reads the writer's data table first", () => {
    const table = t(
      "tb",
      "<table><thead><tr><th>Item</th><th>Details</th></tr></thead><tbody><tr><td>Brand name</td><td>Sound &amp; Vision</td></tr><tr><td>Booking</td><td>48 to 72 hours</td></tr><tr><td>Coverage</td><td>Nationwide</td></tr><tr><td>Report</td><td>At campaign end</td></tr></tbody></table>"
    );
    const facts = deriveQuickFacts([t("t0", "x"), table], []);
    expect(facts.length).toBe(4);
    expect(facts[0]).toEqual({ label: "Brand name", value: "Sound & Vision" });
  });

  it("falls back to label: value facts and needs at least three", () => {
    expect(deriveQuickFacts([], ["Booking: 48 hours", "Coverage - nationwide"])).toEqual([]);
    expect(deriveQuickFacts([], ["Booking: 48 hours", "Coverage - nationwide", "Active days: seven a week"]).length).toBe(3);
  });

  it("reads the full-width colon used in CJK facts", () => {
    expect(deriveQuickFacts([], ["予約：48時間", "地域：全国", "営業日：毎日"]).length).toBe(3);
  });

  it("caps at five and drops duplicate labels", () => {
    const facts = ["A: 11", "B: 22", "C: 33", "D: 44", "E: 55", "F: 66", "A: again"].map((f) => `Fact ${f}`);
    expect(deriveQuickFacts([], facts).length).toBe(5);
  });
});
