/**
 * Viral / cross-document synthesis ideas.
 *
 * Where `extractIdeasForDocument` mines ideas from ONE source document, this
 * module synthesises highly-shareable LISTICLE / ROUNDUP ideas ACROSS the whole
 * knowledge base. It:
 *   1. Builds a whole-KB markdown digest (digest.ts).
 *   2. Asks the LLM (same multi-provider engine pattern) for clickable but
 *      honest roundup ideas, each answerable from the digest.
 *   3. Hangs them on a single synthetic "collection" document whose extractedText
 *      IS the current digest — so the existing `library_write` handler grounds
 *      each viral item in the whole-KB digest automatically.
 *
 * Domain-neutral — steered only by CONTENT_DOMAIN.
 */

import { and, desc, eq } from "drizzle-orm";

import { db } from "../../db.js";
import { documents, libraryItems, type LibraryItem } from "../../schema/index.js";
import { logger } from "../../lib/logger.js";
import { CONTENT_DOMAIN } from "../../config/domain.js";
import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import {
  buildKnowledgeDigest,
  VIRAL_SYNTH_FILENAME,
  VIRAL_SYNTH_MIME,
} from "./digest.js";

/** Marker stored on viral items so the writer routes them to the listicle persona. */
export const VIRAL_TOPIC_MARKER = "viral";

const VIRAL_SYSTEM_PROMPT = `You are a seasoned audience-development editor for ${CONTENT_DOMAIN}.
You design highly shareable roundup / listicle articles that synthesise across an
entire knowledge base. Your headlines are clicky and specific but never dishonest
clickbait, never fear-mongering, never over-claiming — the brand voice is calm,
premium and genuinely helpful. You only propose ideas that are fully answerable
from the supplied knowledge-base digest. You output JSON only — no prose, no fences.`;

interface RawViralIdea {
  title?: unknown;
  angle?: unknown;
  keyPoints?: unknown;
  suggestedTopicId?: unknown;
}

interface NormalizedViralIdea {
  title: string;
  angle: string;
  keyPoints: string[];
}

function buildViralPrompt(count: number, digest: string, briefHint?: string): string {
  const brief = briefHint?.trim()
    ? `\nEDITORIAL BRIEF (steer the ideas toward this, but stay grounded in the digest):\n${briefHint.trim()}\n`
    : "";

  return `Propose exactly ${count} highly clickable, shareable LISTICLE / ROUNDUP article ideas for ${CONTENT_DOMAIN}.
Each idea SYNTHESISES across the KNOWLEDGE BASE DIGEST below — it is a roundup of many items, not a single topic.
${brief}
Return JSON ONLY in exactly this shape:
{
  "ideas": [
    {
      "title": "Clicky but honest listicle headline, e.g. \\"10 Things ...\\", \\"7 ... Mistakes\\", \\"The ...-Item Checklist ...\\"",
      "angle": "One or two sentences: the hook — why this spreads and who it helps",
      "keyPoints": ["list item / sub-point 1", "list item 2", "... 6 to 15 of them"],
      "suggestedTopicId": "optional topic slug or null"
    }
  ]
}

Rules:
- Exactly ${count} ideas, each clearly distinct.
- "title": numbered or checklist-style listicle headline. Clicky and specific, but NEVER dishonest clickbait, NEVER fear-mongering, NEVER over-claiming.
- "angle": the shareable hook — the reason a reader forwards it.
- "keyPoints": 6 to 15 concrete list items the article will cover, each drawn from the digest.
- Every idea MUST be answerable from the digest below. Do not fabricate facts or topics the digest does not cover.
- Keep a calm, premium, genuinely-helpful tone.

KNOWLEDGE BASE DIGEST:
"""
${digest}
"""`;
}

/** Robust JSON parse — strips code fences and isolates the first object. */
function parseViralIdeas(response: string): RawViralIdea[] {
  let jsonStr = response;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
  if (fenced) jsonStr = fenced[1].trim();
  const objectMatch = /\{[\s\S]*\}/.exec(jsonStr);
  if (objectMatch) jsonStr = objectMatch[0];

  const parsed = JSON.parse(jsonStr) as { ideas?: unknown };
  const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  return ideas as RawViralIdea[];
}

function normalizeViralIdea(raw: RawViralIdea): NormalizedViralIdea | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const angle = typeof raw.angle === "string" ? raw.angle.trim() : "";
  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map(p => p.trim())
    : [];
  return { title, angle: angle || title, keyPoints };
}

/** Call the multi-provider LLM, mirroring extractIdeasForDocument's failover. */
async function callLLM(prompt: string): Promise<string> {
  const triedEngines = new Set<string>();
  const errors: string[] = [];
  const totalEngines = EngineRegistry.getEngineCount();
  const MAX_RETRIES = Math.max(totalEngines, 5);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const engine = EngineRegistry.getNextFromQueue(triedEngines);
    if (!engine) break;
    triedEngines.add(engine.id);
    if (!engine.isHealthy) {
      errors.push(`${engine.id}: unhealthy`);
      continue;
    }
    try {
      const response = await Promise.race([
        generateWithEngine(engine, VIRAL_SYSTEM_PROMPT, prompt),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Viral ideas timeout after 60000ms")), 60000)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      EngineRegistry.reportError(engine.id, msg);
      errors.push(`${engine.id}(${engine.provider}): ${msg}`);
      logger.warn({ engineId: engine.id, error: msg }, "[Viral] Engine failed, trying next");
    }
  }

  throw new Error(
    `All LLM engines failed (${triedEngines.size} tried, ${totalEngines} total). Errors: ${errors.join("; ")}`
  );
}

/**
 * Create-or-get the synthetic synthesis document and refresh its extractedText
 * to the CURRENT digest, so `library_write` grounds viral items in the whole KB.
 */
async function upsertSynthesisDocument(digest: string): Promise<string> {
  const existing = await db.query.documents.findFirst({
    where: and(
      eq(documents.filename, VIRAL_SYNTH_FILENAME),
      eq(documents.mimeType, VIRAL_SYNTH_MIME)
    ),
  });

  if (existing) {
    await db
      .update(documents)
      .set({ extractedText: digest, status: "ideas_generated", updatedAt: new Date() })
      .where(eq(documents.id, existing.id));
    return existing.id;
  }

  const [created] = await db
    .insert(documents)
    .values({
      filename: VIRAL_SYNTH_FILENAME,
      mimeType: VIRAL_SYNTH_MIME,
      sizeBytes: Buffer.byteLength(digest, "utf8"),
      extractedText: digest,
      status: "ideas_generated",
    })
    .returning();
  return created.id;
}

/** True when this library item belongs to the viral-synthesis collection. */
export function isViralItem(item: { suggestedTopicId: string | null }): boolean {
  return item.suggestedTopicId === VIRAL_TOPIC_MARKER;
}

/**
 * Generate `count` viral synthesis ideas grounded in the whole knowledge base.
 * Persists them as library items under the synthetic synthesis document.
 */
export async function generateViralIdeas(
  count: number,
  briefHint?: string
): Promise<{ documentId: string; items: LibraryItem[] }> {
  const requested = Math.max(1, Math.min(Math.round(count) || 10, 30));

  const digest = await buildKnowledgeDigest();
  if (!digest || digest.trim().length === 0) {
    throw new Error(
      "Knowledge base is empty — upload documents and mine ideas before brainstorming viral roundups"
    );
  }

  // Ensure the synthetic doc exists / is refreshed BEFORE the LLM call so the
  // collection is always created even if the LLM fails (graceful, no crash).
  const documentId = await upsertSynthesisDocument(digest);

  logger.info({ documentId, requested }, "[Viral] Brainstorming cross-document ideas");

  const response = await callLLM(buildViralPrompt(requested, digest, briefHint));
  const raw = parseViralIdeas(response);
  const ideas = raw
    .map(normalizeViralIdea)
    .filter((i): i is NormalizedViralIdea => i !== null)
    .slice(0, requested);

  if (ideas.length === 0) {
    throw new Error("Model returned no usable viral ideas");
  }

  await db.insert(libraryItems).values(
    ideas.map(idea => ({
      documentId,
      title: idea.title,
      angle: idea.angle,
      keyPoints: idea.keyPoints,
      // Tag as viral; this also routes the writer to the listicle persona.
      suggestedTopicId: VIRAL_TOPIC_MARKER,
      status: "idea" as const,
    }))
  );

  const items = await db
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.documentId, documentId))
    .orderBy(desc(libraryItems.createdAt))
    .limit(ideas.length);

  logger.info({ documentId, ideaCount: ideas.length }, "[Viral] Ideas generated");
  return { documentId, items };
}
