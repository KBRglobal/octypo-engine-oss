/**
 * Library idea extraction.
 *
 * Given an uploaded document, ask an LLM to mine 3-8 distinct article IDEAS
 * grounded in the document, and persist them as library_items. Domain-neutral —
 * steered only by CONTENT_DOMAIN at runtime.
 */

import { eq } from "drizzle-orm";

import { db } from "../../db.js";
import { documents, libraryItems } from "../../schema/index.js";
import { logger } from "../../lib/logger.js";
import { CONTENT_DOMAIN } from "../../config/domain.js";
import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import { FIELD_NOTE_MIME } from "../field/telegram.js";

const IDEAS_SYSTEM_PROMPT = `You are a senior commissioning editor for ${CONTENT_DOMAIN}.
You read a single source document and propose distinct, non-overlapping article ideas
that a writer could develop, each firmly grounded in the document's own material.
You never invent facts beyond the document. You output JSON only — no prose, no markdown fences.`;

/** Trim the grounding excerpt sent to the model so prompts stay bounded. */
const MAX_PROMPT_EXCERPT = 12_000;

interface RawIdea {
  title?: unknown;
  angle?: unknown;
  keyPoints?: unknown;
}

function buildPrompt(text: string, range: { min: number; max: number } = { min: 3, max: 8 }): string {
  const excerpt = text.length > MAX_PROMPT_EXCERPT ? text.slice(0, MAX_PROMPT_EXCERPT) : text;
  const count = range.min === range.max ? `exactly ${range.min}` : `between ${range.min} and ${range.max}`;
  return `From the SOURCE DOCUMENT below, propose ${count} distinct article idea${range.max === 1 ? "" : "s"} for ${CONTENT_DOMAIN}.${range.max === 1 ? "\nThis document is a LIVE FIELD NOTE from the business itself (a message and photos sent from the field today). The one idea is a timely report of what happened, where and what it shows about the business, with a concrete newsy headline. Not an evergreen guide." : ""}
Each idea must be developable into an original, source-grounded article — not a copy of the document.

Return JSON ONLY in exactly this shape:
{
  "ideas": [
    {
      "title": "Concise, specific working headline",
      "angle": "One or two sentences describing the distinct thesis/angle for this article",
      "keyPoints": ["grounded point 1", "grounded point 2", "grounded point 3"]
    }
  ]
}

Rules:
- ${count} idea${range.max === 1 ? "" : "s"}${range.max > 1 ? ", each clearly different from the others" : ""}.
- "angle" is the specific thesis the writer will argue or explore.
- "keyPoints" are 3-6 short, concrete points drawn from the document.
- Do not fabricate facts not supported by the document.

SOURCE DOCUMENT:
"""
${excerpt}
"""`;
}

/** Robust JSON parse — strips code fences and isolates the first object. */
function parseIdeas(response: string): RawIdea[] {
  let jsonStr = response;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
  if (fenced) jsonStr = fenced[1].trim();
  const objectMatch = /\{[\s\S]*\}/.exec(jsonStr);
  if (objectMatch) jsonStr = objectMatch[0];

  const parsed = JSON.parse(jsonStr) as { ideas?: unknown };
  const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  return ideas as RawIdea[];
}

function normalizeIdea(raw: RawIdea): { title: string; angle: string; keyPoints: string[] } | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const angle = typeof raw.angle === "string" ? raw.angle.trim() : "";
  const keyPoints = Array.isArray(raw.keyPoints)
    ? raw.keyPoints.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map(p => p.trim())
    : [];
  return { title, angle: angle || title, keyPoints };
}

/** Call the multi-provider LLM, mirroring the gate1-selector failover pattern. */
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
        generateWithEngine(engine, IDEAS_SYSTEM_PROMPT, prompt),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Library ideas timeout after 45000ms")), 45000)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      EngineRegistry.reportError(engine.id, msg);
      errors.push(`${engine.id}(${engine.provider}): ${msg}`);
      logger.warn({ engineId: engine.id, error: msg }, "[Library] Engine failed, trying next");
    }
  }

  throw new Error(
    `All LLM engines failed (${triedEngines.size} tried, ${totalEngines} total). Errors: ${errors.join("; ")}`
  );
}

/**
 * Extract ideas for one document and persist them.
 * Updates the document's status to "ideas_generated" (or "failed").
 */
export async function extractIdeasForDocument(documentId: string): Promise<{
  documentId: string;
  ideaCount: number;
}> {
  const doc = await db.query.documents.findFirst({ where: eq(documents.id, documentId) });
  if (!doc) {
    throw new Error(`Document ${documentId} not found`);
  }
  if (!doc.extractedText || doc.extractedText.trim().length === 0) {
    await markFailed(documentId, "No extracted text to mine ideas from");
    throw new Error("Document has no extracted text");
  }

  logger.info({ documentId, filename: doc.filename }, "[Library] Mining article ideas");

  try {
    const isFieldNote = doc.mimeType === FIELD_NOTE_MIME;
    const response = await callLLM(buildPrompt(doc.extractedText, isFieldNote ? { min: 1, max: 1 } : { min: 3, max: 8 }));
    const raw = parseIdeas(response);
    const ideas = raw
      .map(normalizeIdea)
      .filter((i): i is { title: string; angle: string; keyPoints: string[] } => i !== null)
      .slice(0, isFieldNote ? 1 : 8);

    if (ideas.length === 0) {
      await markFailed(documentId, "Model returned no usable ideas");
      throw new Error("No usable ideas returned");
    }

    await db.insert(libraryItems).values(
      ideas.map(idea => ({
        documentId,
        title: idea.title,
        angle: idea.angle,
        keyPoints: idea.keyPoints,
        status: "idea" as const,
      }))
    );

    await db
      .update(documents)
      .set({ status: "ideas_generated", ideaCount: ideas.length, errorMessage: null, updatedAt: new Date() })
      .where(eq(documents.id, documentId));

    logger.info({ documentId, ideaCount: ideas.length }, "[Library] Ideas generated");
    return { documentId, ideaCount: ideas.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    // markFailed is idempotent-safe; only set if not already failed above
    await markFailed(documentId, msg);
    throw error;
  }
}

async function markFailed(documentId: string, message: string): Promise<void> {
  try {
    await db
      .update(documents)
      .set({ status: "failed", errorMessage: message.substring(0, 1000), updatedAt: new Date() })
      .where(eq(documents.id, documentId));
  } catch {
    // best-effort
  }
}
