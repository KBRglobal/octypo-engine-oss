/**
 * Article body rendering.
 *
 * The whole point of this file is that a block must never disappear. The
 * pipeline writes four types (text, heading, image, faq — job-handlers.ts:739,
 * 752, 762, 785), the admin editor adds `list` (admin/src/lib/blocks.ts:336),
 * and `quote` exists only in legacy rows (blocks.ts:146). A seventh type added
 * to the engine next quarter must still render *something*, exactly as the
 * admin's own switch falls through to `data.content ?? data.text`
 * (admin/src/lib/blocks.ts:152-163). A block that renders as nothing is a
 * missing section on a customer's live site that no error surface reports.
 *
 * Rendering happens here, in plain TypeScript, rather than inside .astro
 * components so that the no-silent-loss guarantee is a unit test rather than a
 * visual inspection. BlockRenderer.astro is a thin wrapper over renderBlocks().
 */

import { escapeHtml, sanitizeHtml } from './sanitize';
import { rewriteInternalLinks, normalisePrefix } from './rewrite-links';
import { resizedImageUrl, buildSrcset } from './images';

export interface Block {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface RenderContext {
  articlePathPrefix: string;
  topicPathPrefix: string;
  imageResizePrefix: string | null;
}

const BODY_IMAGE_WIDTHS = [640, 960, 1280] as const;
// Body images are the same 1536x1024 renders as the hero (image-provider.ts:151).
const BODY_INTRINSIC = { width: 1536, height: 1024 };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Sanitise, then rewrite engine-authored internal hrefs onto the tenant's routes. */
function safeBodyHtml(raw: unknown, ctx: RenderContext): string {
  const clean = sanitizeHtml(raw);
  if (!clean) return '';
  return rewriteInternalLinks(clean, {
    articlePathPrefix: ctx.articlePathPrefix,
    topicPathPrefix: ctx.topicPathPrefix,
  });
}

function renderText(block: Block, ctx: RenderContext): string {
  const html = safeBodyHtml(block.data?.content ?? block.data?.text, ctx);
  return html ? `<div class="octypo-block octypo-text">${html}</div>` : '';
}

function renderHeading(block: Block): string {
  const text = str(block.data?.text) || str(block.data?.content);
  if (!text.trim()) return '';
  const raw = Number(block.data?.level);
  // The pipeline only ever writes level 2, but an editor-saved row can carry
  // anything; <h9> is not an element and breaks the document outline.
  const level = Number.isFinite(raw) ? Math.min(4, Math.max(2, Math.trunc(raw))) : 2;
  const id = slugifyHeading(text);
  const anchor = id ? ` id="${escapeHtml(id)}"` : '';
  return `<h${level} class="octypo-block octypo-heading"${anchor}>${escapeHtml(text)}</h${level}>`;
}

function renderImage(block: Block, ctx: RenderContext): string {
  const url = str(block.data?.url);
  if (!url) return '';
  const alt = escapeHtml(str(block.data?.alt));
  // API.md documents the field as `credit`; the pipeline writes `caption`.
  const caption = str(block.data?.caption) || str(block.data?.credit);
  const src = resizedImageUrl(url, { width: 1280, prefix: ctx.imageResizePrefix });
  const srcset = buildSrcset(url, BODY_IMAGE_WIDTHS, ctx.imageResizePrefix);

  const parts = [
    `<figure class="octypo-block octypo-image">`,
    `<img src="${escapeHtml(src)}"`,
    srcset ? ` srcset="${escapeHtml(srcset)}" sizes="(max-width: 768px) 100vw, 720px"` : '',
    ` alt="${alt}" width="${BODY_INTRINSIC.width}" height="${BODY_INTRINSIC.height}"`,
    ` loading="lazy" decoding="async">`,
    caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '',
    `</figure>`,
  ];
  return parts.join('');
}

interface FaqItemShape {
  question?: unknown;
  answer?: unknown;
}

function renderFaq(block: Block, ctx: RenderContext): string {
  const items = Array.isArray(block.data?.items) ? (block.data.items as FaqItemShape[]) : [];
  const rendered = items
    .map(item => {
      const question = str(item?.question).trim();
      const answer = safeBodyHtml(item?.answer, ctx);
      if (!question && !answer) return '';
      return (
        `<div class="octypo-faq-item">` +
        (question ? `<h3 class="octypo-faq-q">${escapeHtml(question)}</h3>` : '') +
        (answer ? `<div class="octypo-faq-a">${answer}</div>` : '') +
        `</div>`
      );
    })
    .filter(Boolean);
  if (rendered.length === 0) return '';
  return `<section class="octypo-block octypo-faq"><h2 class="octypo-faq-title">Frequently asked questions</h2>${rendered.join('')}</section>`;
}

function renderList(block: Block, ctx: RenderContext): string {
  const items = Array.isArray(block.data?.items) ? block.data.items : [];
  const lis = items
    .map(item => safeBodyHtml(typeof item === 'string' ? item : str((item as FaqItemShape)?.question), ctx))
    .filter(Boolean)
    .map(html => `<li>${html}</li>`);
  if (lis.length === 0) return '';
  const tag = block.data?.style === 'ordered' ? 'ol' : 'ul';
  return `<${tag} class="octypo-block octypo-list">${lis.join('')}</${tag}>`;
}

function renderQuote(block: Block, ctx: RenderContext): string {
  const html = safeBodyHtml(block.data?.content ?? block.data?.text, ctx);
  return html ? `<blockquote class="octypo-block octypo-quote">${html}</blockquote>` : '';
}

/** Unknown types degrade to their content. Never return empty for a block that has text. */
function renderUnknown(block: Block, ctx: RenderContext): string {
  const html = safeBodyHtml(block.data?.content ?? block.data?.text, ctx);
  return html ? `<div class="octypo-block octypo-unknown" data-block-type="${escapeHtml(block.type)}">${html}</div>` : '';
}

export function renderBlock(block: Block, ctx: RenderContext): string {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return renderText(block, ctx);
    case 'heading':
      return renderHeading(block);
    case 'image':
      return renderImage(block, ctx);
    case 'faq':
      return renderFaq(block, ctx);
    case 'list':
      return renderList(block, ctx);
    case 'quote':
      return renderQuote(block, ctx);
    default:
      return renderUnknown(block, ctx);
  }
}

export function renderBlocks(blocks: Block[] | null | undefined, ctx: RenderContext): string {
  if (!Array.isArray(blocks)) return '';
  const resolved: RenderContext = {
    articlePathPrefix: normalisePrefix(ctx.articlePathPrefix),
    topicPathPrefix: normalisePrefix(ctx.topicPathPrefix) || '/topics',
    imageResizePrefix: ctx.imageResizePrefix,
  };
  return blocks.map(block => renderBlock(block, resolved)).filter(Boolean).join('\n');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugifyHeading(text: string): string {
  return stripTags(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Plain-text projection, byte-identical to `engineBlocksToPlainText`
 * (admin/src/lib/blocks.ts:384). Used for RSS descriptions, reading time, and —
 * more importantly — as the oracle the renderer is diffed against, so a block
 * type that stops rendering shows up as a word-count mismatch in CI.
 */
export function blocksToPlainText(blocks: Block[] | null | undefined): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    const data = (block?.data ?? {}) as Record<string, unknown>;
    if (typeof data.text === 'string') parts.push(data.text);
    if (typeof data.content === 'string') parts.push(stripTags(data.content));
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (typeof item === 'string') parts.push(stripTags(item));
        else if (item && typeof item === 'object') {
          const shape = item as FaqItemShape;
          parts.push(stripTags(String(shape.question ?? '')), stripTags(String(shape.answer ?? '')));
        }
      }
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
