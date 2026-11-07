/**
 * RSS Feed Reader Service
 *
 * A proper RSS feed reader using rss-parser library.
 * Based on octypo-main implementation patterns.
 *
 * Features:
 * - Proper XML parsing with rss-parser
 * - Feed item storage with deduplication
 * - Processed item tracking
 * - Automatic fetch scheduling
 */

import Parser from "rss-parser";
import { db } from "../db.js";
import { rssFeeds } from "../schema/index.js";

import { eq, isNull, sql } from "drizzle-orm";

// ============================================================================
// TYPES
// ============================================================================

export interface FeedItem {
  id: string;
  feedId: string;
  title: string;
  url: string;
  summary: string;
  publishedDate: Date | null;
  source: string;
  category: string;
  processed: boolean;
  createdAt: Date;
}

export interface RSSFeedConfig {
  id: string;
  url: string;
  name: string;
  category: string;
  topicId: string | null;
  isActive: boolean;
  lastFetchedAt: Date | null;
}

export interface FetchResult {
  feedId: string;
  feedName: string;
  itemsFetched: number;
  newItems: number;
  duplicatesSkipped: number;
  errors: string[];
}

// ============================================================================
// RSS READER CLASS
// ============================================================================

class RSSReader {
  private readonly parser: Parser;
  private readonly feedItemsTable = "rss_feed_items";
  private initialized = false;

  constructor() {
    this.parser = new Parser({
      timeout: 30000,
      headers: {
        "User-Agent": "Octypo-RSS-Reader/1.0",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      customFields: {
        item: [
          ["media:content", "media"],
          ["content:encoded", "contentEncoded"],
        ],
      },
    });
  }

  /**
   * Initialize the feed items table if not exists
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Drop old table if it has wrong column types (uuid instead of varchar)
    await db.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'rss_feed_items'
          AND column_name = 'feed_id'
          AND data_type = 'uuid'
        ) THEN
          DROP TABLE rss_feed_items CASCADE;
        END IF;
      END $$
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS rss_feed_items (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        feed_id VARCHAR NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        url VARCHAR(2000) NOT NULL UNIQUE,
        summary TEXT,
        published_date TIMESTAMPTZ,
        source VARCHAR(200),
        category VARCHAR(100),
        processed BOOLEAN DEFAULT FALSE,
        content_id VARCHAR REFERENCES contents(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        status VARCHAR(50) DEFAULT 'pending',
        gate1_score INTEGER,
        gate1_seo_score INTEGER,
        gate1_aeo_score INTEGER,
        gate1_virality_score INTEGER,
        gate1_decision VARCHAR(20),
        gate1_tier VARCHAR(10),
        gate1_value VARCHAR(20),
        gate1_cost VARCHAR(20),
        gate1_reasoning TEXT,
        gate1_writer_id VARCHAR(100),
        gate1_writer_name VARCHAR(200),
        gate1_keywords TEXT,
        human_override BOOLEAN DEFAULT FALSE,
        human_override_reason TEXT,
        human_override_at TIMESTAMPTZ
      )
    `);

    // Add Gate1 columns if they don't exist (for existing tables)
    await db.execute(sql`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'rss_feed_items' AND column_name = 'gate1_score') THEN
          ALTER TABLE rss_feed_items ADD COLUMN gate1_score INTEGER;
          ALTER TABLE rss_feed_items ADD COLUMN gate1_seo_score INTEGER;
          ALTER TABLE rss_feed_items ADD COLUMN gate1_aeo_score INTEGER;
          ALTER TABLE rss_feed_items ADD COLUMN gate1_virality_score INTEGER;
          ALTER TABLE rss_feed_items ADD COLUMN gate1_decision VARCHAR(20);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_tier VARCHAR(10);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_value VARCHAR(20);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_cost VARCHAR(20);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_reasoning TEXT;
          ALTER TABLE rss_feed_items ADD COLUMN gate1_writer_id VARCHAR(100);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_writer_name VARCHAR(200);
          ALTER TABLE rss_feed_items ADD COLUMN gate1_keywords TEXT;
          ALTER TABLE rss_feed_items ADD COLUMN human_override BOOLEAN DEFAULT FALSE;
          ALTER TABLE rss_feed_items ADD COLUMN human_override_reason TEXT;
          ALTER TABLE rss_feed_items ADD COLUMN human_override_at TIMESTAMPTZ;
          ALTER TABLE rss_feed_items ADD COLUMN status VARCHAR(50) DEFAULT 'pending';
        END IF;
      END $$
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_rss_feed_items_feed_id ON rss_feed_items(feed_id)
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_rss_feed_items_processed ON rss_feed_items(processed)
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_rss_feed_items_url ON rss_feed_items(url)
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_rss_feed_items_gate1_decision ON rss_feed_items(gate1_decision)
    `);

    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_rss_feed_items_status ON rss_feed_items(status)
    `);

    this.initialized = true;
  }

  /**
   * Fetch items from a single RSS feed
   */
  async fetchFeed(feedId: string): Promise<FetchResult> {
    await this.initialize();

    const [feed] = await db.select().from(rssFeeds).where(eq(rssFeeds.id, feedId)).limit(1);

    if (!feed) {
      return {
        feedId,
        feedName: "Unknown",
        itemsFetched: 0,
        newItems: 0,
        duplicatesSkipped: 0,
        errors: ["Feed not found in database"],
      };
    }

    return this.fetchFeedByConfig({
      id: feed.id,
      url: feed.url,
      name: feed.name,
      category: feed.category || "news",
      topicId: feed.topicId,
      isActive: feed.isActive ?? true,
      lastFetchedAt: feed.lastFetchedAt,
    });
  }

  /**
   * Fetch items from a feed config
   */
  async fetchFeedByConfig(feed: RSSFeedConfig): Promise<FetchResult> {
    await this.initialize();

    const result: FetchResult = {
      feedId: feed.id,
      feedName: feed.name,
      itemsFetched: 0,
      newItems: 0,
      duplicatesSkipped: 0,
      errors: [],
    };

    try {
      // Parse the RSS feed
      const parsedFeed = await this.parser.parseURL(feed.url);
      const feedTitle = parsedFeed.title || feed.name;

      // Process each item
      for (const item of parsedFeed.items) {
        result.itemsFetched++;

        if (!item.link) {
          result.errors.push(`Item "${item.title}" has no link, skipping`);
          continue;
        }

        // Parse published date
        const publishedDate = this.parsePublishedDate(item.pubDate, item.isoDate);

        // Get summary text
        const summary = this.extractSummary(item);

        // Try to insert - unique constraint on URL handles deduplication
        try {
          await db.execute(sql`
            INSERT INTO rss_feed_items (feed_id, title, url, summary, published_date, source, category)
            VALUES (
              ${feed.id},
              ${(item.title || "").substring(0, 500)},
              ${item.link.substring(0, 2000)},
              ${summary.substring(0, 5000)},
              ${publishedDate ? publishedDate.toISOString() : null},
              ${feedTitle.substring(0, 200)},
              ${feed.category}
            )
            ON CONFLICT (url) DO NOTHING
          `);

          result.newItems++;
        } catch {
          // Duplicate URL, skip
          result.duplicatesSkipped++;
        }
      }

      // Update last fetched timestamp (success)
      await db
        .update(rssFeeds)
        .set({ lastFetchedAt: new Date() } as any)
        .where(eq(rssFeeds.id, feed.id));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMsg);

      // Always update lastFetchedAt — even on failure — so broken feeds
      // don't stay stuck in the "never fetched" queue forever.
      try {
        await db
          .update(rssFeeds)
          .set({ lastFetchedAt: new Date() } as any)
          .where(eq(rssFeeds.id, feed.id));
      } catch {
        // ignore timestamp update failure
      }
    }

    return result;
  }

  /**
   * Parse published date from feed item
   */
  private parsePublishedDate(pubDate?: string, isoDate?: string): Date | null {
    if (!pubDate && !isoDate) return null;
    try {
      const date = new Date(pubDate || isoDate!);
      return Number.isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }

  /**
   * Extract summary text from feed item
   */
  private extractSummary(item: Parser.Item): string {
    // Try content:encoded first (full content)
    if ((item as any).contentEncoded) {
      return this.stripHtml((item as any).contentEncoded);
    }

    // Then try content
    if (item.content) {
      return this.stripHtml(item.content);
    }

    // Then try summary/description
    if (item.summary) {
      return this.stripHtml(item.summary);
    }

    // Fallback to contentSnippet
    return item.contentSnippet || "";
  }

  /**
   * Strip HTML tags from text
   */
  private stripHtml(html: string): string {
    return html
      .replaceAll(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
      .replaceAll(/<[^>]+>/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim();
  }

  /**
   * Fetch all active feeds (parallel batches for speed)
   */
  async fetchAllFeeds(): Promise<FetchResult[]> {
    await this.initialize();

    const feeds = await db.select().from(rssFeeds).where(eq(rssFeeds.isActive, true));

    const results: FetchResult[] = [];
    const BATCH_SIZE = 8;

    // Process feeds in parallel batches
    for (let i = 0; i < feeds.length; i += BATCH_SIZE) {
      const batch = feeds.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(
        feed =>
          this.fetchFeedWithTimeout(
            {
              id: feed.id,
              url: feed.url,
              name: feed.name,
              category: feed.category || "news",
              topicId: feed.topicId,
              isActive: feed.isActive ?? true,
              lastFetchedAt: feed.lastFetchedAt,
            },
            12000
          ) // 12s timeout per feed
      );
      const batchResults = await Promise.allSettled(batchPromises);
      for (const [idx, settled] of batchResults.entries()) {
        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          results.push({
            feedId: batch[idx].id,
            feedName: batch[idx].name,
            itemsFetched: 0,
            newItems: 0,
            duplicatesSkipped: 0,
            errors: [settled.reason?.message || "Feed fetch timed out"],
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch only feeds that have never been fetched (lastFetchedAt IS NULL)
   */
  async fetchUnfetchedFeeds(): Promise<FetchResult[]> {
    await this.initialize();

    const feeds = await db.select().from(rssFeeds).where(isNull(rssFeeds.lastFetchedAt));

    const results: FetchResult[] = [];
    const BATCH_SIZE = 8;

    for (let i = 0; i < feeds.length; i += BATCH_SIZE) {
      const batch = feeds.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(feed =>
        this.fetchFeedWithTimeout(
          {
            id: feed.id,
            url: feed.url,
            name: feed.name,
            category: feed.category || "news",
            topicId: feed.topicId,
            isActive: feed.isActive ?? true,
            lastFetchedAt: feed.lastFetchedAt,
          },
          12000
        )
      );
      const batchResults = await Promise.allSettled(batchPromises);
      for (const [idx, settled] of batchResults.entries()) {
        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          results.push({
            feedId: batch[idx].id,
            feedName: batch[idx].name,
            itemsFetched: 0,
            newItems: 0,
            duplicatesSkipped: 0,
            errors: [settled.reason?.message || "Feed fetch timed out"],
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch a single feed with a hard timeout
   */
  private fetchFeedWithTimeout(feed: RSSFeedConfig, timeoutMs: number): Promise<FetchResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout after ${timeoutMs}ms fetching ${feed.name}`));
      }, timeoutMs);

      this.fetchFeedByConfig(feed)
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Get unprocessed items for content generation
   */
  async getUnprocessedItems(limit: number = 10, feedId?: string): Promise<FeedItem[]> {
    await this.initialize();

    let query = sql`
      SELECT
        id,
        feed_id as "feedId",
        title,
        url,
        summary,
        published_date as "publishedDate",
        source,
        category,
        processed,
        created_at as "createdAt"
      FROM rss_feed_items
      WHERE processed = FALSE
        AND (
          status IS NULL
          OR status NOT IN ('pending_review', 'queued')
          OR processed_at < NOW() - INTERVAL '30 minutes'
        )
    `;

    if (feedId) {
      query = sql`${query} AND feed_id = ${feedId}`;
    }

    query = sql`${query} ORDER BY published_date DESC NULLS LAST, created_at DESC LIMIT ${limit}`;

    const result = await db.execute(query);
    return result as unknown as FeedItem[];
  }

  /**
   * Mark an item as processed
   */
  async markProcessed(itemId: string, contentId?: string): Promise<void> {
    await this.initialize();

    if (contentId) {
      await db.execute(sql`
        UPDATE rss_feed_items
        SET processed = TRUE, content_id = ${contentId}, processed_at = NOW()
        WHERE id = ${itemId}
      `);
    } else {
      await db.execute(sql`
        UPDATE rss_feed_items
        SET processed = TRUE, processed_at = NOW()
        WHERE id = ${itemId}
      `);
    }
  }

  /**
   * Mark multiple items as processed
   */
  async markMultipleProcessed(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;

    await this.initialize();

    await db.execute(sql`
      UPDATE rss_feed_items
      SET processed = TRUE, processed_at = NOW()
      WHERE id = ANY(${itemIds})
    `);
  }

  /**
   * Get feed item by URL (for checking duplicates)
   */
  async getItemByUrl(url: string): Promise<FeedItem | null> {
    await this.initialize();

    const result = await db.execute(sql`
      SELECT
        id,
        feed_id as "feedId",
        title,
        url,
        summary,
        published_date as "publishedDate",
        source,
        category,
        processed,
        created_at as "createdAt"
      FROM rss_feed_items
      WHERE url = ${url}
      LIMIT 1
    `);

    return ((result as any)[0] as FeedItem) || null;
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalFeeds: number;
    activeFeeds: number;
    totalItems: number;
    processedItems: number;
    unprocessedItems: number;
  }> {
    await this.initialize();

    const [feedStats] = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) FILTER (WHERE is_active = TRUE)::int`,
      })
      .from(rssFeeds);

    const itemStatsResult = await db.execute(sql`
      SELECT
        count(*)::int as total,
        count(*) FILTER (WHERE processed = TRUE)::int as processed,
        count(*) FILTER (WHERE processed = FALSE)::int as unprocessed
      FROM rss_feed_items
    `);

    const itemRow = (itemStatsResult as any)[0];

    return {
      totalFeeds: feedStats?.total || 0,
      activeFeeds: feedStats?.active || 0,
      totalItems: itemRow?.total || 0,
      processedItems: itemRow?.processed || 0,
      unprocessedItems: itemRow?.unprocessed || 0,
    };
  }

  /**
   * Get recent items from all feeds
   */
  async getRecentItems(limit: number = 20, sinceDate?: Date): Promise<FeedItem[]> {
    await this.initialize();

    let query = sql`
      SELECT
        id,
        feed_id as "feedId",
        title,
        url,
        summary,
        published_date as "publishedDate",
        source,
        category,
        processed,
        created_at as "createdAt"
      FROM rss_feed_items
    `;

    if (sinceDate) {
      query = sql`${query} WHERE created_at >= ${sinceDate.toISOString()}`;
    }

    query = sql`${query} ORDER BY created_at DESC LIMIT ${limit}`;

    const result = await db.execute(query);
    return result as unknown as FeedItem[];
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const rssReader = new RSSReader();

/**
 * Initialize RSS feed items table with Gate1 columns
 * Call this on server startup to ensure schema is ready
 */
export async function initializeRssFeedItemsTable(): Promise<void> {
  try {
    await rssReader.initialize();
  } catch (error) {
    console.error("[RSS Reader] Failed to initialize feed items table:", error);
  }
}

// ============================================================================
// SENSITIVE TOPIC FILTER
// ============================================================================

const SENSITIVE_TOPIC_KEYWORDS = [
  "kill",
  "dead",
  "death",
  "die",
  "dies",
  "died",
  "dying",
  "murder",
  "murdered",
  "homicide",
  "manslaughter",
  "crash",
  "collision",
  "accident",
  "fatal",
  "terror",
  "terrorist",
  "attack",
  "bomb",
  "bombing",
  "explosion",
  "war",
  "conflict",
  "invasion",
  "military strike",
  "disaster",
  "tragedy",
  "catastrophe",
  "shooting",
  "shot",
  "gunfire",
  "gunman",
  "victim",
  "victims",
  "casualties",
  "hostage",
  "kidnap",
  "abduct",
  "suicide",
  "suicide bombing",
  "epidemic",
  "pandemic",
  "outbreak",
  "virus spread",
];

export function isSensitiveTopic(
  title: string,
  description: string
): { sensitive: boolean; reason?: string } {
  const combined = `${title} ${description}`.toLowerCase();

  for (const keyword of SENSITIVE_TOPIC_KEYWORDS) {
    if (combined.includes(keyword.toLowerCase())) {
      return { sensitive: true, reason: `Contains sensitive keyword: "${keyword}"` };
    }
  }

  return { sensitive: false };
}

// ============================================================================
// TOPIC DETECTION
// ============================================================================

export { detectTopicFromContent } from "../config/topics.js";
