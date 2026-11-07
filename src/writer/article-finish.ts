/**
 * The last mile between a written article and one a customer site accepts.
 *
 * The site importers are strict on purpose (they are the publication boundary
 * on the customer's own domain): every article needs two body photographs
 * with real alt text, at least one internal link with a descriptive anchor,
 * 3-5 key facts, and its primary query. The writer produces prose; these
 * deterministic steps make sure the package around the prose is complete, so
 * an article never waits for a person to add what a script can add.
 */
import type { ContentBlock } from "../schema/index.js";
import type { ArticleImageResult } from "../lib/image-provider.js";

export interface LinkCandidate {
  path: string;
  label: string;
}

export interface QuickFact {
  label: string;
  value: string;
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/**
 * Where body image N of `total` goes: after the paragraph that follows the
 * heading at that fraction of the article, never before the opening paragraph
 * and never inside a FAQ.
 */
export function bodyInsertionIndex(blocks: ContentBlock[], ordinal: number, total: number): number {
  const faqStart = blocks.findIndex((block) => block.type === "faq");
  const body = faqStart >= 0 ? blocks.slice(0, faqStart) : blocks;
  const headings = body.map((block, index) => (block.type === "heading" ? index : -1)).filter((i) => i >= 0);
  if (headings.length === 0) return Math.max(1, Math.round((body.length * (ordinal + 1)) / (total + 1)));
  const position = Math.min(headings.length - 1, Math.max(0, Math.round(((ordinal + 1) * headings.length) / (total + 1)) - 1));
  return Math.min(body.length, headings[position] + 2);
}

/** Insert image blocks (alt from the provider, caption from its credit or alt). */
export function insertBodyImages(blocks: ContentBlock[], images: ArticleImageResult[]): ContentBlock[] {
  const out = [...blocks];
  images.forEach((image, ordinal) => {
    const index = bodyInsertionIndex(out, ordinal, images.length);
    out.splice(index, 0, {
      id: `img-body-${ordinal + 1}`,
      type: "image",
      data: {
        url: image.url,
        alt: image.altText,
        caption: image.credit && image.credit.trim().length >= 12 ? image.credit.trim() : image.altText,
      },
    } as ContentBlock);
  });
  return out;
}

export function hasInternalLink(blocks: ContentBlock[]): boolean {
  return blocks.some((block) => {
    const data = block.data as { content?: string; items?: string[] };
    const html = [data.content ?? "", ...(data.items ?? [])].join(" ");
    return /<a\s[^>]*href=["']\/(?!\/)[^"']*["']/i.test(html);
  });
}

/**
 * Guarantee at least one internal link. When the writer left none, add a short
 * "read also" paragraph before the FAQ pointing at the two most relevant
 * candidates (money pages first, then published articles), with the page's
 * own label as the anchor so it is descriptive by construction.
 */
export function ensureInternalLinks(
  blocks: ContentBlock[],
  candidates: LinkCandidate[],
  keyword: string,
  labels: { readAlso: string } = { readAlso: "Read also" }
): ContentBlock[] {
  if (hasInternalLink(blocks) || candidates.length === 0) return blocks;
  const tokens = new Set((keyword.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []));
  const scored = [...candidates]
    .filter((c) => c.path.startsWith("/") && c.label.trim().split(/\s+/).length >= 2)
    .map((c, index) => ({
      c,
      index,
      score: (c.label.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => tokens.has(t)).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  // Pages that share a word with the query, up to two; a page that shares
  // nothing is used only when it is the sole option, and only one of them.
  const related = scored.filter((s) => s.score > 0).slice(0, 2);
  const ranked = (related.length ? related : scored.slice(0, 1)).map(({ c }) => c);
  if (ranked.length === 0) return blocks;
  const links = ranked.map((c) => `<a href="${c.path}">${c.label.trim()}</a>`).join(" · ");
  const block = { id: "read-also", type: "text", data: { content: `<strong>${labels.readAlso}:</strong> ${links}` } } as ContentBlock;
  const faqStart = blocks.findIndex((b) => b.type === "faq");
  const out = [...blocks];
  out.splice(faqStart >= 0 ? faqStart : out.length, 0, block);
  return out;
}

/**
 * Key facts for the side panel. The writer's own data table is the best
 * source (label | value rows); failing that, confirmed facts written as
 * "label: value" or "label - value"; capped at five, at least three or none.
 */
export function deriveQuickFacts(blocks: ContentBlock[], facts: string[]): QuickFact[] {
  const out: QuickFact[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string) => {
    const l = stripTags(label).replace(/[:：]$/, "").trim();
    const v = stripTags(value).trim();
    if (l.length < 2 || l.length > 50 || v.length < 2 || v.length > 180) return;
    const key = l.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: l, value: v });
  };

  for (const block of blocks) {
    const html = ((block.data as { content?: string }).content ?? "") as string;
    if (!/<table/i.test(html)) continue;
    for (const row of html.match(/<tr>[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = row.match(/<td>[\s\S]*?<\/td>/gi) ?? [];
      if (cells.length >= 2) push(cells[0] ?? "", cells[1] ?? "");
    }
  }
  if (out.length < 3) {
    for (const fact of facts) {
      const match = /^([^:：\-–]{2,50})\s*[:：\-–]\s*(.{2,180})$/.exec(fact.trim());
      if (match) push(match[1] ?? "", match[2] ?? "");
    }
  }
  const capped = out.slice(0, 5);
  return capped.length >= 3 ? capped : [];
}
