/**
 * Engine blocks ⇄ HTML conversion.
 *
 * The engine stores article bodies as a JSONB array of blocks:
 *   { id, type, data }
 * with types produced by the pipeline (see src/octypo/gatekeeper/job-handlers.ts):
 *   - text    → data.content  (HTML string, usually one or more <p>)
 *   - heading → data.text + data.level
 *   - image   → data.url / data.alt / data.caption
 *   - list    → data.items (string[]) [+ data.style]
 *   - faq     → data.items ({question, answer}[])
 *
 * BlockNote works in HTML, so the editor loads via engineBlocksToHTML →
 * tryParseHTMLToBlocks, and saves via blocksToHTMLLossy → htmlToEngineBlocks.
 *
 * IMPORTANT: this module is dependency-free and does NOT use DOMParser so the
 * round-trip can be tested in plain Node (admin/scripts/roundtrip.ts).
 */

export interface EngineBlock {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

const VOID_TAGS = new Set([
  "img",
  "br",
  "hr",
  "input",
  "meta",
  "link",
  "source",
  "embed",
  "area",
  "base",
  "col",
  "track",
  "wbr",
]);

const BLOCK_LEVEL_OPEN = /^<(p|h[1-6]|ul|ol|blockquote|div|figure|table|pre|section|article)\b/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Wrap content in <p> unless it already starts with a block-level element. */
function ensureBlockWrapped(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (BLOCK_LEVEL_OPEN.test(trimmed)) return trimmed;
  return `<p>${trimmed}</p>`;
}

function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
}

// ─────────────────────────────────────────────────────────────────────────
// engineBlocksToHTML
// ─────────────────────────────────────────────────────────────────────────

/** Convert engine JSONB blocks to a single HTML string for the editor. */
export function engineBlocksToHTML(blocks: EngineBlock[] | null | undefined): string {
  if (!blocks || !Array.isArray(blocks)) return "";

  const parts: string[] = [];

  for (const block of blocks) {
    const data = (block?.data ?? {}) as Record<string, any>;

    switch (block?.type) {
      case "heading": {
        const level = Math.min(Math.max(Number(data.level) || 2, 1), 6);
        const text = typeof data.text === "string" ? data.text : "";
        if (text.trim()) parts.push(`<h${level}>${escapeHtml(text.trim())}</h${level}>`);
        break;
      }

      case "image": {
        const url = typeof data.url === "string" ? data.url : "";
        if (!url) break;
        const alt = typeof data.alt === "string" ? data.alt : "";
        const caption = typeof data.caption === "string" ? data.caption : "";
        const img = `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`;
        parts.push(
          caption ? `<figure>${img}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : img
        );
        break;
      }

      case "list": {
        const items = Array.isArray(data.items) ? data.items : [];
        if (items.length === 0) break;
        const tag = data.style === "ordered" ? "ol" : "ul";
        const lis = items
          .map(
            (item: unknown) =>
              `<li>${typeof item === "string" ? item : escapeHtml(String(item))}</li>`
          )
          .join("");
        parts.push(`<${tag}>${lis}</${tag}>`);
        break;
      }

      case "faq": {
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          const question = typeof item?.question === "string" ? item.question : "";
          const answer = typeof item?.answer === "string" ? item.answer : "";
          if (question.trim()) parts.push(`<h3>${escapeHtml(question.trim())}</h3>`);
          if (answer.trim()) parts.push(ensureBlockWrapped(answer));
        }
        break;
      }

      case "quote": {
        const content = typeof data.content === "string" ? data.content : "";
        if (content.trim()) parts.push(`<blockquote>${content.trim()}</blockquote>`);
        break;
      }

      case "text":
      default: {
        // text blocks + any unknown block carrying content/text
        const content =
          typeof data.content === "string"
            ? data.content
            : typeof data.text === "string"
              ? data.text
              : "";
        if (content.trim()) parts.push(ensureBlockWrapped(content));
        break;
      }
    }
  }

  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Top-level HTML splitter (no DOMParser — works in Node and the browser)
// ─────────────────────────────────────────────────────────────────────────

interface TopElement {
  tag: string;
  outer: string;
  inner: string;
  attrs: string;
}

type TopNode = { kind: "element"; el: TopElement } | { kind: "text"; text: string };

/** Split an HTML string into its top-level elements + stray text. */
function splitTopLevel(html: string): TopNode[] {
  const out: TopNode[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

  let depth = 0;
  let cursor = 0; // position after the last consumed top-level node
  let topStart = 0;
  let topTag = "";
  let topAttrs = "";
  let innerStart = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    const isClose = full.startsWith("</");
    const isSelfContained = full.endsWith("/>") || VOID_TAGS.has(tag);

    if (!isClose) {
      if (depth === 0) {
        const text = html.slice(cursor, m.index);
        if (text.trim()) out.push({ kind: "text", text: text.trim() });

        if (isSelfContained) {
          out.push({
            kind: "element",
            el: { tag, outer: full, inner: "", attrs: m[2] || "" },
          });
          cursor = re.lastIndex;
          continue;
        }

        topStart = m.index;
        topTag = tag;
        topAttrs = m[2] || "";
        innerStart = m.index + full.length;
      }
      if (!isSelfContained) depth++;
    } else {
      if (depth > 0) depth--;
      if (depth === 0 && tag === topTag && topTag) {
        out.push({
          kind: "element",
          el: {
            tag: topTag,
            outer: html.slice(topStart, re.lastIndex),
            inner: html.slice(innerStart, m.index),
            attrs: topAttrs,
          },
        });
        cursor = re.lastIndex;
        topTag = "";
      }
    }
  }

  const tail = html.slice(cursor);
  if (tail.trim() && depth === 0 && !topTag) out.push({ kind: "text", text: tail.trim() });

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// htmlToEngineBlocks
// ─────────────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Unwrap `<li><p>x</p></li>` → `x` (BlockNote wraps list item content). */
function listItemContent(inner: string): string {
  const nodes = splitTopLevel(inner.trim());
  if (nodes.length === 1 && nodes[0].kind === "element" && nodes[0].el.tag === "p") {
    return nodes[0].el.inner.trim();
  }
  return inner.trim();
}

function imageBlockFrom(attrs: string, caption?: string): EngineBlock | null {
  const url = getAttr(attrs, "src");
  if (!url) return null;
  return {
    type: "image",
    id: nextId("img"),
    data: {
      url,
      alt: getAttr(attrs, "alt") || "",
      caption: caption?.trim() || undefined,
    },
  };
}

/** Convert an HTML string (e.g. BlockNote lossy export) back to engine blocks. */
export function htmlToEngineBlocks(html: string): EngineBlock[] {
  const blocks: EngineBlock[] = [];
  if (!html || !html.trim()) return blocks;

  for (const node of splitTopLevel(html)) {
    if (node.kind === "text") {
      blocks.push({
        type: "text",
        id: nextId("t"),
        data: { content: `<p>${node.text}</p>` },
      });
      continue;
    }

    const { tag, outer, inner, attrs } = node.el;

    if (/^h[1-6]$/.test(tag)) {
      const text = stripTags(inner);
      if (text) {
        blocks.push({
          type: "heading",
          id: nextId("h"),
          data: { text, level: Number(tag[1]) },
        });
      }
      continue;
    }

    if (tag === "p") {
      // A paragraph that is just an image → image block
      const innerNodes = splitTopLevel(inner.trim());
      if (
        innerNodes.length === 1 &&
        innerNodes[0].kind === "element" &&
        innerNodes[0].el.tag === "img"
      ) {
        const img = imageBlockFrom(innerNodes[0].el.attrs);
        if (img) blocks.push(img);
        continue;
      }
      if (stripTags(inner)) {
        blocks.push({ type: "text", id: nextId("t"), data: { content: outer } });
      }
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      const items: string[] = [];
      for (const child of splitTopLevel(inner)) {
        if (child.kind === "element" && child.el.tag === "li") {
          const content = listItemContent(child.el.inner);
          if (content) items.push(content);
        }
      }
      if (items.length > 0) {
        blocks.push({
          type: "list",
          id: nextId("l"),
          data: { items, style: tag === "ol" ? "ordered" : "unordered" },
        });
      }
      continue;
    }

    if (tag === "img") {
      const img = imageBlockFrom(attrs);
      if (img) blocks.push(img);
      continue;
    }

    if (tag === "figure") {
      let imgAttrs: string | undefined;
      let caption: string | undefined;
      for (const child of splitTopLevel(inner)) {
        if (child.kind !== "element") continue;
        if (child.el.tag === "img") imgAttrs = child.el.attrs;
        if (child.el.tag === "figcaption") caption = stripTags(child.el.inner);
        // BlockNote may nest the img inside a wrapper div
        if (child.el.tag === "div" && !imgAttrs) {
          const m = /<img((?:"[^"]*"|'[^']*'|[^>"'])*)>/i.exec(child.el.inner);
          if (m) imgAttrs = m[1];
        }
      }
      if (imgAttrs) {
        const img = imageBlockFrom(imgAttrs, caption);
        if (img) blocks.push(img);
      } else if (stripTags(inner)) {
        blocks.push({ type: "text", id: nextId("t"), data: { content: outer } });
      }
      continue;
    }

    if (tag === "br" || tag === "hr") continue;

    // blockquote, pre, table, div, … — preserve as a text block with raw HTML
    if (stripTags(inner) || /<img/i.test(inner)) {
      blocks.push({ type: "text", id: nextId("t"), data: { content: outer } });
    }
  }

  return blocks;
}

/** Plain-text projection of engine blocks — used to verify round-trips. */
export function engineBlocksToPlainText(blocks: EngineBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const data = (block.data ?? {}) as Record<string, any>;
    if (typeof data.text === "string") parts.push(data.text);
    if (typeof data.content === "string") parts.push(stripTags(data.content));
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (typeof item === "string") parts.push(stripTags(item));
        else if (item && typeof item === "object") {
          parts.push(stripTags(String(item.question ?? "")), stripTags(String(item.answer ?? "")));
        }
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
