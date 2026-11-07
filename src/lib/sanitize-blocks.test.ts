import { describe, it, expect } from "vitest";

import { sanitizeBlock, sanitizeBlocks } from "./sanitize-blocks.js";
import type { ContentBlock } from "../schema/index.js";

const block = (type: string, data: Record<string, unknown>): ContentBlock => ({ id: "1", type, data });

describe("sanitizeBlocks", () => {
  // PUT /api/admin/articles/:id validated block shape and wrote the body
  // through untouched, while the pipeline path sanitised. One editor save was
  // enough to put stored XSS on a customer's own domain.
  it("strips a script tag from a text block", () => {
    const out = sanitizeBlock(block("text", { content: "<p>ok</p><script>alert(1)</script>" }));
    expect(String(out.data.content)).not.toContain("script");
    expect(String(out.data.content)).toContain("ok");
  });

  it("strips a javascript: href from a text block", () => {
    const out = sanitizeBlock(block("text", { content: '<a href="javascript:alert(1)">x</a>' }));
    expect(String(out.data.content)).not.toContain("javascript");
  });

  it("strips markup from a heading, which is rendered as plain text", () => {
    const out = sanitizeBlock(block("heading", { text: "<img src=x onerror=alert(1)>Title", level: 2 }));
    expect(String(out.data.text)).toBe("Title");
  });

  it("keeps the heading level untouched", () => {
    expect(sanitizeBlock(block("heading", { text: "T", level: 3 })).data.level).toBe(3);
  });

  it("rejects a non-http image url rather than storing it", () => {
    expect(sanitizeBlock(block("image", { url: "javascript:alert(1)", alt: "x" })).data.url).toBe("");
    expect(sanitizeBlock(block("image", { url: "data:image/svg+xml,<svg onload=alert(1)>" })).data.url).toBe("");
    expect(sanitizeBlock(block("image", { url: "https://pub-x.r2.dev/a.png" })).data.url).toBe(
      "https://pub-x.r2.dev/a.png"
    );
  });

  it("strips markup from image alt and caption", () => {
    const out = sanitizeBlock(
      block("image", { url: "https://x.dev/a.png", alt: '"><script>x</script>', caption: "<b>c</b>" })
    );
    expect(String(out.data.alt)).not.toContain("<");
    expect(String(out.data.caption)).toBe("c");
  });

  it("sanitises faq questions as text and answers as html", () => {
    const out = sanitizeBlock(
      block("faq", {
        items: [{ question: "<b>Q?</b>", answer: "<p>A</p><script>x</script>" }],
      })
    );
    const items = out.data.items as Array<Record<string, string>>;
    expect(items[0].question).toBe("Q?");
    expect(items[0].answer).toContain("A");
    expect(items[0].answer).not.toContain("script");
  });

  it("survives an faq block whose items are not an array", () => {
    expect(sanitizeBlock(block("faq", { items: "nope" })).data.items).toEqual([]);
  });

  it("sanitises list items", () => {
    const out = sanitizeBlock(block("list", { items: ["<script>x</script>ok"], style: "unordered" }));
    expect((out.data.items as string[])[0]).not.toContain("script");
  });

  it("sanitises an unknown block type rather than trusting it", () => {
    const out = sanitizeBlock(block("callout", { content: "<script>x</script>hi" }));
    expect(String(out.data.content)).not.toContain("script");
    expect(String(out.data.content)).toContain("hi");
  });

  it("preserves block id and type", () => {
    const out = sanitizeBlock({ id: "abc", type: "text", data: { content: "<p>x</p>" } });
    expect(out.id).toBe("abc");
    expect(out.type).toBe("text");
  });

  it("does not mutate the input block", () => {
    const input = block("text", { content: "<script>x</script>" });
    sanitizeBlock(input);
    expect(input.data.content).toBe("<script>x</script>");
  });

  it("survives a block with no data at all", () => {
    expect(() => sanitizeBlock({ id: "1", type: "text" } as ContentBlock)).not.toThrow();
  });

  it("is idempotent, so a save-load-save cycle does not erode the content", () => {
    const once = sanitizeBlocks([block("text", { content: "<p>Keep <strong>this</strong></p>" })]);
    const twice = sanitizeBlocks(once);
    expect(twice).toEqual(once);
    expect(String(once[0].data.content)).toContain("<strong>this</strong>");
  });

  it("keeps legitimate internal links working", () => {
    const out = sanitizeBlock(
      block("text", { content: '<p><a href="/topics/deposits">deposits</a></p>' })
    );
    expect(String(out.data.content)).toContain('href="/topics/deposits"');
  });
});
