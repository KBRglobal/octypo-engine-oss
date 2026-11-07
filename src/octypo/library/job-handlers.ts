/**
 * Document Library job handlers.
 *
 * - library_extract_ideas: mine article ideas from an uploaded document.
 * - library_write: turn one mined idea into an article via the SAME
 *   writer → Gate 2 → publish path the RSS pipeline uses.
 */

import { eq } from "drizzle-orm";

import { jobQueue, JobType } from "../../job-queue.js";
import { db } from "../../db.js";
import { documents, libraryItems } from "../../schema/index.js";
import { logger } from "../../lib/logger.js";
import { matchTopics } from "../../config/topics.js";
import { getOctypoOrchestrator } from "../orchestration/orchestrator.js";
import { persistGeneratedArticle } from "../gatekeeper/job-handlers.js";
import { extractIdeasForDocument } from "./ideas.js";
import { VIRAL_SYNTH_MIME } from "./digest.js";
import { FIELD_NOTE_MIME, fieldMediaForDocument } from "../field/telegram.js";
import type { SubjectData } from "../types.js";

/** Generous excerpt of the source document used as grounding material. */
const MAX_GROUNDING_EXCERPT = 14_000;

/**
 * Synthesis (viral) items are grounded in the whole-KB digest, which is far
 * larger and denser than a single document; give them a bigger budget so the
 * roundup listicle has enough material — still bounded for model limits.
 */
const MAX_SYNTHESIS_EXCERPT = 60_000;

interface LibraryExtractIdeasJobData {
  documentId: string;
}

interface LibraryWriteJobData {
  libraryItemId: string;
}

async function handleExtractIdeasJob(
  data: LibraryExtractIdeasJobData
): Promise<{ success: boolean; result: unknown }> {
  logger.info({ documentId: data.documentId }, "[Library] Handling extract-ideas job");
  try {
    // Mark extracting → extracted is already done at upload; here we mine ideas.
    const result = await extractIdeasForDocument(data.documentId);
    return { success: true, result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown";
    logger.error({ documentId: data.documentId, error: msg }, "[Library] Extract-ideas failed");
    // extractIdeasForDocument already marks the document failed.
    // Throw so the job is recorded failed (and retried up to maxRetries).
    throw error;
  }
}

async function handleWriteJob(
  data: LibraryWriteJobData
): Promise<{ success: boolean; result: unknown }> {
  logger.info({ libraryItemId: data.libraryItemId }, "[Library] Handling write job");

  const item = await db.query.libraryItems.findFirst({
    where: eq(libraryItems.id, data.libraryItemId),
  });
  if (!item) {
    return { success: false, result: { error: "Library item not found" } };
  }

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, item.documentId),
  });

  try {
    // Mark as writing.
    await db
      .update(libraryItems)
      .set({ status: "writing", updatedAt: new Date() })
      .where(eq(libraryItems.id, item.id));

    // Synthesis (viral) items are grounded in the whole-KB digest hung on a
    // synthetic collection document; they get a larger excerpt budget and are
    // written in the listicle voice.
    const isSynthesis = doc?.mimeType === VIRAL_SYNTH_MIME;
    const isFieldNote = doc?.mimeType === FIELD_NOTE_MIME;
    // The client's own photos are the article's images: a generated picture
    // of "a screen at a border" next to the real one would be absurd.
    const providedImages = isFieldNote && doc ? await fieldMediaForDocument(doc.id) : [];
    const budget = isSynthesis ? MAX_SYNTHESIS_EXCERPT : MAX_GROUNDING_EXCERPT;

    // Build the grounding description: angle + key points + source excerpt.
    const excerpt = doc?.extractedText ? doc.extractedText.slice(0, budget) : "";
    const keyPoints = (item.keyPoints || []).map(p => `- ${p}`).join("\n");
    const sourceLabel = isSynthesis
      ? "KNOWLEDGE BASE DIGEST TO SYNTHESISE FROM (build the roundup from these grounded topics; never copy verbatim):"
      : isFieldNote
        ? "LIVE FIELD NOTE FROM THE BUSINESS (first-hand, today; write a fresh report of what happened and what it shows, present tense where natural, never an evergreen how-to; every detail below is witnessed fact):"
        : "SOURCE MATERIAL TO REWRITE IN YOUR OWN WORDS (never copy verbatim):";
    const description = [
      `ANGLE / THESIS:\n${item.angle}`,
      keyPoints
        ? `${isSynthesis ? "LIST ITEMS / SUB-POINTS TO COVER" : "KEY POINTS TO DEVELOP"}:\n${keyPoints}`
        : "",
      excerpt ? `${sourceLabel}\n"""\n${excerpt}\n"""` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const subjectData: SubjectData = {
      id: Date.now(),
      title: item.title,
      // Synthesis items use a neutral topic; their tag lives on the item itself.
      topicName: isSynthesis ? "global" : item.suggestedTopicId || "global",
      primaryCategory: isSynthesis ? "listicle" : isFieldNote ? "news" : "guide",
      description,
      contentType: isSynthesis ? "listicle" : isFieldNote ? "news" : "long-form",
      preferredWriterId: isSynthesis ? "listicle-writer" : "deep-dive-researcher",
    };

    const orchestrator = getOctypoOrchestrator();
    const result = await orchestrator.generateArticleContent(subjectData);

    if (!result.success || !result.content) {
      const errorInfo = `Generation failed after ${result.retryCount} retries`;
      await db
        .update(libraryItems)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(libraryItems.id, item.id));
      throw new Error(`[library_write] ${errorInfo}`);
    }

    // Persist + enqueue Gate 2 via the SHARED path; thread libraryItemId so
    // the item is marked published when Gate 2 approves.
    const persisted = await persistGeneratedArticle({
      title: item.title,
      // Category drives the site's content-type chip. Library docs are the DIY
      // repair KB → "diy"; cross-KB synthesis listicles → "tips".
      // (RSS articles are tagged "news" in their own write path.)
      category: isSynthesis ? "tips" : isFieldNote ? "news" : "diy",
      writerId: subjectData.preferredWriterId!,
      // Viral items carry the "viral" tag in suggestedTopicId, not a real topic —
      // derive topics from the title instead.
      relatedTopicIds:
        !isSynthesis && item.suggestedTopicId
          ? [item.suggestedTopicId]
          : matchTopics(item.title),
      reviewPriority: 3,
      result,
      libraryItemId: item.id,
      providedImages,
    });

    // Link the content immediately (status flips to 'published' on Gate 2 approve).
    await db
      .update(libraryItems)
      .set({ contentId: persisted.contentId, updatedAt: new Date() })
      .where(eq(libraryItems.id, item.id));

    return {
      success: true,
      result: { contentId: persisted.contentId, articleId: persisted.articleId },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown";
    logger.error({ libraryItemId: item.id, error: msg }, "[Library] Write job failed");
    // Reset to failed so it isn't stuck in 'writing'.
    try {
      await db
        .update(libraryItems)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(libraryItems.id, item.id));
    } catch {
      // best-effort
    }
    throw error;
  }
}

export function registerLibraryJobHandlers(): void {
  logger.info("[Library] Registering job handlers");

  jobQueue.registerHandler<LibraryExtractIdeasJobData>(
    "library_extract_ideas" as JobType,
    async data => handleExtractIdeasJob(data)
  );

  jobQueue.registerHandler<LibraryWriteJobData>("library_write" as JobType, async data =>
    handleWriteJob(data)
  );

  logger.info("[Library] Job handlers registered (library_extract_ideas, library_write)");
}
