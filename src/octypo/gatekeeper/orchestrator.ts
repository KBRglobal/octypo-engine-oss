/**
 * Gatekeeper Orchestrator
 * Manages the complete autonomous content pipeline:
 * RSS → Gate1 (Selection) → Writer → Gate2 (Approval) → Publish
 *
 * Zero human touch. Fully autonomous.
 */

import { db } from "../../db.js";
import { contents } from "../../schema/index.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Gate1Selector, getGate1Selector } from "./gate1-selector.js";
import { SITE_NAME, SITE_URL } from "../../config/domain.js";

/** Convert tier to job priority (lower = higher priority) */
function tierToPriority(tier: string): number {
  if (tier === "S1") return 1;
  if (tier === "S2") return 3;
  return 5;
}
import { Gate2Approver, getGate2Approver } from "./gate2-approver.js";
import {
  ContentSelectionInput,
  ContentSelectionResult,
  ArticleApprovalInput,
  ArticleApprovalResult,
  GatekeeperConfig,
  DEFAULT_GATEKEEPER_CONFIG,
} from "./types.js";
import { logger } from "../../lib/logger.js";
import { qualityContextFromContent } from "../../quality/gate.js";
import { articles } from "../../schema/index.js";
import { siteInventory, slugsFromPaths } from "../../lib/site-inventory.js";
import { usablePrimarySources } from "../../lib/primary-sources.js";
import { auditContentAgainstCorpus } from "../content-quality.js";
import { jobQueue, JobType } from "../../job-queue.js";
import { rssReader, FeedItem } from "../rss-reader.js";
import {
  addStory,
  buildNewsIndex,
  findNewsDuplicate,
  NEWS_DUPLICATE_WINDOW_DAYS,
  type NewsDuplicate,
  type NewsIndex,
  type PastStory,
} from "./news-duplicate.js";

interface PipelineStats {
  itemsEvaluated: number;
  itemsApprovedForWriting: number;
  itemsSkipped: number;
  articlesWritten: number;
  articlesApproved: number;
  articlesRevised: number;
  articlesRejected: number;
  articlesPublished: number;
}

export class GatekeeperOrchestrator {
  private readonly config: GatekeeperConfig;
  private readonly gate1: Gate1Selector;
  private readonly gate2: Gate2Approver;
  private stats: PipelineStats;
  private isRunning: boolean = false;
  /** Stories written (or approved for writing) in the last 21 days; loaded per run. */
  private newsIndex: NewsIndex | null = null;

  constructor(config: Partial<GatekeeperConfig> = {}) {
    this.config = { ...DEFAULT_GATEKEEPER_CONFIG, ...config };
    this.gate1 = getGate1Selector(this.config);
    this.gate2 = getGate2Approver(this.config);
    this.stats = this.initStats();
  }

  private initStats(): PipelineStats {
    return {
      itemsEvaluated: 0,
      itemsApprovedForWriting: 0,
      itemsSkipped: 0,
      articlesWritten: 0,
      articlesApproved: 0,
      articlesRevised: 0,
      articlesRejected: 0,
      articlesPublished: 0,
    };
  }

  /**
   * Main pipeline: Process unprocessed RSS items
   */
  /**
   * @param maxItems     how many unprocessed feed items to EVALUATE this run.
   * @param maxApprovals how many of them may be approved for writing. Once
   *   reached, the remaining items are left unprocessed for the next run —
   *   evaluating is cheap (one classifier call), writing is not, and a strict
   *   selector needs to look at many items to find one worth writing.
   */
  async runPipeline(maxItems: number = 10, maxApprovals: number = Infinity): Promise<PipelineStats> {
    if (this.isRunning) {
      logger.warn("[Gatekeeper] Pipeline already running, skipping");
      return this.stats;
    }

    this.isRunning = true;
    this.stats = this.initStats();

    logger.info({ maxItems, maxApprovals }, "[Gatekeeper] Starting autonomous pipeline");

    try {
      // Step 1: Fetch unprocessed RSS items
      const items = await this.fetchUnprocessedItems(maxItems);
      logger.info({ count: items.length }, "[Gatekeeper] Fetched unprocessed items");

      if (items.length === 0) {
        logger.info("[Gatekeeper] No items to process");
        return this.stats;
      }

      this.newsIndex = await this.loadNewsIndex();

      // Step 2: Run Gate 1 (Selection) on each item
      for (const item of items) {
        if (this.stats.itemsApprovedForWriting >= maxApprovals) {
          logger.info({ maxApprovals }, "[Gatekeeper] Approval budget reached — leaving the rest for the next run");
          break;
        }
        await this.processItem(item);
      }

      logger.info({ stats: this.stats }, "[Gatekeeper] Pipeline complete");
      return this.stats;
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : "Unknown",
        },
        "[Gatekeeper] Pipeline failed"
      );
      throw error;
    } finally {
      this.isRunning = false;
      this.newsIndex = null;
    }
  }

  /**
   * The stories the engine wrote, or approved for writing, in the last 21
   * days: every feed item that reached a writer, and every article row. Never
   * throws — without the index the pipeline runs as before.
   */
  private async loadNewsIndex(): Promise<NewsIndex | null> {
    try {
      const days = NEWS_DUPLICATE_WINDOW_DAYS;
      const rows = (await db.execute(sql`
        SELECT i.id AS "feedItemId", i.title AS "feedTitle", c.title AS "title", c.slug AS "slug",
               c.primary_keyword AS "primaryKeyword",
               COALESCE(c.published_at, c.created_at, i.processed_at, i.created_at) AS "at"
        FROM rss_feed_items i
        LEFT JOIN contents c ON c.id = i.content_id
        WHERE (i.content_id IS NOT NULL OR i.status = 'pending_review' OR i.gate1_decision = 'write')
          AND COALESCE(i.processed_at, i.created_at) > NOW() - make_interval(days => ${days})
        UNION ALL
        SELECT NULL, NULL, c.title, c.slug, c.primary_keyword, COALESCE(c.published_at, c.created_at)
        FROM contents c
        WHERE COALESCE(c.published_at, c.created_at) > NOW() - make_interval(days => ${days})
          AND c.status <> 'archived'
      `)) as unknown as { rows?: PastStory[] } | PastStory[];
      const stories = Array.isArray(rows) ? rows : rows.rows ?? [];
      const prefix = (process.env.ARTICLE_PATH_PREFIX || "/guides").replace(/\/+$/, "");
      const base = (SITE_URL || "").replace(/\/+$/, "");
      for (const story of stories) {
        if (story.slug && base) story.url = `${base}${prefix}/${story.slug}/`;
      }
      return buildNewsIndex(stories);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[Gatekeeper] Recent stories unavailable — news duplicate check off for this run"
      );
      return null;
    }
  }

  /**
   * Skip a feed item whose story was already written in the last 21 days
   * (same main entities, same event). Checked before Gate 1, so a repeat
   * costs no evaluation either. Returns true when the item was skipped.
   */
  private async skipIfDuplicateStory(item: FeedItem): Promise<boolean> {
    if (!this.newsIndex) return false;
    const duplicate = findNewsDuplicate({ id: item.id, title: item.title, url: item.url }, this.newsIndex);
    if (!duplicate) return false;
    await this.markDuplicateStory(item, duplicate);
    return true;
  }

  private async markDuplicateStory(item: FeedItem, duplicate: NewsDuplicate): Promise<void> {
    const target =
      duplicate.story.url || duplicate.story.slug || duplicate.story.title || duplicate.story.feedTitle || "an earlier item";
    const reasoning = `Duplicate story (${duplicate.reason}) of ${target} — entities: ${duplicate.sharedEntities.join(", ")}; events: ${duplicate.sharedEvents.join(", ") || "none"}`;
    try {
      await db.execute(sql`
        UPDATE rss_feed_items SET
          gate1_decision = 'skip',
          gate1_reasoning = ${reasoning},
          status = 'skipped'
        WHERE id = ${item.id}
      `);
    } catch (error) {
      logger.error(
        { feedItemId: item.id, error: error instanceof Error ? error.message : "Unknown" },
        "[Gatekeeper] Failed to record the duplicate-story skip"
      );
    }
    await this.markItemProcessed(item.id, null, "skipped");
    logger.info(
      { feedItemId: item.id, title: item.title.substring(0, 80), duplicateOf: target, reason: duplicate.reason },
      "[Gatekeeper] Item skipped — story already written"
    );
  }

  /** A story approved in this run counts for the rest of it. */
  private rememberStory(item: FeedItem): void {
    if (this.newsIndex) addStory(this.newsIndex, { feedItemId: item.id, feedTitle: item.title, at: new Date() });
  }

  /**
   * Process a single RSS item through the full pipeline
   */
  private async processItem(item: FeedItem): Promise<void> {
    const input: ContentSelectionInput = {
      feedItemId: item.id,
      title: item.title,
      summary: item.summary || "",
      sourceUrl: item.url,
      sourceName: item.source || "Unknown",
      category: item.category,
      publishedDate: item.publishedDate ? new Date(item.publishedDate) : undefined,
      // topicId will be detected from content by Gate1 or determined later
    };

    try {
      if (await this.skipIfDuplicateStory(item)) {
        this.stats.itemsSkipped++;
        return;
      }

      // Gate 1: Evaluate and decide
      const selection = await this.gate1.evaluate(input);
      this.stats.itemsEvaluated++;

      // Save Gate 1 decision
      await this.saveGate1Decision(item.id, selection);

      if (selection.decision === "skip") {
        this.stats.itemsSkipped++;
        await this.markItemProcessed(item.id, null, "skipped");
        logger.info(
          {
            feedItemId: item.id,
            title: item.title.substring(0, 50),
            score: selection.totalScore,
            reason: selection.reasoning,
          },
          "[Gatekeeper] Item skipped"
        );
        return;
      }

      if (selection.decision === "queue") {
        // Queue for later processing (S3 items)
        await this.queueForLater(item.id, selection);
        return;
      }

      // Decision is 'write' - proceed to writing
      this.stats.itemsApprovedForWriting++;

      // Queue writing job
      await this.queueWritingJob(item, selection);
      this.rememberStory(item);
    } catch (error) {
      logger.error(
        {
          feedItemId: item.id,
          error: error instanceof Error ? error.message : "Unknown",
        },
        "[Gatekeeper] Item processing failed"
      );
      // Mark as failed but don't block pipeline
      await this.markItemProcessed(item.id, null, "failed");
    }
  }

  /**
   * Gate 2: Review a written article
   * Called after writer completes
   */
  async reviewArticle(
    contentId: string,
    revisionCount: number = 0
  ): Promise<ArticleApprovalResult> {
    logger.info({ contentId, revisionCount }, "[Gatekeeper] Gate 2: Reviewing article");

    // Fetch article content
    const content = await db.query.contents.findFirst({
      where: eq(contents.id, contentId),
    });

    if (!content) {
      throw new Error(`Content not found: ${contentId}`);
    }

    const input: ArticleApprovalInput = {
      contentId: content.id,
      title: content.title,
      metaTitle: content.metaTitle || content.title,
      metaDescription: content.metaDescription || "",
      summary: content.summary || "",
      answerCapsule: content.answerCapsule ?? "",
      blocks: (content.blocks as any[]) || [],
      wordCount: content.wordCount || 0,
      writerId: content.writerId || "",
    };

    // Run Gate 2 review. The deterministic scorer judges the page publish will
    // build — its JSON-LD, hero and keyword — not the row's writer-side columns.
    // It also gets what the audit used to run blind without: the site's real
    // page list (for internal links), the article's source and the official
    // pages that were opened while writing.
    const [articleRow] = await db
      .select({ sourceUrl: articles.sourceUrl, sourceChecks: articles.sourceChecks })
      .from(articles)
      .where(eq(articles.contentId, contentId))
      .limit(1);
    const [publishedRows, inventory] = await Promise.all([
      db
        .select({ slug: contents.slug })
        .from(contents)
        .where(and(eq(contents.status, "published"), isNotNull(contents.slug))),
      siteInventory(),
    ]);
    const publishedSlugs = [
      ...new Set([...publishedRows.map(r => r.slug.toLowerCase()), ...slugsFromPaths(inventory.paths)]),
    ];
    if (inventory.error) {
      logger.warn({ error: inventory.error }, "[Gatekeeper] Site inventory unavailable — internal links judged on the database alone");
    }
    // Library and commercial articles carry no source row; only a feed-born
    // article is held to the primary-source rule.
    const sourceUrls = articleRow?.sourceUrl !== undefined && articleRow?.sourceUrl !== null ? [articleRow.sourceUrl] : undefined;
    const result = await this.gate2.review(input, revisionCount, {
      ...qualityContextFromContent(content),
      publishedSlugs: publishedSlugs.length > 0 ? publishedSlugs : null,
      sourceUrls,
      primarySources: usablePrimarySources(articleRow?.sourceChecks),
    });

    // Handle decision
    await this.handleGate2Decision(contentId, result, revisionCount);

    return result;
  }

  /**
   * Handle Gate 2 decision
   */
  private async handleGate2Decision(
    contentId: string,
    result: ArticleApprovalResult,
    revisionCount: number
  ): Promise<void> {
    switch (result.decision) {
      case "approve":
        this.stats.articlesApproved++;
        await this.approveForPublication(contentId);
        break;

      case "revise":
        this.stats.articlesRevised++;
        await this.sendForRevision(contentId, result, revisionCount);
        break;

      case "reject":
        this.stats.articlesRejected++;
        await this.rejectArticle(contentId, result.reasoning);
        break;
    }
  }

  /**
   * Build Article JSON-LD schema for a content record
   */
  private buildArticleSchema(content: any): Record<string, any> {
    const slug = content.slug || content.id;
    const heroImage = content.heroImage || content.featuredImage || content.imageUrl || "";

    const primaryKeyword: string =
      content.primaryKeyword || content.metaTitle || content.title || "";
    const secondaryKeywords: string[] = Array.isArray(content.secondaryKeywords)
      ? content.secondaryKeywords
      : [];
    const keywordsStr = [primaryKeyword, ...secondaryKeywords].filter(Boolean).join(", ");

    // Use NewsArticle for the news category for Google News eligibility
    const articleType = content.article?.category === "news" ? "NewsArticle" : "Article";
    const writerName = content.writer?.name || null;
    const baseUrl = SITE_URL || "";

    return {
      "@context": "https://schema.org",
      "@type": articleType,
      headline: content.title || "",
      description: content.metaDescription || content.summary || "",
      author: writerName
        ? { "@type": "Person", name: writerName, ...(baseUrl ? { url: baseUrl } : {}) }
        : { "@type": "Organization", name: SITE_NAME, ...(baseUrl ? { url: baseUrl } : {}) },
      publisher: {
        "@type": "Organization",
        name: SITE_NAME,
        ...(baseUrl ? { url: baseUrl } : {}),
      },
      datePublished: (content.publishedAt || new Date()).toISOString(),
      dateModified: (content.updatedAt || new Date()).toISOString(),
      image: heroImage ? { "@type": "ImageObject", url: heroImage, width: 1200, height: 630 } : undefined,
      mainEntityOfPage: baseUrl
        ? {
            "@type": "WebPage",
            "@id": `${baseUrl}/article/${slug}`,
          }
        : undefined,
      keywords: keywordsStr,
      wordCount: content.wordCount || 0,
      inLanguage: "en",
      articleSection: content.article?.category
        ? String(content.article.category).charAt(0).toUpperCase() + String(content.article.category).slice(1)
        : "General",
      speakable: {
        "@type": "SpeakableSpecification",
        cssSelector: [".answer-capsule", "h1", ".article-intro"],
      },
    };
  }

  /**
   * Approve article for publication
   */
  private async approveForPublication(contentId: string): Promise<void> {
    logger.info({ contentId }, "[Gatekeeper] Approving for publication");

    // Fetch full content to build structured data
    const content = await db.query.contents.findFirst({
      where: eq(contents.id, contentId),
    });

    if (content) {
      const qualityIssues = await auditContentAgainstCorpus({
        id: content.id,
        title: content.title,
        primaryKeyword: content.primaryKeyword,
        answerCapsule: content.answerCapsule,
        blocks: content.blocks,
      });
      if (qualityIssues.length > 0) {
        await db
          .update(contents)
          .set({ status: "in_review", updatedAt: new Date() })
          .where(eq(contents.id, contentId));
        logger.warn(
          { contentId, issues: qualityIssues },
          "[Gatekeeper] Editorial quality gate returned article to review"
        );
        return;
      }
    }

    const now = new Date();
    // Approval never flips the row to "published" here. Going live is one
    // path only — publishContentById — because that is where the remote
    // targets (the customer's git repo, WordPress) are written; a bare status
    // flip produced rows that said "published" while no site had the article.
    // The review job handler calls it right after this when AUTO_PUBLISH is on;
    // otherwise the article waits here, in review, for a person.
    const updatePayload: Record<string, any> = {
      status: "in_review",
      updatedAt: now,
    };

    // Build and attach structured data schemas
    if (content) {
      const contentWithDates = { ...content, publishedAt: now, updatedAt: now };
      const articleSchema = this.buildArticleSchema(contentWithDates);
      updatePayload.seoSchema = JSON.stringify([articleSchema]);
    }

    await db
      .update(contents)
      .set(updatePayload as any)
      .where(eq(contents.id, contentId));

    // Auto-published: content is immediately live after Gatekeeper approval

    this.stats.articlesPublished++;
  }

  /**
   * Send article back for revision
   */
  private async sendForRevision(
    contentId: string,
    result: ArticleApprovalResult,
    currentRevisionCount: number
  ): Promise<void> {
    logger.info(
      {
        contentId,
        revisionCount: currentRevisionCount + 1,
      },
      "[Gatekeeper] Sending for revision"
    );

    // Still inside the review loop, so it stays "in_review". It used to be
    // parked as "draft" here, and the publish scheduler auto-slots drafts:
    // an article was put on the calendar while its revision was still being
    // written and would have gone live had the
    // re-review not finished first.
    await db
      .update(contents)
      .set({
        status: "in_review",
        updatedAt: new Date(),
      } as any)
      .where(eq(contents.id, contentId));

    // Queue revision job with correction instructions
    await jobQueue.addJob(
      "gatekeeper_revision" as JobType,
      {
        contentId,
        revisionPrompt: result.revisionPrompt,
        corrections: result.corrections,
        revisionCount: currentRevisionCount + 1,
        maxRevisions: result.maxRevisions,
      },
      { priority: 5 }
    );
  }

  /**
   * Reject article permanently
   */
  private async rejectArticle(contentId: string, reason: string): Promise<void> {
    logger.warn({ contentId, reason }, "[Gatekeeper] Rejecting article");

    // A rejected article needs a human, so it is held as "in_review" — the
    // same state a writer uses when it holds an article for a person. It was
    // parked as "draft" before, and the publish scheduler auto-slots every
    // draft without a calendar slot, so a rejection was one tick away from
    // being published.
    await db
      .update(contents)
      .set({
        status: "in_review",
        scheduledFor: null,
        updatedAt: new Date(),
      } as any)
      .where(eq(contents.id, contentId));

    // Could add to a rejection log table for analysis
  }

  /**
   * Fetch unprocessed RSS items
   */
  private async fetchUnprocessedItems(limit: number): Promise<FeedItem[]> {
    // Use rssReader which handles the raw SQL table
    return rssReader.getUnprocessedItems(limit);
  }

  /**
   * Mark RSS item as processed
   */
  private async markItemProcessed(
    feedItemId: string,
    contentId: string | null,
    status: string
  ): Promise<void> {
    // Use rssReader or raw SQL since table is created dynamically
    await rssReader.markProcessed(feedItemId, contentId || undefined);
  }

  /**
   * Save Gate 1 decision to database
   */
  private async saveGate1Decision(
    feedItemId: string,
    selection: ContentSelectionResult
  ): Promise<void> {
    try {
      await db.execute(sql`
        UPDATE rss_feed_items SET
          gate1_score = ${selection.totalScore},
          gate1_seo_score = ${selection.seoAnalysis.score},
          gate1_aeo_score = ${selection.aeoAnalysis.score},
          gate1_virality_score = ${selection.viralityAnalysis.score},
          gate1_decision = ${selection.decision},
          gate1_tier = ${selection.tier},
          gate1_value = ${selection.estimatedValue},
          gate1_cost = ${selection.estimatedCost},
          gate1_reasoning = ${selection.reasoning},
          gate1_writer_id = ${selection.recommendedWriterId},
          gate1_writer_name = ${selection.writerName},
          status = ${selection.decision === "write" ? "pending_review" : selection.decision === "skip" ? "skipped" : "queued"}
        WHERE id = ${feedItemId}
      `);

      logger.info(
        {
          feedItemId,
          tier: selection.tier,
          decision: selection.decision,
          score: selection.totalScore,
          writer: selection.writerName,
        },
        "[Gatekeeper] Gate 1 Decision saved to DB"
      );
    } catch (error) {
      logger.error(
        {
          feedItemId,
          error: error instanceof Error ? error.message : "Unknown",
        },
        "[Gatekeeper] Failed to save Gate 1 decision"
      );
    }
  }

  /**
   * Queue item for later processing
   */
  private async queueForLater(
    feedItemId: string,
    selection: ContentSelectionResult
  ): Promise<void> {
    await jobQueue.addJob(
      "gatekeeper_queued" as JobType,
      {
        feedItemId,
        selection,
        queuedAt: new Date(),
      },
      { priority: 8 } // Lower priority
    );

    logger.info(
      {
        feedItemId,
        tier: selection.tier,
      },
      "[Gatekeeper] Item queued for later"
    );
  }

  /**
   * Queue writing job
   */
  private async queueWritingJob(item: FeedItem, selection: ContentSelectionResult): Promise<void> {
    await jobQueue.addJob(
      "octypo_write" as JobType,
      {
        feedItemId: item.id,
        title: item.title,
        summary: item.summary,
        sourceUrl: item.url,
        category: item.category,
        writerId: selection.recommendedWriterId,
        tier: selection.tier,
        gate1Score: selection.totalScore,
        gate1Reasoning: selection.reasoning,
      },
      { priority: tierToPriority(selection.tier) }
    );

    logger.info(
      {
        feedItemId: item.id,
        writer: selection.writerName,
        tier: selection.tier,
        priority: tierToPriority(selection.tier),
      },
      "[Gatekeeper] Writing job queued"
    );
  }

  /**
   * Process specific items through Gate 1 → write pipeline
   * Used by ai_generate handler to process items from a specific feed
   */
  async processSpecificItems(items: FeedItem[]): Promise<PipelineStats> {
    const stats = this.initStats();
    // Its own index: this can run beside runPipeline, which owns this.newsIndex.
    const newsIndex = await this.loadNewsIndex();

    for (const item of items) {
      try {
        const duplicate = newsIndex ? findNewsDuplicate({ id: item.id, title: item.title, url: item.url }, newsIndex) : null;
        if (duplicate) {
          stats.itemsSkipped++;
          await this.markDuplicateStory(item, duplicate);
          continue;
        }

        const input: ContentSelectionInput = {
          feedItemId: item.id,
          title: item.title,
          summary: item.summary || "",
          sourceUrl: item.url,
          sourceName: item.source || "Unknown",
          category: item.category,
          publishedDate: item.publishedDate ? new Date(item.publishedDate) : undefined,
        };

        // Gate 1: Evaluate
        const selection = await this.gate1.evaluate(input);
        stats.itemsEvaluated++;

        await this.saveGate1Decision(item.id, selection);

        if (selection.decision === "skip") {
          stats.itemsSkipped++;
          await this.markItemProcessed(item.id, null, "skipped");
          continue;
        }

        if (selection.decision === "queue") {
          await this.queueForLater(item.id, selection);
          continue;
        }

        // Decision is 'write'
        stats.itemsApprovedForWriting++;

        await this.queueWritingJob(item, selection);
        if (newsIndex) addStory(newsIndex, { feedItemId: item.id, feedTitle: item.title, at: new Date() });
      } catch (error) {
        logger.error(
          {
            feedItemId: item.id,
            error: error instanceof Error ? error.message : "Unknown",
          },
          "[Gatekeeper] Item processing failed"
        );
        await this.markItemProcessed(item.id, null, "failed");
      }
    }

    return stats;
  }

  /**
   * Get current stats
   */
  getStats(): PipelineStats {
    return { ...this.stats };
  }

  /**
   * Check if pipeline is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let orchestratorInstance: GatekeeperOrchestrator | null = null;

export function getGatekeeperOrchestrator(
  config?: Partial<GatekeeperConfig>
): GatekeeperOrchestrator {
  if (!orchestratorInstance || config) {
    orchestratorInstance = new GatekeeperOrchestrator(config);
  }
  return orchestratorInstance;
}

/**
 * Job handler for gatekeeper revision jobs
 */
export async function handleRevisionJob(data: {
  contentId: string;
  revisionPrompt: string;
  corrections: any[];
  revisionCount: number;
  maxRevisions: number;
}): Promise<void> {
  logger.info(
    {
      contentId: data.contentId,
      revisionCount: data.revisionCount,
    },
    "[Gatekeeper] Handling revision job"
  );

  // This integrates with the existing Octypo writer system
  // Queue a rewrite job with the revision prompt

  await jobQueue.addJob(
    "octypo_rewrite" as JobType,
    {
      contentId: data.contentId,
      revisionPrompt: data.revisionPrompt,
      revisionCount: data.revisionCount,
    },
    { priority: 2 } // High priority for revisions
  );
}

/**
 * Job handler for post-write review
 * Called after writer completes an article
 */
export async function handlePostWriteReview(data: {
  contentId: string;
  revisionCount?: number;
}): Promise<void> {
  const orchestrator = getGatekeeperOrchestrator();
  await orchestrator.reviewArticle(data.contentId, data.revisionCount || 0);
}
