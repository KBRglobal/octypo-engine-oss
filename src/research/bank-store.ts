/**
 * Persistence for the idea bank.
 *
 * Kept apart from planning so the plan stays a pure function of the evidence:
 * planning decides *what* should be written, this decides what the database
 * already knows.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db.js";
import { contentIdeas, type ContentIdea, type ContentIdeaStatus } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import type { PlannedIdea } from "./idea-bank.js";

export interface StoreResult {
  inserted: number;
  skipped: number;
}

/** Every phrase the bank already holds, in whatever state. */
export async function existingDedupeKeys(): Promise<Set<string>> {
  const rows = await db.select({ key: contentIdeas.dedupeKey }).from(contentIdeas);
  return new Set(rows.map((row) => row.key));
}

/**
 * Insert a plan.
 *
 * The unique index on the dedupe key does the real work: a rebuild months later
 * tops the bank up rather than doubling it, even if the planner and the
 * database disagree about what is already there.
 */
export async function storeIdeas(planned: PlannedIdea[]): Promise<StoreResult> {
  if (planned.length === 0) return { inserted: 0, skipped: 0 };

  const rows = planned.map((idea) => ({
    title: idea.title,
    targetKeyword: idea.targetKeyword,
    dedupeKey: idea.dedupeKey,
    cluster: idea.cluster,
    articleType: idea.articleType,
    isPillar: idea.isPillar,
    searchVolume: idea.searchVolume,
    priority: idea.priority,
    evidence: idea.evidence,
  }));

  const inserted = await db
    .insert(contentIdeas)
    .values(rows)
    .onConflictDoNothing({ target: contentIdeas.dedupeKey })
    .returning({ id: contentIdeas.id });

  const result = { inserted: inserted.length, skipped: rows.length - inserted.length };
  logger.info(result, "[IdeaBank] Plan stored");
  return result;
}

/** The next ideas to write: pillars first, then by priority. */
export async function nextPlannedIdeas(limit: number): Promise<ContentIdea[]> {
  if (limit <= 0) return [];
  return db
    .select()
    .from(contentIdeas)
    .where(eq(contentIdeas.status, "planned"))
    .orderBy(
      desc(contentIdeas.isPillar),
      desc(contentIdeas.priority),
      asc(contentIdeas.createdAt)
    )
    .limit(limit);
}

/**
 * Claim ideas for writing.
 *
 * Conditional on the rows still being `planned`, so two scheduler ticks — or
 * two replicas — cannot hand the same idea to two writers.
 */
export async function claimIdeas(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const claimed = await db
    .update(contentIdeas)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(inArray(contentIdeas.id, ids), eq(contentIdeas.status, "planned")))
    .returning({ id: contentIdeas.id });
  return claimed.map((row) => row.id);
}

/**
 * Move an idea to `status`. `evidence` is merged into the row's evidence —
 * how a skip records why (e.g. the host page that already owns the topic).
 */
export async function markIdea(
  id: string,
  status: ContentIdeaStatus,
  contentId?: string,
  evidence?: Record<string, unknown>
): Promise<void> {
  await db
    .update(contentIdeas)
    .set({
      status,
      updatedAt: new Date(),
      ...(contentId ? { contentId } : {}),
      ...(evidence
        ? { evidence: sql`coalesce(${contentIdeas.evidence}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb` }
        : {}),
    })
    .where(eq(contentIdeas.id, id));
}

export interface BankSummary {
  planned: number;
  queued: number;
  written: number;
  skipped: number;
  total: number;
}

export async function bankSummary(): Promise<BankSummary> {
  const rows = await db
    .select({ status: contentIdeas.status, count: sql<number>`count(*)::int` })
    .from(contentIdeas)
    .groupBy(contentIdeas.status);

  const summary: BankSummary = { planned: 0, queued: 0, written: 0, skipped: 0, total: 0 };
  for (const row of rows) {
    if (row.status in summary) summary[row.status as keyof BankSummary] = row.count;
    summary.total += row.count;
  }
  return summary;
}
