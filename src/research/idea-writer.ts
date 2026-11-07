/**
 * Turns one banked idea into an article, through the same writer → Gate 2 →
 * publish path RSS and the document library already use.
 *
 * The bank decides *what* and *in what order*; nothing about how an article is
 * written, checked or published changes because it came from a plan rather than
 * from a feed.
 */

import { eq } from "drizzle-orm";

import { db } from "../db.js";
import { contentIdeas } from "../schema/index.js";
import { jobQueue, JobType } from "../job-queue.js";
import { logger } from "../lib/logger.js";
import { matchTopics } from "../config/topics.js";
import { getOctypoOrchestrator } from "../octypo/orchestration/orchestrator.js";
import { persistGeneratedArticle } from "../octypo/gatekeeper/job-handlers.js";
import type { SubjectData } from "../octypo/types.js";
import { markIdea } from "./bank-store.js";
import { writeCommercialArticle, CommercialWriteError } from "../writer/run-commercial.js";

interface IdeaWriteJobData {
  ideaId: string;
}

/**
 * The brief handed to the writer.
 *
 * A pillar is told it is the anchor of its cluster, because that changes what
 * the article has to do: cover the subject completely enough that the
 * supporting articles have something to link back to.
 */
export function briefFor(idea: {
  targetKeyword: string;
  cluster: string | null;
  isPillar: boolean | null;
}): string {
  const lines = [
    `TARGET SEARCH PHRASE: ${idea.targetKeyword}`,
    `This article exists to answer that phrase directly and completely. State it plainly in the opening and in at least one heading, in natural language — never repeated to hit a quota.`,
  ];
  if (idea.isPillar) {
    lines.push(
      `ROLE: this is the pillar article for the "${idea.cluster}" cluster. Cover the subject broadly enough that narrower articles in the cluster can link back to it as the reference.`
    );
  } else if (idea.cluster) {
    lines.push(
      `ROLE: this is a supporting article in the "${idea.cluster}" cluster. Go deep on this one phrase rather than restating the whole subject.`
    );
  }
  return lines.join("\n\n");
}

export async function writeIdea(ideaId: string): Promise<{ contentId: string } | null> {
  const [idea] = await db
    .select()
    .from(contentIdeas)
    .where(eq(contentIdeas.id, ideaId))
    .limit(1);

  if (!idea) {
    logger.warn({ ideaId }, "[IdeaBank] No such idea");
    return null;
  }

  // The commercial path is the default: one model call under the commercial
  // prompt, a deterministic number audit, straight to the review console.
  // WRITER_MODE=legacy keeps the old multi-agent chain for comparison runs.
  if ((process.env.WRITER_MODE?.trim().toLowerCase() || "commercial") !== "legacy") {
    try {
      const written = await writeCommercialArticle({
        title: idea.title,
        targetKeyword: idea.targetKeyword,
        cluster: idea.cluster,
        isPillar: idea.isPillar,
        targetWords: idea.targetWords,
      });
      await markIdea(idea.id, "written", written.contentId);
      return { contentId: written.contentId };
    } catch (error) {
      if (error instanceof CommercialWriteError) {
        // Not transient: the idea has nothing confirmed to write from. Back to
        // planned so it picks up automatically once facts exist.
        await markIdea(idea.id, "planned");
        logger.warn({ ideaId, error: error.message }, "[IdeaBank] Not writable yet");
        return null;
      }
      await markIdea(idea.id, "planned");
      throw error;
    }
  }

  try {
    const subject: SubjectData = {
      id: Date.now(),
      title: idea.title,
      topicName: idea.cluster || "global",
      primaryCategory: "guide",
      description: briefFor(idea),
      contentType: "long-form",
      preferredWriterId: idea.articleType || "deep-dive-researcher",
    };

    const orchestrator = getOctypoOrchestrator();
    const result = await orchestrator.generateArticleContent(subject);

    if (!result.success || !result.content) {
      // Back to planned, not failed: the phrase is still worth writing, and the
      // next tick should pick it up rather than the bank losing an idea to a
      // transient model error.
      await markIdea(idea.id, "planned");
      throw new Error(`[idea_write] Generation failed after ${result.retryCount} retries`);
    }

    const persisted = await persistGeneratedArticle({
      title: idea.title,
      category: "guide",
      writerId: subject.preferredWriterId!,
      relatedTopicIds: idea.cluster ? [idea.cluster] : matchTopics(idea.title),
      reviewPriority: idea.isPillar ? 1 : 3,
      result,
    });

    await markIdea(idea.id, "written", persisted.contentId);
    logger.info(
      { ideaId: idea.id, contentId: persisted.contentId, keyword: idea.targetKeyword },
      "[IdeaBank] Idea written"
    );
    return { contentId: persisted.contentId };
  } catch (error) {
    logger.error({ ideaId, error }, "[IdeaBank] Write failed");
    throw error;
  }
}

export function registerIdeaJobHandlers(): void {
  jobQueue.registerHandler<IdeaWriteJobData>("idea_write" as JobType, async data => {
    const written = await writeIdea(data.ideaId);
    return { success: written !== null, result: written ?? { error: "Idea not found" } };
  });
  logger.info("[IdeaBank] Job handler registered (idea_write)");
}
