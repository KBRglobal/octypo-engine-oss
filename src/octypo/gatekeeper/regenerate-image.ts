/**
 * Article media regeneration.
 *
 * A content pack may provide an approved hero plus body-image plan. Every
 * prompt and alt string is passed to the provider verbatim, and completed
 * assets are persisted one at a time so a retry never pays for them twice.
 */

import { eq } from "drizzle-orm";

import { db } from "../../db.js";
import { contents, articles, type ContentBlock } from "../../schema/index.js";
import { logger } from "../../lib/logger.js";
import { getImageProvider, NullImageProvider } from "../../lib/image-provider.js";

export interface MediaPlanItem {
  id: string;
  placement: string;
  prompt: string;
  alt: string;
  altDecision?: string;
  /** Body images only. A generic caption fails the publish gate's media check. */
  caption?: string;
}

export interface ArticleMediaResult {
  heroImage: string | null;
  bodyImages: string[];
}

export class NoImageProviderError extends Error {
  constructor() {
    super("No image provider configured");
    this.name = "NoImageProviderError";
  }
}

export class ContentNotFoundError extends Error {
  constructor(contentId: string) {
    super(`Content ${contentId} not found`);
    this.name = "ContentNotFoundError";
  }
}

export function isImageProviderConfigured(): boolean {
  return !(getImageProvider() instanceof NullImageProvider);
}

function bodyInsertionIndex(blocks: ContentBlock[], ordinal: number, total: number): number {
  const headings = blocks
    .map((block, index) => (block.type === "heading" ? index : -1))
    .filter((index) => index >= 0);
  if (headings.length === 0) {
    return Math.max(1, Math.round((blocks.length * (ordinal + 1)) / (total + 1)));
  }

  const headingPosition = Math.min(
    headings.length - 1,
    Math.max(0, Math.round(((ordinal + 1) * headings.length) / (total + 1)) - 1)
  );
  return headings[headingPosition] + 2;
}

async function loadArticle(contentId: string) {
  const [row] = await db
    .select({
      id: contents.id,
      title: contents.title,
      heroImage: contents.heroImage,
      heroImageAlt: contents.heroImageAlt,
      primaryKeyword: contents.primaryKeyword,
      secondaryKeywords: contents.secondaryKeywords,
      blocks: contents.blocks,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);

  if (!row) throw new ContentNotFoundError(contentId);

  const [articleRow] = await db
    .select({ category: articles.category })
    .from(articles)
    .where(eq(articles.contentId, contentId))
    .limit(1);

  return { ...row, category: articleRow?.category || "article" };
}

export async function regenerateArticleMedia(
  contentId: string,
  mediaPlan: MediaPlanItem[] = [],
  options: { replace?: boolean } = {}
): Promise<ArticleMediaResult> {
  const provider = getImageProvider();
  if (provider instanceof NullImageProvider) throw new NoImageProviderError();

  const row = await loadArticle(contentId);
  const keywords = [row.primaryKeyword, ...(row.secondaryKeywords ?? [])].filter(
    (value): value is string => Boolean(value)
  );
  const heroPlan = mediaPlan.find((item) => item.placement === "hero") ?? mediaPlan[0];
  const bodyPlan = heroPlan ? mediaPlan.filter((item) => item.id !== heroPlan.id) : [];
  // replace: the article's current images are dropped first, so a plan of a
  // hero and two body images leaves exactly that (the publish gate counts).
  let heroImage = options.replace ? null : row.heroImage ?? null;
  let blocks = Array.isArray(row.blocks) ? [...row.blocks] : [];
  if (options.replace) {
    blocks = blocks.filter((block) => block.type !== "image");
    await db
      .update(contents)
      .set({ heroImage: null, cardImage: null, blocks, updatedAt: new Date() })
      .where(eq(contents.id, contentId));
  }
  const bodyImages: string[] = [];

  if (!heroImage) {
    const result = await provider.getArticleImage(row.title, keywords, row.category, {
      skipLibrary: true,
      prompt: heroPlan?.prompt,
      altText: heroPlan?.alt || row.heroImageAlt || undefined,
    });
    if (!result) throw new Error(`Image provider returned no hero image for ${contentId}`);

    heroImage = result.url;
    await db
      .update(contents)
      .set({
        heroImage: result.url,
        heroImageAlt: heroPlan?.alt || row.heroImageAlt || result.altText,
        cardImage: result.url,
        cardImageAlt: heroPlan?.alt || row.heroImageAlt || result.altText,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, contentId));
  }

  for (let index = 0; index < bodyPlan.length; index += 1) {
    const item = bodyPlan[index];
    const existing = blocks.find((block) => block.id === item.id);
    if (existing?.type === "image" && typeof existing.data?.url === "string") {
      bodyImages.push(existing.data.url);
      continue;
    }

    const result = await provider.getArticleImage(item.alt || row.title, keywords, row.category, {
      skipLibrary: true,
      prompt: item.prompt,
      altText: item.alt,
      // Never the hero or an earlier body image again in the same article.
      excludeUrls: [heroImage, ...bodyImages].filter((url): url is string => Boolean(url)),
    });
    if (!result) throw new Error(`Image provider returned no body image for ${item.id}`);

    const imageBlock: ContentBlock = {
      id: item.id,
      type: "image",
      data: {
        url: result.url,
        alt: item.alt || result.altText,
        caption: item.caption || item.alt || result.altText,
      },
    };
    const insertAt = Math.min(blocks.length, bodyInsertionIndex(blocks, index, bodyPlan.length));
    blocks.splice(insertAt, 0, imageBlock);
    bodyImages.push(result.url);

    await db
      .update(contents)
      .set({ blocks, updatedAt: new Date() })
      .where(eq(contents.id, contentId));
  }

  logger.info(
    { contentId, heroImage, bodyImageCount: bodyImages.length },
    "[RegenImage] Article media generated"
  );
  return { heroImage, bodyImages };
}

/** Force a fresh hero for the manual admin action. */
export async function regenerateArticleImage(contentId: string): Promise<string | null> {
  const row = await loadArticle(contentId);
  await db
    .update(contents)
    .set({ heroImage: null, cardImage: null, updatedAt: new Date() })
    .where(eq(contents.id, contentId));
  const result = await regenerateArticleMedia(contentId, [
    {
      id: `${contentId}-hero`,
      placement: "hero",
      prompt: "",
      alt: row.heroImageAlt || `Editorial illustration for ${row.title}`,
    },
  ]);
  return result.heroImage;
}

/**
 * Fresh media for an article the publish media gate holds: its images are
 * replaced by a hero and two body images, customer bank first (no prompt), with
 * alts and captions taken from the article's own title and section headings.
 * Returns false when no provider is configured or the provider came back empty.
 */
export async function repairArticleMedia(contentId: string): Promise<boolean> {
  if (!isImageProviderConfigured()) return false;
  const row = await loadArticle(contentId);
  const blocks = (Array.isArray(row.blocks) ? row.blocks : []) as ContentBlock[];
  const headings = blocks
    .filter((block) => block.type === "heading")
    .map((block) => String((block.data as { text?: string })?.text ?? "").trim())
    .filter((text) => text.length >= 8);
  const subject = row.primaryKeyword?.trim() || row.title;
  const describe = (text: string) => (text.length >= 20 ? text : `${subject}: ${text}`).slice(0, 170);
  const plan: MediaPlanItem[] = [
    { id: `${contentId}-hero`, placement: "hero", prompt: "", alt: describe(row.title) },
    ...[0, 1].map((index) => {
      const text = describe(headings[Math.min(index * 2, headings.length - 1)] ?? `${row.title} (${index + 1})`);
      return { id: `${contentId}-body-${index + 1}`, placement: "body", prompt: "", alt: text, caption: text };
    }),
  ];
  try {
    const result = await regenerateArticleMedia(contentId, plan, { replace: true });
    return Boolean(result.heroImage) && result.bodyImages.length === 2;
  } catch (error) {
    logger.warn({ contentId, error: error instanceof Error ? error.message : String(error) }, "[RegenImage] Media repair failed");
    return false;
  }
}
