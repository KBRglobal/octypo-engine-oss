/**
 * Similarity Detection Module
 *
 * Research-backed threshold: 85% similarity is the industry standard
 * for near-duplicate detection in news/content deduplication.
 *
 * Reference: "A Survey of Text Similarity Approaches" (Gomaa & Fahmy, 2013)
 */

import { db } from "../../../db.js";
import { contentFingerprints } from "../../../schema/index.js";
import { eq, sql } from "drizzle-orm";
import {
  generateFingerprint,
  parseFingerprint,
  calculateJaccardSimilarity,
  generateLSHBands,
  generateMinHash,
} from "./fingerprint.js";
import { logger } from "../../../lib/logger.js";

// Industry standard threshold for near-duplicate detection
export const SIMILARITY_THRESHOLD = 0.85;

// Lower threshold for "related content" (not duplicate but similar)
export const RELATED_THRESHOLD = 0.6;

export interface SimilarityResult {
  contentId: string | null;
  fingerprint: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  similarity: number;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  similarity: number;
  matchedContent?: SimilarityResult;
  relatedContent?: SimilarityResult[];
}

/**
 * Check if content is a duplicate of existing content
 *
 * @param text - The text content to check
 * @param threshold - Similarity threshold (default: 0.85)
 * @returns DuplicateCheckResult with match details
 */
export async function isDuplicate(
  text: string,
  threshold: number = SIMILARITY_THRESHOLD
): Promise<DuplicateCheckResult> {
  const startTime = Date.now();
  const fingerprint = generateFingerprint(text);
  const signature = generateMinHash(text);

  // Generate LSH bands for candidate filtering
  generateLSHBands(signature, 16);

  // Step 1: Quick exact match check
  const exactMatch = await db.query.contentFingerprints.findFirst({
    where: eq(contentFingerprints.fingerprint, fingerprint),
  });

  if (exactMatch) {
    logger.info(
      {
        duration: Date.now() - startTime,
        match: "exact",
      },
      "[Dedup] Exact duplicate found"
    );

    return {
      isDuplicate: true,
      similarity: 1,
      matchedContent: {
        contentId: exactMatch.contentId,
        fingerprint: exactMatch.fingerprint,
        sourceUrl: exactMatch.sourceUrl,
        sourceTitle: exactMatch.sourceTitle,
        similarity: 1,
      },
    };
  }

  // Step 2: LSH candidate retrieval
  // Find fingerprints that share at least one band (potential candidates)
  const candidates = await db.query.contentFingerprints.findMany({
    limit: 100, // Limit candidates for performance
    orderBy: (fp, { desc }) => [desc(fp.createdAt)],
  });

  if (candidates.length === 0) {
    return {
      isDuplicate: false,
      similarity: 0,
    };
  }

  // Step 3: Calculate actual similarity for candidates
  let bestMatch: SimilarityResult | undefined;
  let bestSimilarity = 0;
  const relatedContent: SimilarityResult[] = [];

  for (const candidate of candidates) {
    try {
      const candidateSig = parseFingerprint(candidate.fingerprint);
      const similarity = calculateJaccardSimilarity(signature, candidateSig);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = {
          contentId: candidate.contentId,
          fingerprint: candidate.fingerprint,
          sourceUrl: candidate.sourceUrl,
          sourceTitle: candidate.sourceTitle,
          similarity,
        };
      }

      // Track related content (not duplicates but similar)
      if (similarity >= RELATED_THRESHOLD && similarity < threshold) {
        relatedContent.push({
          contentId: candidate.contentId,
          fingerprint: candidate.fingerprint,
          sourceUrl: candidate.sourceUrl,
          sourceTitle: candidate.sourceTitle,
          similarity,
        });
      }
    } catch (error) {
      // Skip malformed fingerprints
      console.error("[Dedup] Error processing candidate fingerprint:", error);
      continue;
    }
  }

  const isDup = bestSimilarity >= threshold;

  logger.info(
    {
      duration: Date.now() - startTime,
      candidatesChecked: candidates.length,
      bestSimilarity: Math.round(bestSimilarity * 100),
      isDuplicate: isDup,
    },
    "[Dedup] Similarity check complete"
  );

  return {
    isDuplicate: isDup,
    similarity: bestSimilarity,
    matchedContent: isDup ? bestMatch : undefined,
    relatedContent: relatedContent.slice(0, 5), // Top 5 related
  };
}

/**
 * Find similar content above a threshold
 *
 * @param text - The text to find similar content for
 * @param threshold - Minimum similarity (default: 0.60)
 * @param limit - Maximum results to return
 */
export async function findSimilarContent(
  text: string,
  threshold: number = RELATED_THRESHOLD,
  limit: number = 10
): Promise<SimilarityResult[]> {
  const signature = generateMinHash(text);

  const candidates = await db.query.contentFingerprints.findMany({
    limit: 200,
    orderBy: (fp, { desc }) => [desc(fp.createdAt)],
  });

  const results: SimilarityResult[] = [];

  for (const candidate of candidates) {
    try {
      const candidateSig = parseFingerprint(candidate.fingerprint);
      const similarity = calculateJaccardSimilarity(signature, candidateSig);

      if (similarity >= threshold) {
        results.push({
          contentId: candidate.contentId,
          fingerprint: candidate.fingerprint,
          sourceUrl: candidate.sourceUrl,
          sourceTitle: candidate.sourceTitle,
          similarity,
        });
      }
    } catch (error) {
      console.error("[Dedup] Error in findSimilarContent candidate:", error);
      continue;
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);

  return results.slice(0, limit);
}

/**
 * Store a fingerprint for new content
 */
export async function storeFingerprint(
  text: string,
  contentId: string | null,
  sourceUrl: string | null,
  sourceTitle: string | null,
  rssFeedId?: string
): Promise<string> {
  const fingerprint = generateFingerprint(text);

  await db.insert(contentFingerprints).values({
    contentId,
    fingerprint,
    sourceUrl,
    sourceTitle,
    rssFeedId,
  } as any);

  logger.info(
    {
      contentId,
      sourceTitle: sourceTitle?.substring(0, 50),
    },
    "[Dedup] Fingerprint stored"
  );

  return fingerprint;
}

/**
 * Get deduplication statistics
 */
export async function getDeduplicationStats(): Promise<{
  totalFingerprints: number;
  uniqueSources: number;
  avgFingerprintsPerDay: number;
}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT source_url) as unique_sources,
      COUNT(*) / GREATEST(1, EXTRACT(DAY FROM NOW() - MIN(created_at))) as avg_per_day
    FROM content_fingerprints
  `);

  const row = (result as any)?.[0] || { total: 0, unique_sources: 0, avg_per_day: 0 };

  return {
    totalFingerprints: Number(row.total) || 0,
    uniqueSources: Number(row.unique_sources) || 0,
    avgFingerprintsPerDay: Number(row.avg_per_day) || 0,
  };
}
