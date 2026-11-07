/**
 * `blocks[]` → one target-agnostic article payload.
 *
 * This runs ONCE per publish, before any target is touched, so that every
 * target — WordPress, a webhook, a static-site committer — receives byte-identical
 * content. If each adapter rendered its own HTML, the customer's WordPress and
 * the customer's app would slowly drift apart and nobody would notice.
 *
 * On sanitisation: article HTML is cleaned when it is *stored*
 * (src/lib/sanitize-html.ts, src/lib/sanitize-blocks.ts), so body HTML is
 * emitted here verbatim. Escaping it again would ship literal "&lt;p&gt;" onto
 * a customer's live site; stripping tags again would lose their formatting.
 * Plain-text fields (headings, alt text, FAQ questions) are the opposite case:
 * `sanitizeText` removes markup but leaves "&" alone, so they must be encoded
 * on the way into HTML. Encoding is not sanitising.
 */

import { createHash } from "node:crypto";

import type { ContentBlock } from "../schema/index.js";
import type { MediaRef, NormalisedArticle, TaxonomyTerm } from "./types.js";

export interface NormaliseOptions {
  /**
   * Absolute origin to resolve the engine's root-relative links against
   * (`/topics/deposits`). A third-party CMS has no `/topics/*` routes, so
   * without this those anchors are dead links on the customer's live site.
   * Opt-in per target because some customers do implement topic hubs.
   */
  internalLinkBase?: string | null;
}

/** The shape a content row arrives in. Deliberately loose: this is a DB row, not a model. */
export interface ArticleSource {
  id: string;
  title: string;
  slug: string;
  excerpt?: string | null;
  summary?: string | null;
  metaDescription?: string | null;
  blocks?: ContentBlock[] | null;
  category?: string | null;
  tags?: string[] | null;
  heroImage?: string | null;
  heroImageAlt?: string | null;
  seoSchema?: unknown;
  publishedAt?: Date | null;
  state?: "published" | "draft";
  /** The 2–4 sentence direct answer the writer produced (AEO). */
  answerCapsule?: string | null;
  /** The feed item / outlet the article was written from. */
  sourceUrl?: string | null;
  sourceName?: string | null;
}

// ============================================================================
// HTML PRIMITIVES
// ============================================================================

/** Encode a plain-text field for HTML. Not sanitisation — the value has no markup left. */
export function escapeHtml(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Rewrite root-relative hrefs onto an absolute origin. Absolute URLs,
 * protocol-relative URLs and in-page anchors are left exactly as they are —
 * `//cdn.io/x` starts with "/" but is not ours to rewrite.
 */
function absolutiseLinks(html: string, base: string): string {
  const origin = base.replace(/\/+$/, "");
  return html.replace(/href="\/(?!\/)([^"]*)"/g, (_match, path: string) => `href="${origin}/${path}"`);
}

// ============================================================================
// BLOCK RENDERING
// ============================================================================

function renderHeading(block: ContentBlock): string {
  const text = str(block.data?.text) || str(block.data?.content);
  if (!text.trim()) return "";
  const raw = Number(block.data?.level);
  // The pipeline only ever writes level 2, but an editor-saved row can carry
  // anything, and <h9> is not an element.
  const level = Number.isFinite(raw) ? Math.min(4, Math.max(2, Math.trunc(raw))) : 2;
  return `<h${level}>${escapeHtml(text)}</h${level}>`;
}

function renderImage(block: ContentBlock): string {
  const url = str(block.data?.url);
  if (!url) return "";
  // API.md documents the field as `credit`; the pipeline writes `caption`.
  const caption = str(block.data?.caption) || str(block.data?.credit);
  return (
    `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(str(block.data?.alt))}" loading="lazy" />` +
    (caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "") +
    `</figure>`
  );
}

function renderFaq(block: ContentBlock): string {
  const items = Array.isArray(block.data?.items) ? block.data.items : [];
  const rendered = items
    .map(item => {
      const record = item as { question?: unknown; answer?: unknown } | null;
      const question = str(record?.question).trim();
      const answer = str(record?.answer).trim();
      if (!question && !answer) return "";
      return (
        (question ? `<h3>${escapeHtml(question)}</h3>` : "") + (answer ? `<div>${answer}</div>` : "")
      );
    })
    .filter(Boolean);
  return rendered.length ? `<section class="octypo-faq">${rendered.join("")}</section>` : "";
}

function renderList(block: ContentBlock): string {
  const items = Array.isArray(block.data?.items) ? block.data.items : [];
  const entries = items
    .map(item => (typeof item === "string" ? item : str((item as { text?: unknown })?.text)))
    .filter(item => item.trim() !== "")
    .map(item => `<li>${item}</li>`);
  if (!entries.length) return "";
  const tag = block.data?.style === "ordered" ? "ol" : "ul";
  return `<${tag}>${entries.join("")}</${tag}>`;
}

/**
 * Anything the engine grows later still has to reach the customer's site. A
 * block that renders as nothing is a missing section that no error surface
 * reports, so unknown types degrade to their payload rather than to silence.
 */
function renderUnknown(block: ContentBlock): string {
  const html = str(block.data?.content) || str(block.data?.text);
  return html.trim() ? `<div>${html}</div>` : "";
}

export function renderBlock(block: ContentBlock): string {
  if (!block || typeof block !== "object") return "";
  switch (block.type) {
    case "heading":
      return renderHeading(block);
    case "text":
      // Already sanitised on write — emitted verbatim, tags and all.
      return str(block.data?.content) || str(block.data?.text);
    case "image":
      return renderImage(block);
    case "faq":
      return renderFaq(block);
    case "list":
      return renderList(block);
    case "quote": {
      const html = str(block.data?.content) || str(block.data?.text);
      return html.trim() ? `<blockquote>${html}</blockquote>` : "";
    }
    default:
      return renderUnknown(block);
  }
}

export function renderBlocksToHtml(blocks: ContentBlock[] | null | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map(renderBlock)
    .filter(html => html !== "")
    .join("\n");
}

// ============================================================================
// FIELD DERIVATION
// ============================================================================

/** "rental-market" → "Rental Market", so a CMS can create the term with a human name. */
export function termFromSlug(slug: string): TaxonomyTerm {
  const clean = slug.trim();
  const name = clean
    .split(/[-_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { slug: clean, name: name || clean };
}

/**
 * JSON-LD has been stored three ways over this table's life (array, single
 * object, JSON string). A publish must not throw because of a legacy row.
 */
export function toStructuredData(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return toStructuredData(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .filter(item => !isLegacySearchSchema(item));
  }
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    return isLegacySearchSchema(item) ? [] : [item];
  }
  return [];
}

function isLegacySearchSchema(item: Record<string, unknown>): boolean {
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  return types.some(type => type === "FAQPage" || type === "HowTo");
}

/** A filename a media library will accept, derived from the hero URL. */
export function mediaFilename(url: string, slug: string): string {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a parseable URL — fall through and treat the whole string as a path.
  }
  const base = pathname.split("/").pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "");
  // A name without an extension makes WordPress reject the upload as an
  // unsupported type, so anything questionable falls back to the slug.
  if (/^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{2,5}$/.test(cleaned)) return cleaned;
  return `${slug || "image"}.png`;
}

// ============================================================================
// THE ENTRY POINT
// ============================================================================

export function normaliseArticle(
  source: ArticleSource,
  options: NormaliseOptions = {}
): NormalisedArticle {
  const blocks = Array.isArray(source.blocks) ? source.blocks : [];
  let html = renderBlocksToHtml(blocks);
  if (options.internalLinkBase) html = absolutiseLinks(html, options.internalLinkBase);

  const heroUrl = source.heroImage?.trim() || "";
  const heroImage: MediaRef | null = heroUrl
    ? {
        url: heroUrl,
        alt: source.heroImageAlt ?? null,
        filename: mediaFilename(heroUrl, source.slug),
      }
    : null;

  const article: Omit<NormalisedArticle, "contentHash"> = {
    id: source.id,
    title: source.title,
    slug: source.slug,
    excerpt: source.excerpt ?? source.summary ?? source.metaDescription ?? null,
    html,
    blocks,
    category: source.category?.trim() ? termFromSlug(source.category) : null,
    tags: (source.tags ?? []).filter(tag => typeof tag === "string" && tag.trim()).map(termFromSlug),
    heroImage,
    answerCapsule: source.answerCapsule?.trim() || null,
    source: source.sourceUrl?.trim()
      ? { url: source.sourceUrl.trim(), name: source.sourceName?.trim() || null }
      : null,
    structuredData: toStructuredData(source.seoSchema),
    publishedAt: source.publishedAt ?? null,
    state: source.state ?? "published",
  };

  return { ...article, contentHash: contentHashOf(article) };
}

/**
 * Covers exactly the fields a target writes. `publishedAt` is included because
 * a corrected publication date is a real change; nothing volatile is.
 */
export function contentHashOf(article: Omit<NormalisedArticle, "contentHash">): string {
  const canonical = JSON.stringify({
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    html: article.html,
    category: article.category,
    tags: article.tags,
    heroImage: article.heroImage,
    structuredData: article.structuredData,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    state: article.state,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
