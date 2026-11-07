/**
 * LinkProcessor - Post-processor for adding internal links to generated content
 *
 * Runs after Octypo article generation to:
 * 1. Find link opportunities within the content
 * 2. Insert 3-5 internal links per article
 * 3. Save links to database for tracking
 * 4. Respect max link limits per content type
 */

import { db } from "../../db.js";
import { internalLinks, contents } from "../../schema/index.js";
import { eq, sql, and } from "drizzle-orm";
import {
  insertInternalLinks,
  loadLinkableContentFromDB,
  type InternalLink,
} from "../../ai/internal-linking-engine.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("link-processor");

export interface LinkProcessorResult {
  success: boolean;
  linksAdded: number;
  links: InternalLink[];
  processedSections: string[];
  processedContent: {
    introduction?: string;
    whatToExpect?: string;
    visitorTips?: string;
    howToGetThere?: string;
  };
  error?: string;
}

export interface ContentForLinking {
  id: string;
  type: "article" | "guide" | "review";
  topic?: string;
  sections: {
    introduction?: string;
    whatToExpect?: string;
    visitorTips?: string;
    howToGetThere?: string;
  };
}

const SECTION_LINK_LIMITS = {
  introduction: { min: 1, max: 2 },
  whatToExpect: { min: 1, max: 2 },
  visitorTips: { min: 1, max: 1 },
  howToGetThere: { min: 0, max: 1 },
} as const;

const TOTAL_LINK_LIMITS = {
  article: { min: 5, max: 8 },
  guide: { min: 3, max: 5 },
  review: { min: 2, max: 4 },
} as const;

/**
 * Process content and add internal links to each section
 */
export async function processContentLinks(
  content: ContentForLinking
): Promise<LinkProcessorResult> {
  const startTime = Date.now();

  try {
    await loadLinkableContentFromDB();

    const limits = TOTAL_LINK_LIMITS[content.type] || { min: 3, max: 5 };
    let totalLinksAdded = 0;
    const allLinks: InternalLink[] = [];
    const processedSections: string[] = [];
    const processedContent: Record<string, string> = {};

    const sectionsToProcess = [
      "introduction",
      "whatToExpect",
      "visitorTips",
      "howToGetThere",
    ] as const;

    for (const sectionName of sectionsToProcess) {
      const sectionContent = content.sections[sectionName];
      if (!sectionContent || sectionContent.length < 100) continue;

      const sectionLimits = SECTION_LINK_LIMITS[sectionName];
      const remainingLinks = limits.max - totalLinksAdded;

      if (remainingLinks <= 0) break;

      const maxForSection = Math.min(sectionLimits.max, remainingLinks);

      const result = insertInternalLinks(sectionContent, {
        contentType: content.type as any,
        currentTopic: content.topic,
        currentId: content.id,
        minLinks: sectionLimits.min,
        maxLinks: maxForSection,
      });

      processedContent[sectionName] = result.content;
      totalLinksAdded += result.linksAdded;
      allLinks.push(...result.links);
      processedSections.push(sectionName);

      logger.debug(`Section ${sectionName}: Added ${result.linksAdded} links`);
    }

    if (allLinks.length > 0) {
      await saveLinksToDatabase(content.id, allLinks);
    }

    const duration = Date.now() - startTime;
    (logger.info as any)(`LinkProcessor completed for ${content.id}`, {
      linksAdded: totalLinksAdded,
      sections: processedSections.length,
      durationMs: duration,
    });

    return {
      success: true,
      linksAdded: totalLinksAdded,
      links: allLinks,
      processedSections,
      processedContent: processedContent as LinkProcessorResult["processedContent"],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    (logger.error as any)("LinkProcessor failed", { contentId: content.id, error: message });

    return {
      success: false,
      linksAdded: 0,
      links: [],
      processedSections: [],
      processedContent: {},
      error: message,
    };
  }
}

/**
 * Save internal links to database for tracking and analytics
 */
async function saveLinksToDatabase(sourceContentId: string, links: InternalLink[]): Promise<void> {
  try {
    await db
      .delete(internalLinks)
      .where(
        and(
          eq(internalLinks.sourceContentId, sourceContentId),
          eq(internalLinks.isAutoSuggested, true)
        )
      );

    for (const link of links) {
      const targetContent = await db
        .select({ id: contents.id })
        .from(contents)
        .where(eq(contents.slug, link.url.replace(/^\/[^/]+\//, "")))
        .limit(1);

      if (targetContent.length > 0) {
        await db.insert(internalLinks).values({
          sourceContentId,
          targetContentId: targetContent[0].id,
          anchorText: link.anchorText,
          isAutoSuggested: true,
        });
      }
    }

    logger.debug(`Saved ${links.length} links to database for content ${sourceContentId}`);
  } catch (error) {
    (logger.warn as any)("Failed to save links to database", {
      contentId: sourceContentId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Get link statistics for a content piece
 */
export async function getContentLinkStats(contentId: string): Promise<{
  outboundLinks: number;
  inboundLinks: number;
  autoGenerated: number;
  manual: number;
}> {
  try {
    const outbound = await db
      .select({ count: sql<number>`count(*)` })
      .from(internalLinks)
      .where(eq(internalLinks.sourceContentId, contentId));

    const inbound = await db
      .select({ count: sql<number>`count(*)` })
      .from(internalLinks)
      .where(eq(internalLinks.targetContentId, contentId));

    const autoGen = await db
      .select({ count: sql<number>`count(*)` })
      .from(internalLinks)
      .where(
        and(eq(internalLinks.sourceContentId, contentId), eq(internalLinks.isAutoSuggested, true))
      );

    return {
      outboundLinks: Number(outbound[0]?.count || 0),
      inboundLinks: Number(inbound[0]?.count || 0),
      autoGenerated: Number(autoGen[0]?.count || 0),
      manual: Number(outbound[0]?.count || 0) - Number(autoGen[0]?.count || 0),
    };
  } catch (error) {
    (logger.error as any)("Failed to get link stats", { contentId, error });
    return { outboundLinks: 0, inboundLinks: 0, autoGenerated: 0, manual: 0 };
  }
}

/**
 * Batch process multiple content pieces for linking
 */
export async function batchProcessLinks(
  contentIds: string[],
  concurrency: number = 5
): Promise<Map<string, LinkProcessorResult>> {
  const results = new Map<string, LinkProcessorResult>();

  for (let i = 0; i < contentIds.length; i += concurrency) {
    const batch = contentIds.slice(i, i + concurrency);

    const contentRecords = await db
      .select({
        id: contents.id,
        type: contents.type,
        title: contents.title,
        blocks: contents.blocks,
      })
      .from(contents)
      .where(sql`${contents.id} = ANY(${batch})` as any);

    const batchPromises = contentRecords.map(async record => {
      const blocks = (record.blocks as any) || {};

      const contentForLinking: ContentForLinking = {
        id: record.id,
        type: record.type as any,
        sections: {
          introduction: blocks.introduction || blocks.intro,
          whatToExpect: blocks.whatToExpect || blocks.body,
          visitorTips: blocks.visitorTips || blocks.tips,
          howToGetThere: blocks.howToGetThere || blocks.directions,
        },
      };

      const result = await processContentLinks(contentForLinking);
      results.set(record.id, result);
    });

    await Promise.all(batchPromises);
  }

  return results;
}

/**
 * Analyze orphan pages (pages with no inbound links)
 */
export async function findOrphanPages(): Promise<
  {
    id: string;
    title: string;
    type: string;
    slug: string;
  }[]
> {
  try {
    const allContent = await db
      .select({
        id: contents.id,
        title: contents.title,
        type: contents.type,
        slug: contents.slug,
      })
      .from(contents)
      .where(eq(contents.status, "published" as any));

    const orphans: typeof allContent = [];

    for (const content of allContent) {
      const inbound = await db
        .select({ count: sql<number>`count(*)` })
        .from(internalLinks)
        .where(eq(internalLinks.targetContentId, content.id));

      if (Number(inbound[0]?.count || 0) === 0) {
        orphans.push(content);
      }
    }

    return orphans;
  } catch (error) {
    (logger.error as any)("Failed to find orphan pages", { error });
    return [];
  }
}

/**
 * Get overall link health metrics
 */
export async function getLinkHealthMetrics(): Promise<{
  totalLinks: number;
  autoGeneratedLinks: number;
  manualLinks: number;
  averageOutboundPerPage: number;
  orphanPageCount: number;
  pagesWithLinks: number;
  totalPages: number;
}> {
  try {
    const totalLinksResult = await db.select({ count: sql<number>`count(*)` }).from(internalLinks);

    const autoLinksResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(internalLinks)
      .where(eq(internalLinks.isAutoSuggested, true));

    const totalPagesResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(eq(contents.status, "published" as any));

    const pagesWithLinksResult = await db
      .select({ count: sql<number>`count(distinct source_content_id)` })
      .from(internalLinks);

    const orphans = await findOrphanPages();

    const totalLinks = Number(totalLinksResult[0]?.count || 0);
    const autoGeneratedLinks = Number(autoLinksResult[0]?.count || 0);
    const totalPages = Number(totalPagesResult[0]?.count || 0);
    const pagesWithLinks = Number(pagesWithLinksResult[0]?.count || 0);

    return {
      totalLinks,
      autoGeneratedLinks,
      manualLinks: totalLinks - autoGeneratedLinks,
      averageOutboundPerPage: totalPages > 0 ? totalLinks / totalPages : 0,
      orphanPageCount: orphans.length,
      pagesWithLinks,
      totalPages,
    };
  } catch (error) {
    (logger.error as any)("Failed to get link health metrics", { error });
    return {
      totalLinks: 0,
      autoGeneratedLinks: 0,
      manualLinks: 0,
      averageOutboundPerPage: 0,
      orphanPageCount: 0,
      pagesWithLinks: 0,
      totalPages: 0,
    };
  }
}
