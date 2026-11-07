/**
 * Turns the stored `blocks[]` into the shape the criteria reason about.
 *
 * The block schema is `Record<string, unknown>` by design, so every read here
 * is defensive: a block the engine grows later must degrade to "no prose found"
 * rather than throw inside a publishing gate.
 */

import { stripHtml } from "./text.js";
import type { ArticleQualityInput, QualityBlock, QualityFaq } from "./types.js";

export interface ExtractedHeading {
  level: number;
  text: string;
}

export interface ExtractedLink {
  href: string;
  anchor: string;
}

export interface ExtractedImage {
  url: string;
  alt: string;
}

export interface ArticleStructure {
  headings: ExtractedHeading[];
  /** Visible prose in document order — headings, body copy, list items, FAQs. */
  prose: string;
  links: ExtractedLink[];
  images: ExtractedImage[];
  faqs: QualityFaq[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const LINK_RE = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

function collectLinks(html: string, into: ExtractedLink[]): void {
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(html)) !== null) {
    const href = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (href) into.push({ href, anchor: stripHtml(match[4] ?? "") });
  }
}

/** HTML-bearing block types: everything that is not a heading, image or FAQ. */
function htmlPayload(block: QualityBlock): string[] {
  const data = block.data ?? {};
  const parts: string[] = [];
  if (typeof data.content === "string") parts.push(data.content);
  if (typeof data.text === "string") parts.push(data.text);
  if (Array.isArray(data.items)) {
    for (const item of data.items) if (typeof item === "string") parts.push(item);
  }
  return parts;
}

export function extractStructure(input: ArticleQualityInput): ArticleStructure {
  const headings: ExtractedHeading[] = [];
  const links: ExtractedLink[] = [];
  const images: ExtractedImage[] = [];
  const faqs: QualityFaq[] = [];
  const proseParts: string[] = [];

  for (const block of input.blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    const data = block.data ?? {};

    switch (block.type) {
      case "heading": {
        const text = stripHtml(str(data.text));
        const rawLevel = Number(data.level);
        headings.push({ level: Number.isFinite(rawLevel) ? rawLevel : 2, text });
        if (text) proseParts.push(text);
        break;
      }

      case "image": {
        images.push({ url: str(data.url).trim(), alt: str(data.alt).trim() });
        // Alt text is not prose: it never appears in the reading flow, and
        // counting it would let an image caption carry the keyword density.
        break;
      }

      case "faq": {
        const items = Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const question = stripHtml(str(record.question));
          const answer = stripHtml(str(record.answer));
          collectLinks(str(record.answer), links);
          faqs.push({ question, answer });
          if (question) proseParts.push(question);
          if (answer) proseParts.push(answer);
        }
        break;
      }

      default: {
        for (const html of htmlPayload(block)) {
          collectLinks(html, links);
          const text = stripHtml(html);
          if (text) proseParts.push(text);
        }
        break;
      }
    }
  }

  return {
    headings,
    prose: proseParts.join(" "),
    links,
    images,
    faqs: input.faqs && input.faqs.length > 0 ? input.faqs : faqs,
  };
}
