/**
 * Gatekeeper Job Handlers
 * Integrates with the existing job queue system
 */

import { jobQueue, JobType } from "../../job-queue.js";
import { db } from "../../db.js";
import { contents, articles, libraryItems } from "../../schema/index.js";
import { eq, sql, and, ne } from "drizzle-orm";
import type { GenerationResult } from "../types.js";
import { getGatekeeperOrchestrator } from "./orchestrator.js";
import { rssReader } from "../rss-reader.js";
import { matchTopics } from "../../config/topics.js";
import { submitToIndexNow } from "../../lib/indexing.js";
import { getOctypoOrchestrator } from "../orchestration/orchestrator.js";
import { logger } from "../../lib/logger.js";
import { CONTENT_LANGUAGE } from "../../config/domain.js";
import { shouldAutoPublish, publishFixRounds, approvedToCalendar } from "../publish-policy.js";
import { publishContentById, publishBlocker } from "../publish.js";

import { sanitizeHtml } from "../../lib/sanitize-html.js";
import { findOrCreateArticleImage, findArticleBodyImages } from "../../lib/image-provider.js";
import { schemaGenerator, aeoValidator, ARTICLE_PATH_PREFIX } from "../aeo.js";
import { deriveQuickFacts } from "./quick-facts.js";
import {
  regenerateArticleImage,
  regenerateArticleMedia,
  repairArticleMedia,
  type MediaPlanItem,
} from "./regenerate-image.js";
import { renderPromoVideoFor } from "../../video/render-article-video.js";
import { resolveSourceUrl } from "../../lib/source-url.js";
import { discoverPrimarySources } from "../../lib/primary-sources.js";
import { firstSentencesWithin } from "../../lib/sentence-cut.js";
import { judgeSlug } from "../../quality/criteria/slug-readable.js";
import { englishSlug, slugStyle } from "../../writer/english-slug.js";
import type { SourceCheck } from "../../schema/index.js";
import { reviseArticle } from "./revise.js";
import type { CorrectionInstruction } from "./types.js";
import { inventoryLinksBlock } from "../agents/writer-agents.js";
import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";

/** Convert tier to job priority (lower = higher priority) */
function tierToPriority(tier: string): number {
  if (tier === "S1") return 1;
  if (tier === "S2") return 2;
  return 4;
}

/**
 * Stopwords stripped from slugs so they stay concise + keyword-rich.
 * Only filler words — never strip a word that carries the keyword's meaning.
 */
const SLUG_STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "in", "on", "and", "or", "your", "you",
  "how", "what", "when", "why", "vs", "with", "as", "is", "are", "be", "before",
  "after", "into", "that", "this", "these", "those", "at", "by", "from", "it",
  "its", "their", "they", "we", "our", "us", "i", "my", "me", "but", "if", "so",
  "than", "then", "about", "over", "under", "out", "up", "down", "do", "does",
  "did", "can", "will", "would", "should", "could", "has", "have", "had", "was",
  "were", "been", "being", "am", "not", "no", "yes", "vs.", "via",
]);

/** Max words / chars for an SEO-friendly slug. */
const SLUG_MAX_WORDS = 6;
const SLUG_MAX_CHARS = 60;

/**
 * Build a concise, keyword-focused SEO slug base.
 * Lowercases, strips stopwords, kebab-cases, and caps at ~6 words / ~60 chars
 * (trimming whole words only, never cutting a word in half).
 *
 * Latin text loses its accents ("Café" gives "cafe"). A title with no Latin
 * word keeps its own letters, whatever the script: a mechanical romanisation
 * reads as nothing, and digits alone ("13") say less. Such a native slug is
 * visible to the readable-slug gate and to translateNativeSlug, which replace
 * it with English keywords when the install wants them.
 */
export function slugifyConcise(input: string): string {
  const latin = input.normalize("NFKD").replace(/\p{Mn}/gu, "").toLowerCase();
  const rawWords = (/[a-z]{3,}/.test(latin)
    ? latin.replace(/[^a-z0-9]+/g, " ")
    : input.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  // Drop stopwords, but keep at least one word if everything was a stopword.
  let words = rawWords.filter(w => !SLUG_STOPWORDS.has(w));
  if (words.length === 0) words = rawWords;

  // Cap at the word limit.
  words = words.slice(0, SLUG_MAX_WORDS);

  // Cap at the char limit, trimming whole words (never mid-word).
  const kept: string[] = [];
  let length = 0;
  for (const w of words) {
    const addition = kept.length === 0 ? w.length : w.length + 1; // +1 for hyphen
    if (length + addition > SLUG_MAX_CHARS) break;
    kept.push(w);
    length += addition;
  }
  // Always keep at least the first word, even if it alone exceeds the cap.
  if (kept.length === 0 && words.length > 0) {
    kept.push(words[0].slice(0, SLUG_MAX_CHARS));
  }

  return kept.join("-");
}

/**
 * Build a clean SEO slug and ensure uniqueness via DB check.
 * Prefers the primaryKeyword (concise + keyword-rich) when present and
 * non-trivial; otherwise derives a short slug from the title.
 */
export async function buildUniqueSlug(
  title: string,
  opts?: { primaryKeyword?: string; excludeId?: string; preferred?: string }
): Promise<string> {
  // The rule: English keywords a person can read. The writer's own slug wins
  // when it passes the readability judge; otherwise a dedicated slug call
  // translates the title; only then the keyword or the title, which for a
  // non-Latin title means a native slug the gate will hold: visible, never
  // silent.
  const keyword = opts?.primaryKeyword?.trim() ?? "";
  const preferredSlug = opts?.preferred ? slugifyConcise(opts.preferred) : "";
  let base = preferredSlug.length >= 3 && judgeSlug(preferredSlug).ok ? preferredSlug : "";
  if (!base) {
    const translated = await englishSlug(title, keyword || title).catch(() => null);
    if (translated && judgeSlug(translated).ok) base = translated;
  }
  if (!base) {
    const keywordSlug = keyword ? slugifyConcise(keyword) : "";
    base = (keywordSlug.length >= 3 ? keywordSlug : slugifyConcise(title)) || "article";
  }

  // When re-slugging an existing row, ignore that row so its own slug doesn't
  // count as a collision (otherwise re-runs keep appending -2, -3, ...).
  const notSelf = opts?.excludeId ? ne(contents.id, opts.excludeId) : undefined;

  // Try the clean slug first
  const existing = await db
    .select({ slug: contents.slug })
    .from(contents)
    .where(and(eq(contents.slug, base), notSelf))
    .limit(1);

  if (existing.length === 0) return base;

  // Try numeric suffixes (2, 3, ... 20)
  for (let i = 2; i <= 20; i++) {
    const candidate = `${base}-${i}`;
    const dup = await db
      .select({ slug: contents.slug })
      .from(contents)
      .where(and(eq(contents.slug, candidate), notSelf))
      .limit(1);
    if (dup.length === 0) return candidate;
  }

  // Absolute fallback — numeric timestamp, short and still readable
  return `${base}-${Date.now().toString().slice(-6)}`;
}

// ============================================
// JOB TYPE DEFINITIONS
// ============================================

interface GatekeeperWriteJobData {
  feedItemId: string;
  title: string;
  summary: string;
  sourceUrl: string;
  category?: string;
  topicId?: string;
  writerId: string;
  tier: "S1" | "S2" | "S3";
  gate1Score: number;
  gate1Reasoning: string;
}

interface GatekeeperRevisionJobData {
  contentId: string;
  revisionPrompt: string;
  corrections: any[];
  revisionCount: number;
  maxRevisions: number;
}

interface GatekeeperReviewJobData {
  contentId: string;
  revisionCount?: number;
  /** When present, this review belongs to a Library item — update it on publish. */
  libraryItemId?: string;
}

// ============================================
// WRITE JOB HANDLER
// Called after Gate 1 approves an RSS item
// ============================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Flatten persisted content blocks to plain text for downstream LLM derivation.
 * Blocks are shaped { type, data: { content | text | items } } — text lives in
 * `data`, NOT on the block itself. Mirrors the word-count walk in the admin API.
 */
function blocksToPlainText(title: string, blocks: unknown): string {
  const parts: string[] = [title];
  if (Array.isArray(blocks)) {
    for (const block of blocks as Array<{ data?: Record<string, unknown> }>) {
      const d = block?.data ?? {};
      if (typeof d.content === "string") parts.push(d.content);
      if (typeof d.text === "string") parts.push(d.text);
      if (Array.isArray(d.items)) {
        for (const item of d.items) {
          if (typeof item === "string") {
            parts.push(item);
          } else if (item && typeof item === "object") {
            const faq = item as { question?: string; answer?: string };
            parts.push(`${faq.question ?? ""} ${faq.answer ?? ""}`);
          }
        }
      }
    }
  }
  return stripHtml(parts.join("\n"));
}

// ============================================
// SHARED PERSISTENCE
// Used by BOTH the RSS write handler and the Library write handler.
// Takes a successful generation result and: fetches images, persists the
// content as in_review, creates the article row, computes AEO/JSON-LD, and
// enqueues the Gate 2 review job. Returns the created content/article ids.
// ============================================

interface PersistArticleParams {
  title: string;
  /** Category for images + article row (defaults to "guide"/"news"). */
  category: string;
  /** Writer used for authorName in schema + content.writerId. */
  writerId: string;
  /** Source URL recorded on the article row (may be undefined for library). */
  sourceUrl?: string;
  /** Official pages opened while writing (see lib/primary-sources.ts). */
  sourceChecks?: SourceCheck[];
  /** Topic ids stored on the article row; falls back to matchTopics(title). */
  relatedTopicIds?: string[];
  /** Gate 2 review job priority. */
  reviewPriority: number;
  /** Successful generation result from the orchestrator. */
  result: GenerationResult;
  /** When set, threaded through Gate 2 so the library item is updated on publish. */
  libraryItemId?: string;
  /**
   * Real photographs that came with the material (the field desk). When
   * present they ARE the article's images: the first is the hero, the rest
   * go in the body, and no image is generated or fetched.
   */
  providedImages?: Array<{ url: string; alt: string }>;
}

export function isEnglishLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "english";
}

/**
 * Writers keep appending the site name to titles ("... | Site Name") no matter
 * what the prompt says; the site's layout adds it itself, so a suffix here
 * renders twice. Strip a trailing "| <site>" / "- <site>".
 */
export function stripSiteSuffix(title: string, siteName: string | undefined = process.env.SITE_NAME): string {
  const site = siteName?.trim();
  if (!site) return title.trim();
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return title.replace(new RegExp(`\\s*[|\\-–—]\\s*${escaped}\\s*$`, "iu"), "").trim();
}

export async function persistGeneratedArticle(
  params: PersistArticleParams
): Promise<{ contentId: string; articleId: string; wordCount: number; slug: string }> {
  const { title, category, writerId, result } = params;
  const content = result.content!;
  // `title` is the feed item's headline in whatever language the source wrote
  // it. For a non-English install that must not become the article's H1: the
  // writer's own title (metaTitle) is in the publication language.
  const translatedSite = !isEnglishLanguage(CONTENT_LANGUAGE);
  const displayTitle = stripSiteSuffix(translatedSite && content.metaTitle?.trim() ? content.metaTitle.trim() : title);

  // Generate unique clean SEO slug (concise, keyword-focused; no random suffix)
  const slug = await buildUniqueSlug(title, {
    primaryKeyword: content.primaryKeyword,
    preferred: content.slug,
  });

  // Calculate word count from ALL content fields
  const allText = [
    content.introduction,
    content.whatToExpect,
    content.visitorTips,
    content.howToGetThere,
    content.body,
    content.conclusion,
    ...(content.sections || []).map(s => s.content),
    ...(content.faqs || []).map(f => f.answer),
  ]
    .filter(Boolean)
    .join(" ");
  const wordCount = allText.split(/\s+/).length;

  // Fetch images (non-blocking — failure doesn't stop article creation)
  let heroImage: string | undefined;
  let heroImageAlt: string | undefined;
  const bodyImages: BodyImage[] = [];
  const provided = (params.providedImages ?? []).filter(i => i && typeof i.url === "string" && /^https?:\/\//.test(i.url));
  if (provided.length > 0) {
    heroImage = provided[0].url;
    heroImageAlt = provided[0].alt || title;
    // The publish gate wants exactly two body images. The person's other
    // photos first; stock fills whatever is left, never generation.
    for (const img of provided.slice(1, 3)) bodyImages.push({ url: img.url, alt: img.alt || title, credit: null });
    logger.info({ count: provided.length }, "[Persist] Using the photos that came with the material");
  }
  try {
    if (provided.length > 0) {
      if (bodyImages.length < 2) {
        const more = await findArticleBodyImages(
          title,
          content.primaryKeyword ? [content.primaryKeyword] : [],
          category,
          2 - bodyImages.length,
          [heroImage as string, ...bodyImages.map(b => b.url)]
        );
        for (const img of more) bodyImages.push({ url: img.url, alt: img.altText, credit: img.credit ?? null });
      }
      throw new Error("provided");
    }
    const heroResult = await findOrCreateArticleImage(
      title,
      content.primaryKeyword ? [content.primaryKeyword] : [],
      category,
      { skipLibrary: true }
    );
    if (heroResult) {
      heroImage = heroResult.url;
      // The provider's alt is written in English around the source headline;
      // the site's rule is a descriptive alt in the publication language.
      heroImageAlt = translatedSite ? displayTitle : heroResult.altText;
      logger.info({ source: heroResult.source }, "[Persist] Hero image acquired");
    }

    // Body images search the article's real keyword rather than a stitched-up
    // term like "category + title", which matched nothing in stock.
    const bodyResults = await findArticleBodyImages(
      title,
      content.primaryKeyword ? [content.primaryKeyword] : [],
      category,
      2,
      heroImage ? [heroImage] : []
    );
    for (const img of bodyResults) {
      bodyImages.push({ url: img.url, alt: img.altText, credit: img.credit ?? null });
      logger.info({ source: img.source }, "[Persist] Body image acquired");
    }
  } catch {
    // Image failure is non-fatal
  }

  // Save as in_review (Gate 2 will approve or revise). Fallbacks are whole
  // sentences, never a character cut: a description clipped mid-sentence
  // went live on a customer page once.
  const introText = content.introduction ? stripHtml(content.introduction) : "";
  const metaDescription = content.metaDescription
    ? stripHtml(content.metaDescription)
    : introText
      ? firstSentencesWithin(introText, 160) || undefined
      : undefined;
  const summary = introText ? firstSentencesWithin(introText, 200) || introText : "";
  const answerCapsule = content.answerCapsule ? stripHtml(content.answerCapsule) : undefined;
  const faqs = content.faqs || [];

  // Derive structured Quick Facts from the assembled body (non-fatal — null on failure).
  const quickFacts = await deriveQuickFacts(title, stripHtml(allText));
  // Deterministic JSON-LD — never trust the LLM's schemaPayload
  const jsonLd = schemaGenerator.generateFullSchema({
    title,
    description: metaDescription || summary,
    slug,
    heroImage,
    faqs,
    authorName: writerId,
  });
  const aeo = aeoValidator.validate({ answerCapsule, faqs, schemas: jsonLd });

  const [contentRecord] = await db
    .insert(contents)
    .values({
      type: "article",
      status: "in_review",
      title: displayTitle,
      slug,
      metaTitle: content.metaTitle || title.substring(0, 70),
      metaDescription,
      summary,
      answerCapsule,
      quickFacts,
      blocks: buildContentBlocks(content, bodyImages),
      seoSchema: jsonLd,
      aeoScore: aeo.overallScore,
      generatedByAI: true,
      writerId,
      wordCount,
      heroImage,
      heroImageAlt,
      cardImage: heroImage,
      cardImageAlt: heroImageAlt,
    })
    .returning();

  const [articleRecord] = await db
    .insert(articles)
    .values({
      contentId: contentRecord.id,
      category,
      sourceUrl: params.sourceUrl,
      sourceChecks: params.sourceChecks ?? [],
      excerpt: summary || undefined,
      relatedTopicIds:
        params.relatedTopicIds && params.relatedTopicIds.length > 0
          ? params.relatedTopicIds
          : matchTopics(title),
      faq: content.faqs || [],
    })
    .returning();

  logger.info(
    { contentId: contentRecord.id, wordCount, libraryItemId: params.libraryItemId },
    "[Persist] Article written, queuing for Gate 2 review"
  );

  // Queue Gate 2 review — thread libraryItemId through so publish can update it
  await jobQueue.addJob(
    "gatekeeper_review" as JobType,
    {
      contentId: contentRecord.id,
      revisionCount: 0,
      ...(params.libraryItemId ? { libraryItemId: params.libraryItemId } : {}),
    },
    { priority: params.reviewPriority }
  );

  return {
    contentId: contentRecord.id,
    articleId: articleRecord.id,
    wordCount,
    slug,
  };
}

async function handleWriteJob(
  data: GatekeeperWriteJobData
): Promise<{ success: boolean; result: any }> {
  logger.info(
    {
      feedItemId: data.feedItemId,
      title: data.title.substring(0, 50),
      writer: data.writerId,
      tier: data.tier,
    },
    "[Gatekeeper] Handling write job"
  );

  try {
    const orchestrator = getOctypoOrchestrator();

    // The feed link is often an aggregator wrapper (news.google.com). Resolve
    // it to the publisher first, then open the official pages the publisher
    // points at: those records are the only honest basis for a "not yet
    // announced" sentence, and the gate will ask for them.
    const resolvedSource = data.sourceUrl ? await resolveSourceUrl(data.sourceUrl) : null;
    const sourceUrl = resolvedSource?.url ?? data.sourceUrl;
    const sourceChecks = sourceUrl ? await discoverPrimarySources(sourceUrl) : [];
    if (resolvedSource && resolvedSource.via !== "as-is") {
      logger.info(
        { feedItemId: data.feedItemId, from: data.sourceUrl, to: sourceUrl, via: resolvedSource.via },
        "[Gatekeeper] Source link resolved to the publisher"
      );
    }
    logger.info(
      { feedItemId: data.feedItemId, checked: sourceChecks.map(c => `${c.url} → ${c.httpStatus ?? "error"}`) },
      "[Gatekeeper] Primary sources checked"
    );

    // Build subject data for the orchestrator
    const subjectData = {
      id: Date.now(),
      title: data.title,
      topicName: data.topicId || "global",
      primaryCategory: data.category || "news",
      description: data.summary,
      sourceUrl,
      contentType: "news-article",
      // Pass writer preference
      preferredWriterId: data.writerId,
    };

    // Generate content
    const result = await orchestrator.generateArticleContent(subjectData);

    if (!result.success || !result.content) {
      const errorInfo = result.qualityScore
        ? `Quality failed: passed=${result.qualityScore.passed}, retries=${result.retryCount}`
        : `Generation failed after ${result.retryCount} retries`;
      logger.error(
        {
          feedItemId: data.feedItemId,
          error: errorInfo,
          engineUsed: result.engineUsed,
          retryCount: result.retryCount,
          generationTimeMs: result.generationTimeMs,
        },
        "[Gatekeeper] Content generation failed"
      );
      // Throw so job-queue marks this as failed and retries up to maxRetries
      throw new Error(`[octypo_write] ${errorInfo}`);
    }

    // Persist + enqueue Gate 2 via the shared path (also used by Library writes)
    const persisted = await persistGeneratedArticle({
      title: data.title,
      category: data.category || "news",
      writerId: data.writerId,
      sourceUrl,
      sourceChecks,
      relatedTopicIds: data.topicId ? [data.topicId] : undefined,
      reviewPriority: tierToPriority(data.tier),
      result,
    });

    // Update RSS item with content ID (using raw SQL since table is created dynamically)
    await db.execute(sql`
      UPDATE rss_feed_items
      SET processed = TRUE, content_id = ${persisted.contentId}, processed_at = NOW()
      WHERE id = ${data.feedItemId}
    `);

    return {
      success: true,
      result: {
        contentId: persisted.contentId,
        articleId: persisted.articleId,
        wordCount: persisted.wordCount,
      },
    };
  } catch (error) {
    logger.error(
      {
        feedItemId: data.feedItemId,
        error: error instanceof Error ? error.message : "Unknown",
      },
      "[Gatekeeper] Write job failed"
    );
    // Re-throw so job-queue can retry (up to maxRetries) and mark as failed on exhaustion
    throw error;
  }
}

// ============================================
// REVIEW JOB HANDLER
// Gate 2: Reviews written article
// ============================================

async function handleReviewJob(
  data: GatekeeperReviewJobData
): Promise<{ success: boolean; result: any }> {
  logger.info(
    {
      contentId: data.contentId,
      revisionCount: data.revisionCount || 0,
    },
    "[Gatekeeper] Handling review job (Gate 2)"
  );

  try {
    const orchestrator = getGatekeeperOrchestrator();
    const before = await db.query.contents.findFirst({ where: eq(contents.id, data.contentId) });
    if (before) await translateNativeSlug(data.contentId, before.slug, before.title);

    const result = await orchestrator.reviewArticle(data.contentId, data.revisionCount || 0);

    logger.info(
      {
        contentId: data.contentId,
        decision: result.decision,
        quality: result.overallQuality,
      },
      "[Gatekeeper] Review complete"
    );

    // The verdict's substance, not just its number. "Why was this held at 62?"
    // is the first question an operator asks, and until now the answer was
    // discarded here — diagnosable only by regenerating the article.
    if (result.decision !== "approve") {
      logger.info(
        {
          contentId: data.contentId,
          issues: (result.issues ?? []).slice(0, 12),
          corrections: (result.corrections ?? []).slice(0, 12),
          editorNotes: result.editorNotes,
        },
        "[Gatekeeper] Verdict detail"
      );
    }

    // If approved: publish (default) OR hold as draft for human review when
    // AUTO_PUBLISH=false. Either way we compute JSON-LD so the draft is review-ready.
    if (result.decision === "approve") {
      try {
        // Same shared policy the gatekeeper used, so the two writes agree.
        const autoPublish = shouldAutoPublish();
        const publishedAt = new Date();

        // Regenerate JSON-LD with the real publication date
        const [row] = await db
          .select({
            title: contents.title,
            slug: contents.slug,
            metaDescription: contents.metaDescription,
            summary: contents.summary,
            heroImage: contents.heroImage,
            writerId: contents.writerId,
            faq: articles.faq,
          })
          .from(contents)
          .leftJoin(articles, eq(articles.contentId, contents.id))
          .where(eq(contents.id, data.contentId));

        if (row) row.slug = await translateNativeSlug(data.contentId, row.slug, row.title);

        const jsonLd = row
          ? schemaGenerator.generateFullSchema({
              title: row.title,
              description: row.metaDescription || row.summary || "",
              slug: row.slug,
              heroImage: row.heroImage,
              faqs: row.faq || [],
              authorName: row.writerId,
              publishedAt,
            })
          : undefined;

        // Held articles stay in_review (never "draft": the publish scheduler
        // auto-slots every unscheduled draft, which made the switch protect
        // nothing). Auto-published articles go through the ONE publish path,
        // publishContentById, so the remote targets receive them — a raw
        // status flip here left rows saying "published" that no site had.
        await db
          .update(contents)
          .set({
            status: "in_review",
            updatedAt: publishedAt,
            ...(jsonLd && { seoSchema: jsonLd }),
          })
          .where(eq(contents.id, data.contentId));

        let wentLive = false;
        if (autoPublish && approvedToCalendar()) {
          // Cleared now, so the slot it takes is one it will keep; the
          // publish scheduler's auto-slot pass places every unscheduled draft.
          let blocker = await publishBlocker(data.contentId);
          if (blocker?.reason === "media_not_ready" && (await repairArticleMedia(data.contentId))) {
            blocker = await publishBlocker(data.contentId);
          }
          if (!blocker) {
            await db
              .update(contents)
              .set({ status: "draft", scheduledFor: null, updatedAt: new Date() })
              .where(and(eq(contents.id, data.contentId), eq(contents.status, "in_review")));
            logger.info({ contentId: data.contentId }, "[Gatekeeper] Approved article queued for the publish calendar");
          } else {
            const sentBack =
              blocker.reason === "content_quality" &&
              (await sendPublishFindingsForRevision(data, blocker.issues));
            if (!sentBack) {
              logger.warn(
                { contentId: data.contentId, reason: blocker.reason },
                "[Gatekeeper] Approved article did not go live — left for a person"
              );
            }
          }
        } else if (autoPublish) {
          let published = await publishContentById(data.contentId);
          // The media gate parks the row in review; fresh media (bank first)
          // and one more try, instead of a person who never comes.
          if (!published.ok && published.reason === "media_not_ready" && (await repairArticleMedia(data.contentId))) {
            published = await publishContentById(data.contentId);
          }
          wentLive = published.ok;
          if (!published.ok) {
            // publishContentById already parked or restored the row and logged why.
            const sentBack =
              published.reason === "content_quality" &&
              (await sendPublishFindingsForRevision(data, published.issues));
            if (!sentBack) {
              logger.warn(
                { contentId: data.contentId, reason: published.reason },
                "[Gatekeeper] Approved article did not go live — left for a person"
              );
            }
          }
        }

        // Mark the source Document-Library idea: published, or 'ready' (approved,
        // awaiting human publish) when auto-publish is off.
        if (data.libraryItemId) {
          try {
            await db
              .update(libraryItems)
              .set({
                status: wentLive ? "published" : "ready",
                contentId: data.contentId,
                updatedAt: new Date(),
              })
              .where(eq(libraryItems.id, data.libraryItemId));
          } catch (err) {
            logger.warn(
              { libraryItemId: data.libraryItemId, error: err },
              "[Gatekeeper] Failed to update library item on publish (non-fatal)"
            );
          }
        }

        logger.info(
          { contentId: data.contentId, autoPublish, wentLive },
          wentLive
            ? "[Gatekeeper] Article approved and published"
            : "[Gatekeeper] Article approved — held as draft for review (AUTO_PUBLISH=false)"
        );
      } catch (err) {
        logger.error(
          { contentId: data.contentId, error: err },
          "[Gatekeeper] Failed to update article status"
        );
      }
    }

    return {
      success: true,
      result: {
        decision: result.decision,
        quality: result.overallQuality,
        issues: result.issues?.length || 0,
      },
    };
  } catch (error) {
    logger.error(
      {
        contentId: data.contentId,
        error: error instanceof Error ? error.message : "Unknown",
      },
      "[Gatekeeper] Review job failed"
    );
    return {
      success: false,
      result: { error: error instanceof Error ? error.message : "Unknown" },
    };
  }
}

/**
 * A native-script slug (the writer's English slug call failed) fails Gate 2's
 * readable-slug check, which no editor pass can fix, and the sites' sync drops
 * it anyway (one site had an article rejected twice for the slug alone). One more
 * translation try before review and before publish; a failure keeps the slug.
 */
async function translateNativeSlug(contentId: string, slug: string, title: string): Promise<string> {
  if (slugStyle() !== "english" || !/[^\x00-\x7f]/.test(slug)) return slug;
  const english = await buildUniqueSlug(title, { excludeId: contentId }).catch(() => "");
  if (!english || !/^[a-z0-9-]+$/.test(english)) return slug;
  await db.update(contents).set({ slug: english }).where(eq(contents.id, contentId));
  logger.info({ contentId, from: slug, to: english }, "[Gatekeeper] Native slug replaced with an English one");
  return english;
}

/**
 * The editorial audit at publish (heading stuffing, internal links, ...) runs
 * after the reviewer approved, and its findings are mechanical and fixable.
 * Parking the article for a person meant nothing went live: on one site every
 * approved article stopped there and no one came. So the findings go back through the editor as must-fix corrections and the
 * article is reviewed again. Bounded: once the extra rounds are spent the
 * article is left for a person as before.
 */
async function sendPublishFindingsForRevision(
  data: GatekeeperReviewJobData,
  issues: { code: string; message: string }[]
): Promise<boolean> {
  const revisionCount = data.revisionCount ?? 0;
  const maxRevisions = Number(process.env.MAX_REVISIONS) || 1;
  const extraRounds = publishFixRounds();
  if (issues.length === 0 || revisionCount >= maxRevisions + extraRounds) return false;

  const corrections: CorrectionInstruction[] = issues.map((issue) => ({
    section: "whole article",
    issue: issue.code,
    instruction: issue.message,
    priority: "must_fix",
  }));
  await jobQueue.addJob(
    "gatekeeper_revision" as JobType,
    {
      contentId: data.contentId,
      revisionPrompt: corrections.map((c) => `- ${c.instruction}`).join("\n"),
      corrections,
      revisionCount: revisionCount + 1,
      maxRevisions: maxRevisions + extraRounds,
    },
    { priority: 2 }
  );
  logger.info(
    { contentId: data.contentId, revisionCount: revisionCount + 1, issues: issues.map((i) => i.code) },
    "[Gatekeeper] Publish audit findings sent back to the editor"
  );
  return true;
}

// ============================================
// REVISION JOB HANDLER
// Sends article back to writer with corrections
// ============================================

/**
 * One editor call for a revision: the healthiest engine, with a timeout long
 * enough for a full-length article and short enough that a hung provider
 * does not hold the queue. Errors propagate; reviseArticle turns them into a
 * reason.
 */
async function callEditorEngine(system: string, user: string, attempt = 0, tried: Set<string> = new Set()): Promise<string> {
  // Second attempt = a different engine: a refused revision is usually one
  // model's bad roll, not a property of the article.
  const engine = attempt === 0 ? EngineRegistry.getNextEngine() : EngineRegistry.getNextFromQueue(tried) ?? EngineRegistry.getNextEngine();
  if (!engine) throw new Error("No engine available for the editor pass");
  tried.add(engine.id);
  const timeoutMs = Number(process.env.EDITOR_TIMEOUT_MS) || 180_000;
  try {
    const response = await Promise.race([
      generateWithEngine(engine, system, user),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`editor timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    EngineRegistry.reportSuccess(engine.id);
    return response;
  } catch (error) {
    EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function handleRevisionJob(
  data: GatekeeperRevisionJobData
): Promise<{ success: boolean; result: any }> {
  logger.info(
    {
      contentId: data.contentId,
      revisionCount: data.revisionCount,
    },
    "[Gatekeeper] Handling revision job"
  );

  try {
    // Fetch original content
    const content = await db.query.contents.findFirst({
      where: eq(contents.id, data.contentId),
    });

    if (!content) {
      return { success: false, result: { error: "Content not found" } };
    }

    const triedEditors = new Set<string>();
    // The editor pass: apply the reviewer's corrections to the article that
    // exists. This used to call the writer with contentType "revision", which
    // ignored the corrections and produced a fresh English guide that failed
    // the word floor every time — every "revise" verdict stranded the article.
    const outcome = await reviseArticle(
      {
        title: content.title,
        metaTitle: content.metaTitle,
        metaDescription: content.metaDescription,
        answerCapsule: content.answerCapsule,
        blocks: (content.blocks as any[]) || [],
      },
      data.corrections || [],
      data.revisionPrompt,
      (system, user, attempt) => callEditorEngine(system, user, attempt, triedEditors),
      new Date(),
      await inventoryLinksBlock()
    );

    if (!outcome.ok || !outcome.article) {
      logger.error(
        { contentId: data.contentId, revisionCount: data.revisionCount, reason: outcome.reason },
        "[Gatekeeper] Revision generation failed"
      );
      return { success: false, result: { error: `Revision generation failed: ${outcome.reason}` } };
    }
    const revised = outcome.article;

    // Update content
    await db
      .update(contents)
      .set({
        title: revised.title || content.title,
        metaTitle: revised.metaTitle || content.metaTitle,
        metaDescription: revised.metaDescription || content.metaDescription,
        answerCapsule: revised.answerCapsule || content.answerCapsule,
        blocks: revised.blocks as any,
        wordCount: revised.wordCount,
        updatedAt: new Date(),
      })
      .where(eq(contents.id, data.contentId));

    logger.info(
      { contentId: data.contentId },
      "[Gatekeeper] Revision complete, queuing for re-review"
    );

    // Queue for Gate 2 re-review
    await jobQueue.addJob(
      "gatekeeper_review" as JobType,
      {
        contentId: data.contentId,
        revisionCount: data.revisionCount,
      },
      { priority: 2 } // High priority for revisions
    );

    return {
      success: true,
      result: {
        contentId: data.contentId,
        revisionCount: data.revisionCount,
      },
    };
  } catch (error) {
    logger.error(
      {
        contentId: data.contentId,
        error: error instanceof Error ? error.message : "Unknown",
      },
      "[Gatekeeper] Revision job failed"
    );
    return {
      success: false,
      result: { error: error instanceof Error ? error.message : "Unknown" },
    };
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

interface BodyImage {
  url: string;
  alt: string;
  credit?: string | null;
}

function buildNewsArticleBlocks(content: any, bodyImages: BodyImage[]): any[] {
  const blocks: any[] = [];
  let idCounter = Date.now();
  let imageIdx = 0;

  const injectImage = () => {
    if (imageIdx < bodyImages.length) {
      const img = bodyImages[imageIdx++];
      blocks.push({
        type: "image",
        id: `img-${idCounter++}`,
        data: {
          url: img.url,
          alt: img.alt,
          caption: img.credit || undefined,
        },
      });
    }
  };

  if (content.introduction) {
    blocks.push({
      type: "text",
      id: `intro-${idCounter++}`,
      data: { content: sanitizeHtml(content.introduction) },
    });
    injectImage();
  }

  for (const section of content.sections || []) {
    if (section.heading) {
      blocks.push({
        type: "heading",
        id: `h-${idCounter++}`,
        data: { text: section.heading, level: 2 },
      });
    }
    if (section.content) {
      blocks.push({
        type: "text",
        id: `s-${idCounter++}`,
        data: { content: sanitizeHtml(section.content) },
      });
      injectImage();
    }
  }

  if (content.faqs && content.faqs.length > 0) {
    blocks.push(
      {
        type: "heading",
        id: `h-faq-${idCounter++}`,
        data: { text: sectionHeadings().faq, level: 2 },
      },
      {
        type: "faq",
        id: `faq-${idCounter++}`,
        data: { items: content.faqs },
      }
    );
  }

  return blocks;
}

/**
 * The H2 text for the writer's fixed sections.
 *
 * These were hardcoded in English, which put "What to Expect" above a paragraph
 * in another language on a customer's live site. `SECTION_HEADINGS_JSON`
 * overrides any subset; anything missing keeps the English default.
 */
interface SectionHeadings {
  whatToExpect: string;
  practicalTips: string;
  gettingStarted: string;
  faq: string;
}

const DEFAULT_SECTION_HEADINGS: SectionHeadings = {
  whatToExpect: "What to Expect",
  practicalTips: "Practical Tips",
  gettingStarted: "Getting Started",
  faq: "Frequently Asked Questions",
};

export function sectionHeadings(
  env: NodeJS.ProcessEnv = process.env
): SectionHeadings {
  const raw = env.SECTION_HEADINGS_JSON?.trim();
  if (!raw) return DEFAULT_SECTION_HEADINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<SectionHeadings>;
    return {
      whatToExpect: parsed.whatToExpect?.trim() || DEFAULT_SECTION_HEADINGS.whatToExpect,
      practicalTips: parsed.practicalTips?.trim() || DEFAULT_SECTION_HEADINGS.practicalTips,
      gettingStarted: parsed.gettingStarted?.trim() || DEFAULT_SECTION_HEADINGS.gettingStarted,
      faq: parsed.faq?.trim() || DEFAULT_SECTION_HEADINGS.faq,
    };
  } catch {
    logger.warn("[Persist] SECTION_HEADINGS_JSON is not valid JSON — using the defaults");
    return DEFAULT_SECTION_HEADINGS;
  }
}

function buildContentBlocks(content: any, bodyImages: BodyImage[] = []): any[] {
  // News articles have sections[] array instead of fixed fields
  if (content.sections && Array.isArray(content.sections)) {
    return buildNewsArticleBlocks(content, bodyImages);
  }

  const blocks: any[] = [];
  let idCounter = Date.now();
  let imageIdx = 0;

  // Helper: inject next available image block
  const injectImage = () => {
    if (imageIdx < bodyImages.length) {
      const img = bodyImages[imageIdx++];
      blocks.push({
        type: "image",
        id: `img-${idCounter++}`,
        data: {
          url: img.url,
          alt: img.alt,
          caption: img.credit || undefined,
        },
      });
    }
  };

  if (content.introduction) {
    blocks.push({
      type: "text",
      id: `intro-${idCounter++}`,
      data: { content: sanitizeHtml(content.introduction) },
    });
    injectImage(); // image after introduction
  }

  // Section headings are part of the article a reader sees, so they must match
  // the publication language. Configurable rather than translated in code: one
  // JSON object per install, set once, and English stays the default.
  const headings = sectionHeadings();

  if (content.whatToExpect) {
    blocks.push(
      {
        type: "heading",
        id: `h-expect-${idCounter++}`,
        data: { text: headings.whatToExpect, level: 2 },
      },
      {
        type: "text",
        id: `expect-${idCounter++}`,
        data: { content: sanitizeHtml(content.whatToExpect) },
      }
    );
    injectImage(); // image after whatToExpect
  }

  if (content.body) {
    blocks.push({
      type: "text",
      id: `body-${idCounter++}`,
      data: { content: sanitizeHtml(content.body) },
    });
    injectImage(); // image after body
  }

  if (content.visitorTips) {
    blocks.push(
      {
        type: "heading",
        id: `h-tips-${idCounter++}`,
        data: { text: headings.practicalTips, level: 2 },
      },
      {
        type: "text",
        id: `tips-${idCounter++}`,
        data: { content: sanitizeHtml(content.visitorTips) },
      }
    );
  }

  if (content.howToGetThere) {
    blocks.push(
      {
        type: "heading",
        id: `h-directions-${idCounter++}`,
        data: { text: headings.gettingStarted, level: 2 },
      },
      {
        type: "text",
        id: `directions-${idCounter++}`,
        data: { content: sanitizeHtml(content.howToGetThere) },
      }
    );
  }

  if (content.conclusion) {
    blocks.push({
      type: "text",
      id: `conclusion-${idCounter++}`,
      data: { content: sanitizeHtml(content.conclusion) },
    });
  }

  if (content.faqs && content.faqs.length > 0) {
    blocks.push(
      {
        type: "heading",
        id: `h-faq-${idCounter++}`,
        data: { text: sectionHeadings().faq, level: 2 },
      },
      {
        type: "faq",
        id: `faq-${idCounter++}`,
        data: { items: content.faqs },
      }
    );
  }

  return blocks;
}

// ============================================
// AI GENERATE JOB HANDLER
// Bridges job queue → Gatekeeper pipeline for RSS content generation
// ============================================

interface AiGenerateJobData {
  jobType: string;
  feedId?: string;
  feedUrl?: string;
  feedName?: string;
  topic?: string;
  category?: string;
  locale?: string;
  keywords?: string[];
  quantity?: number;
  title?: string;
  description?: string;
}

async function handleAiGenerateJob(
  data: AiGenerateJobData
): Promise<{ success: boolean; result: any }> {
  logger.info(
    {
      jobType: data.jobType,
      feedId: data.feedId,
      feedName: data.feedName,
    },
    "[Gatekeeper] Handling ai_generate job"
  );

  try {
    if (data.jobType === "rss-content-generation" && data.feedId) {
      // Fetch unprocessed items from this specific feed
      const items = await rssReader.getUnprocessedItems(10, data.feedId);

      if (items.length === 0) {
        logger.info(
          { feedId: data.feedId, feedName: data.feedName },
          "[Gatekeeper] No unprocessed items for feed"
        );
        return {
          success: true,
          result: { message: "No unprocessed items", feedId: data.feedId, processed: 0 },
        };
      }

      // Run items through the Gatekeeper pipeline (Gate 1 → write jobs)
      const orchestrator = getGatekeeperOrchestrator();
      const stats = await orchestrator.processSpecificItems(items);

      logger.info(
        {
          feedId: data.feedId,
          feedName: data.feedName,
          evaluated: stats.itemsEvaluated,
          approved: stats.itemsApprovedForWriting,
          skipped: stats.itemsSkipped,
        },
        "[Gatekeeper] RSS content generation complete"
      );

      return {
        success: true,
        result: {
          feedId: data.feedId,
          feedName: data.feedName,
          itemsFound: items.length,
          itemsEvaluated: stats.itemsEvaluated,
          itemsApprovedForWriting: stats.itemsApprovedForWriting,
          itemsSkipped: stats.itemsSkipped,
        },
      };
    }

    if (data.jobType === "topic-content-generation" && data.keywords) {
      // Topic-based generation: use keywords to create content
      logger.info(
        { keywords: data.keywords },
        "[Gatekeeper] Topic content generation not yet implemented"
      );
      return {
        success: true,
        result: { message: "Topic content generation queued", keywords: data.keywords },
      };
    }

    if (data.jobType === "manual-content-generation" && data.title) {
      logger.info(
        { title: data.title },
        "[Gatekeeper] Manual content generation not yet implemented"
      );
      return {
        success: true,
        result: { message: "Manual content generation queued", title: data.title },
      };
    }

    logger.warn({ jobType: data.jobType }, "[Gatekeeper] Unknown ai_generate job type");
    return { success: false, result: { error: `Unknown job type: ${data.jobType}` } };
  } catch (error) {
    logger.error(
      {
        jobType: data.jobType,
        feedId: data.feedId,
        error: error instanceof Error ? error.message : "Unknown",
      },
      "[Gatekeeper] ai_generate job failed"
    );
    return {
      success: false,
      result: { error: error instanceof Error ? error.message : "Unknown" },
    };
  }
}

// ============================================
// REGISTER HANDLERS
// ============================================

export function registerGatekeeperJobHandlers(): void {
  logger.info("[Gatekeeper] Registering job handlers");

  // Handler for writing new articles (after Gate 1 approval)
  jobQueue.registerHandler<GatekeeperWriteJobData>("octypo_write" as JobType, async data => {
    return handleWriteJob(data);
  });

  // Handler for Gate 2 review
  jobQueue.registerHandler<GatekeeperReviewJobData>("gatekeeper_review" as JobType, async data => {
    return handleReviewJob(data);
  });

  // Handler for revisions
  jobQueue.registerHandler<GatekeeperRevisionJobData>(
    "gatekeeper_revision" as JobType,
    async data => {
      return handleRevisionJob(data);
    }
  );

  // Handler for rewrite (similar to revision)
  jobQueue.registerHandler<{ contentId: string; revisionPrompt: string; revisionCount: number }>(
    "octypo_rewrite" as JobType,
    async data => {
      return handleRevisionJob({
        ...data,
        corrections: [],
        maxRevisions: 3,
      });
    }
  );

  // Handler for ai_generate jobs (from API "Create Content Job")
  jobQueue.registerHandler<AiGenerateJobData>("ai_generate" as JobType, async data => {
    return handleAiGenerateJob(data);
  });

  // Handler for batch hero-image regeneration (one content row per job, drains
  // through the queue so renders are rate-limited by maxConcurrent).
  jobQueue.registerHandler<{ contentId: string; mediaPlan?: MediaPlanItem[] }>(
    "regenerate_image" as JobType,
    async data => {
      try {
        const media = data.mediaPlan?.length
          ? await regenerateArticleMedia(data.contentId, data.mediaPlan)
          : { heroImage: await regenerateArticleImage(data.contentId), bodyImages: [] };
        return { success: true, result: { contentId: data.contentId, ...media } };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown";
        logger.error(
          { contentId: data.contentId, error: message },
          "[Gatekeeper] regenerate_image job failed"
        );
        // Throw so the queue records the failure + retries up to maxRetries.
        throw error;
      }
    }
  );

  // Handler for promo-video rendering. A render takes tens of seconds, so it
  // never runs inside a request or inside publishing: an article must not wait
  // on a video, and a failed render must not mark an article unpublished.
  jobQueue.registerHandler<{ contentId: string }>(
    "render_article_video" as JobType,
    async data => {
      const url = await renderPromoVideoFor(data.contentId);
      return { success: true, result: { contentId: data.contentId, promoVideoUrl: url } };
    }
  );

  // Handler for metadata backfill (one content row per job). Brings older
  // drafts up to the current standard: rebuilds a concise keyword-slug and
  // derives Quick Facts. Idempotent — re-running is safe: the slug is only
  // rewritten when it actually changes, and PUBLISHED rows are never touched
  // (URL safety). Quick Facts are derived when missing, or always when
  // `force` is set (used to refresh rows derived from an earlier, weaker pass).
  jobQueue.registerHandler<{ contentId: string; force?: boolean }>(
    "backfill_meta" as JobType,
    async data => {
      const [row] = await db
        .select({
          id: contents.id,
          title: contents.title,
          slug: contents.slug,
          status: contents.status,
          primaryKeyword: contents.primaryKeyword,
          blocks: contents.blocks,
          quickFacts: contents.quickFacts,
        })
        .from(contents)
        .where(eq(contents.id, data.contentId))
        .limit(1);

      if (!row) {
        logger.warn({ contentId: data.contentId }, "[BackfillMeta] content not found");
        return { success: false, result: { error: "not found" } };
      }
      // Never mutate a live row — its slug is a public URL.
      if (row.status === "published") {
        return { success: true, result: { contentId: row.id, skipped: "published" } };
      }

      const updates: Partial<typeof contents.$inferInsert> = {};

      // Rebuild a concise, keyword-focused slug; only apply when it changes.
      // excludeId keeps the row from colliding with its own current slug.
      const newSlug = await buildUniqueSlug(row.title, {
        primaryKeyword: row.primaryKeyword ?? undefined,
        excludeId: row.id,
      });
      if (newSlug && newSlug !== row.slug) updates.slug = newSlug;

      // Derive Quick Facts (the LLM call is the expensive part) when missing,
      // or always when forced. Pull the body from the stored blocks — the live
      // pipeline derives from freshly-generated text, so this is the only path
      // that reads persisted blocks; it must match their {type,data:{...}} shape.
      if (!row.quickFacts || data.force) {
        const bodyText = blocksToPlainText(row.title, row.blocks);
        const facts = await deriveQuickFacts(row.title, bodyText);
        if (facts) updates.quickFacts = facts;
      }

      if (Object.keys(updates).length === 0) {
        return { success: true, result: { contentId: row.id, changed: false } };
      }

      updates.updatedAt = new Date();
      await db.update(contents).set(updates).where(eq(contents.id, row.id));
      logger.info(
        { contentId: row.id, slug: updates.slug ?? row.slug, quickFacts: !!updates.quickFacts },
        "[BackfillMeta] backfill complete"
      );
      return {
        success: true,
        result: { contentId: row.id, changed: true, slug: updates.slug, quickFacts: !!updates.quickFacts },
      };
    }
  );

  // Handler for queued items (S3 tier from Gate 1 - deferred for later processing)
  jobQueue.registerHandler<{ feedItemId: string; selection: any; queuedAt: string }>(
    "gatekeeper_queued" as JobType,
    async data => {
      logger.info(
        { feedItemId: data.feedItemId, tier: data.selection?.tier },
        "[Gatekeeper] Processing queued item"
      );

      const selection = data.selection;
      if (!selection || selection.decision !== "queue") {
        return { success: false, result: { error: "Invalid queued item data" } };
      }

      // Fetch the original RSS item
      const items = await rssReader.getUnprocessedItems(1, undefined);
      const item = items.find((i: any) => i.id === data.feedItemId);

      if (!item) {
        logger.info(
          { feedItemId: data.feedItemId },
          "[Gatekeeper] Queued item no longer available"
        );
        return { success: true, result: { message: "Item no longer available" } };
      }

      // Re-evaluate through Gate 1 with fresh context
      const orchestrator = getGatekeeperOrchestrator();
      const stats = await orchestrator.processSpecificItems([item]);

      return {
        success: true,
        result: {
          feedItemId: data.feedItemId,
          itemsEvaluated: stats.itemsEvaluated,
          itemsApprovedForWriting: stats.itemsApprovedForWriting,
          itemsSkipped: stats.itemsSkipped,
        },
      };
    }
  );

  logger.info("[Gatekeeper] Job handlers registered (including ai_generate, gatekeeper_queued)");
}
