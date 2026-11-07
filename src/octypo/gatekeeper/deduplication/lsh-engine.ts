/**
 * LSH (Locality Sensitive Hashing) Deduplication Engine
 *
 * Main orchestrator for content deduplication in the Gatekeeper pipeline.
 * Integrates with Gate 1 to prevent duplicate content from being written.
 *
 * Performance:
 * - O(1) lookup for exact duplicates (fingerprint index)
 * - O(candidates) for near-duplicate detection with LSH bands
 *
 * Threshold: 85% similarity = duplicate (industry standard)
 */

import { db } from "../../../db.js";
import { contentFingerprints } from "../../../schema/index.js";
import { eq, and, lt, sql } from "drizzle-orm";
import { generateFingerprint } from "./fingerprint.js";
import {
  isDuplicate,
  findSimilarContent,
  storeFingerprint,
  getDeduplicationStats,
  SIMILARITY_THRESHOLD,
  RELATED_THRESHOLD,
  SimilarityResult,
} from "./similarity.js";
import { logger } from "../../../lib/logger.js";

export interface DeduplicationResult {
  isOriginal: boolean;
  duplicateOf?: {
    contentId: string | null;
    sourceTitle: string | null;
    sourceUrl: string | null;
    similarity: number;
  };
  relatedContent?: Array<{
    contentId: string | null;
    sourceTitle: string | null;
    similarity: number;
  }>;
  fingerprint: string;
  processingTimeMs: number;
}

export class DeduplicationEngine {
  private readonly similarityThreshold: number;
  private readonly enabled: boolean;

  constructor(
    options: {
      similarityThreshold?: number;
      enabled?: boolean;
    } = {}
  ) {
    this.similarityThreshold = options.similarityThreshold ?? SIMILARITY_THRESHOLD;
    this.enabled = options.enabled ?? true;
  }

  /**
   * Check if content should be processed or skipped due to duplication
   *
   * Called by Gate 1 before spending resources on evaluation
   */
  async checkContent(
    title: string,
    summary: string,
    sourceUrl?: string
  ): Promise<DeduplicationResult> {
    const startTime = Date.now();

    if (!this.enabled) {
      return {
        isOriginal: true,
        fingerprint: "",
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Combine title and summary for fingerprinting
    const text = `${title} ${summary}`.trim();

    if (text.length < 50) {
      // Too short to reliably fingerprint
      logger.warn({ title }, "[Dedup] Content too short for reliable fingerprinting");
      return {
        isOriginal: true,
        fingerprint: generateFingerprint(text),
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Step 1: Check URL first (fastest)
    if (sourceUrl) {
      const urlMatch = await db.query.contentFingerprints.findFirst({
        where: eq(contentFingerprints.sourceUrl, sourceUrl),
      });

      if (urlMatch) {
        logger.info({ sourceUrl }, "[Dedup] URL duplicate found");
        return {
          isOriginal: false,
          duplicateOf: {
            contentId: urlMatch.contentId,
            sourceTitle: urlMatch.sourceTitle,
            sourceUrl: urlMatch.sourceUrl,
            similarity: 1,
          },
          fingerprint: urlMatch.fingerprint,
          processingTimeMs: Date.now() - startTime,
        };
      }
    }

    // Step 2: Content-based duplicate check using LSH
    const dupCheck = await isDuplicate(text, this.similarityThreshold);

    if (dupCheck.isDuplicate && dupCheck.matchedContent) {
      logger.info(
        {
          similarity: Math.round(dupCheck.similarity * 100),
          matchedTitle: dupCheck.matchedContent.sourceTitle?.substring(0, 50),
        },
        "[Dedup] Content duplicate found"
      );

      return {
        isOriginal: false,
        duplicateOf: {
          contentId: dupCheck.matchedContent.contentId,
          sourceTitle: dupCheck.matchedContent.sourceTitle,
          sourceUrl: dupCheck.matchedContent.sourceUrl,
          similarity: dupCheck.similarity,
        },
        relatedContent: dupCheck.relatedContent?.map(r => ({
          contentId: r.contentId,
          sourceTitle: r.sourceTitle,
          similarity: r.similarity,
        })),
        fingerprint: generateFingerprint(text),
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Content is original
    return {
      isOriginal: true,
      relatedContent: dupCheck.relatedContent?.map(r => ({
        contentId: r.contentId,
        sourceTitle: r.sourceTitle,
        similarity: r.similarity,
      })),
      fingerprint: generateFingerprint(text),
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Register new content in the fingerprint database
   *
   * Called after Gate 2 approves content for publication
   */
  async registerContent(
    title: string,
    summary: string,
    contentId: string,
    sourceUrl?: string,
    rssFeedId?: string
  ): Promise<string> {
    const text = `${title} ${summary}`.trim();

    return storeFingerprint(text, contentId, sourceUrl || null, title, rssFeedId);
  }

  /**
   * Find content similar to a given text
   * Useful for "related articles" features
   */
  async findSimilar(
    title: string,
    summary: string,
    limit: number = 5
  ): Promise<SimilarityResult[]> {
    const text = `${title} ${summary}`.trim();
    return findSimilarContent(text, RELATED_THRESHOLD, limit);
  }

  /**
   * Get deduplication statistics
   */
  async getStats(): Promise<{
    totalFingerprints: number;
    uniqueSources: number;
    avgFingerprintsPerDay: number;
    thresholdUsed: number;
    isEnabled: boolean;
  }> {
    const stats = await getDeduplicationStats();
    return {
      ...stats,
      thresholdUsed: this.similarityThreshold,
      isEnabled: this.enabled,
    };
  }

  /**
   * Cleanup old fingerprints (call periodically)
   * Keeps last 90 days of fingerprints
   */
  async cleanup(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await db
      .delete(contentFingerprints)
      .where(
        and(
          lt(contentFingerprints.createdAt, cutoffDate),
          sql`${contentFingerprints.contentId} IS NULL` // Only delete orphaned fingerprints
        )
      )
      .returning();

    logger.info(
      {
        deleted: result.length,
        daysToKeep,
      },
      "[Dedup] Cleanup complete"
    );

    return result.length;
  }

  /**
   * Batch check multiple items for duplicates
   * More efficient than checking one by one
   */
  async batchCheck(
    items: Array<{ title: string; summary: string; sourceUrl?: string }>
  ): Promise<Map<number, DeduplicationResult>> {
    const results = new Map<number, DeduplicationResult>();

    // Process in parallel with concurrency limit
    const BATCH_SIZE = 5;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((item, idx) =>
          this.checkContent(item.title, item.summary, item.sourceUrl).then(result => ({
            index: i + idx,
            result,
          }))
        )
      );

      for (const { index, result } of batchResults) {
        results.set(index, result);
      }
    }

    return results;
  }
}

// Singleton instance
let engineInstance: DeduplicationEngine | null = null;

export function getDeduplicationEngine(options?: {
  similarityThreshold?: number;
  enabled?: boolean;
}): DeduplicationEngine {
  if (!engineInstance || options) {
    engineInstance = new DeduplicationEngine(options);
  }
  return engineInstance;
}
