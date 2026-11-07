/**
 * Sanitises a whole `blocks[]` array before it is stored.
 *
 * The pipeline path already cleans each field as it builds a block
 * (src/octypo/gatekeeper/job-handlers.ts:753, :766). The admin editor path does
 * not: PUT /api/admin/articles/:id validates block *shape* and writes the body
 * through untouched. Anything an editor can paste — or anything an attacker can
 * get an editor to paste — is then served as raw HTML on a paying customer's
 * own domain.
 *
 * Sanitising here rather than at render time keeps the invariant the rest of
 * the system already assumes: nothing unsafe is ever stored.
 */

import { sanitizeHtml, sanitizeText } from "./sanitize-html.js";
import type { ContentBlock } from "../schema/index.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Images may only point at http(s); anything else is a script or an exfil channel. */
function safeImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : "";
}

function sanitizeFaqItems(items: unknown): unknown {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (!isPlainObject(item)) return { question: "", answer: "" };
    return { ...item, question: sanitizeText(item.question), answer: sanitizeHtml(item.answer) };
  });
}

export function sanitizeBlock(block: ContentBlock): ContentBlock {
  const data = isPlainObject(block.data) ? { ...block.data } : {};

  switch (block.type) {
    case "heading":
      data.text = sanitizeText(data.text);
      break;

    case "image":
      data.url = safeImageUrl(data.url);
      data.alt = sanitizeText(data.alt);
      if (data.caption !== undefined) data.caption = sanitizeText(data.caption);
      if (data.credit !== undefined) data.credit = sanitizeText(data.credit);
      break;

    case "faq":
      data.items = sanitizeFaqItems(data.items);
      break;

    case "list":
      data.items = Array.isArray(data.items) ? data.items.map(item => sanitizeHtml(item)) : [];
      break;

    default:
      // text, quote and anything the engine grows later: the payload is HTML.
      if (typeof data.content === "string") data.content = sanitizeHtml(data.content);
      if (typeof data.text === "string") data.text = sanitizeHtml(data.text);
      break;
  }

  return { ...block, data };
}

export function sanitizeBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map(sanitizeBlock);
}
