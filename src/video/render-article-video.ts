/**
 * Renders a promo video for one published article and stores the URL on it.
 *
 * Deliberately separate from the publishing path. Publishing decides whether an
 * article is fit to be read; a promo clip is a marketing artefact produced
 * afterwards, and nothing about it should be able to hold a publish open or
 * fail one.
 */

import { eq } from "drizzle-orm";

import { db } from "../db.js";
import { contents } from "../schema/index.js";
import { entitled } from "../config/entitlements.js";
import { logger } from "../lib/logger.js";
import { creatomateConfigFromEnv, renderArticleVideo } from "./creatomate.js";

/** Templates give a subtitle one line; a paragraph would be clipped mid-word. */
const SUBTITLE_MAX = 120;

export function toSubtitle(text: string | null | undefined): string | undefined {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= SUBTITLE_MAX) return trimmed;
  // Cut on a word boundary so the line does not end mid-word.
  const cut = trimmed.slice(0, SUBTITLE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

export async function renderPromoVideoFor(contentId: string): Promise<string | null> {
  if (!entitled("article-video")) {
    logger.info({ contentId }, "[Video] Article video is not in this customer's plan");
    return null;
  }

  const config = creatomateConfigFromEnv();
  if (!config) {
    logger.warn({ contentId }, "[Video] CREATOMATE_API_KEY/TEMPLATE_ID are not configured");
    return null;
  }

  const [row] = await db
    .select({
      id: contents.id,
      title: contents.title,
      summary: contents.summary,
      answerCapsule: contents.answerCapsule,
      heroImage: contents.heroImage,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);

  if (!row) {
    logger.warn({ contentId }, "[Video] No such article");
    return null;
  }

  const url = await renderArticleVideo(config, {
    title: row.title,
    subtitle: toSubtitle(row.answerCapsule ?? row.summary),
    mediaUrl: row.heroImage,
  });

  if (!url) return null;

  await db.update(contents).set({ promoVideoUrl: url }).where(eq(contents.id, contentId));
  logger.info({ contentId }, "[Video] Promo video attached to article");
  return url;
}
