/**
 * Quick Facts derivation.
 *
 * After an article is generated, make ONE additional LLM call that — GIVEN the
 * article's assembled body text + title — extracts/derives a structured
 * "Quick Facts" object (Difficulty / Time / Tools / Risk / When-to-do /
 * Best-for) plus an actionable checklist.
 *
 * Rules baked into the prompt: only fill fields the article actually supports;
 * use null / empty arrays when not applicable; never invent specifics not
 * implied by the article; keep tone-neutral. Domain-steered by CONTENT_DOMAIN.
 *
 * This call is NON-FATAL: any failure or junk output returns null so publishing
 * is never blocked. Disable entirely with ENABLE_QUICK_FACTS=false.
 */

import { logger } from "../../lib/logger.js";
import { CONTENT_DOMAIN } from "../../config/domain.js";
import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import type { QuickFacts } from "../../schema/index.js";

/** Cap the article excerpt sent to the model so the prompt stays bounded. */
const MAX_BODY_EXCERPT = 9_000;

const SYSTEM_PROMPT = `You are a precise metadata extractor for ${CONTENT_DOMAIN}.
You read one article and distil a compact, structured "Quick Facts" object that
helps a reader scan the practical essentials at a glance.
You NEVER invent specifics that the article does not imply. You output JSON only —
no prose, no markdown fences.`;

function isDisabled(): boolean {
  const flag = (process.env.ENABLE_QUICK_FACTS || "true").toLowerCase();
  return ["false", "0", "no", "off"].includes(flag);
}

function buildPrompt(title: string, body: string): string {
  const excerpt = body.length > MAX_BODY_EXCERPT ? body.slice(0, MAX_BODY_EXCERPT) : body;
  return `From the ARTICLE below, derive a "Quick Facts" object.

Return JSON ONLY in exactly this shape (omit nothing — use null or [] where it does not apply):
{
  "difficulty": "easy" | "medium" | "hard" | null,
  "timeNeeded": "short human string, e.g. '5–10 minutes', or null",
  "tools": ["concrete tool/item names the article implies", "..."],
  "riskLevel": "low" | "medium" | "high" | null,
  "whenToDo": "short string, e.g. 'Before accepting the keys', or null",
  "bestFor": ["short audience descriptions, e.g. 'Tenants before move-in'", "..."],
  "checklist": ["short actionable step the article supports", "..."]
}

Rules:
- Only fill a field if the ARTICLE actually supports it. Otherwise use null (for scalars) or [] (for arrays).
- A pure news/analysis piece may legitimately have no difficulty, no tools, no checklist — that is fine; return null/[].
- NEVER invent figures, durations, tools, or steps that the article does not clearly imply.
- Keep every string short, neutral, and free of marketing language.
- "tools" and "bestFor" and "checklist" are arrays of short strings (max ~8 items each).

TITLE: ${title}

ARTICLE:
"""
${excerpt}
"""`;
}

/** Robust fenced-JSON parse — strips code fences and isolates the first object. */
function parseQuickFacts(response: string): unknown {
  let jsonStr = response;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
  if (fenced) jsonStr = fenced[1].trim();
  const objectMatch = /\{[\s\S]*\}/.exec(jsonStr);
  if (objectMatch) jsonStr = objectMatch[0];
  return JSON.parse(jsonStr);
}

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const RISKS = new Set(["low", "medium", "high"]);

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map(v => v.trim())
    .filter(v => v.length > 0)
    .slice(0, 8);
}

function cleanScalar(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Coerce raw model output into a validated QuickFacts object.
 * Returns null when the payload is unusable (so the caller stores null).
 */
function normalizeQuickFacts(raw: unknown): QuickFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const difficulty =
    typeof r.difficulty === "string" && DIFFICULTIES.has(r.difficulty.toLowerCase())
      ? (r.difficulty.toLowerCase() as "easy" | "medium" | "hard")
      : null;
  const riskLevel =
    typeof r.riskLevel === "string" && RISKS.has(r.riskLevel.toLowerCase())
      ? (r.riskLevel.toLowerCase() as "low" | "medium" | "high")
      : null;

  const facts: QuickFacts = {
    difficulty,
    timeNeeded: cleanScalar(r.timeNeeded),
    tools: cleanStringArray(r.tools),
    riskLevel,
    whenToDo: cleanScalar(r.whenToDo),
    bestFor: cleanStringArray(r.bestFor),
    checklist: cleanStringArray(r.checklist),
  };

  // If literally everything is empty/null, treat as "no quick facts".
  const hasAny =
    facts.difficulty !== null ||
    facts.riskLevel !== null ||
    facts.timeNeeded !== null ||
    facts.whenToDo !== null ||
    (facts.tools?.length ?? 0) > 0 ||
    (facts.bestFor?.length ?? 0) > 0 ||
    (facts.checklist?.length ?? 0) > 0;

  return hasAny ? facts : null;
}

/** Multi-provider LLM call mirroring the library ideas / gate1 failover pattern. */
async function callLLM(prompt: string): Promise<string> {
  const triedEngines = new Set<string>();
  const errors: string[] = [];
  const totalEngines = EngineRegistry.getEngineCount();
  const MAX_RETRIES = Math.max(totalEngines, 5);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const engine = preferFast(triedEngines);
    if (!engine) break;
    triedEngines.add(engine.id);
    if (!engine.isHealthy) {
      errors.push(`${engine.id}: unhealthy`);
      continue;
    }
    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT, prompt),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Quick facts timeout after 30000ms")), 30000)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return response;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      EngineRegistry.reportError(engine.id, msg);
      errors.push(`${engine.id}(${engine.provider}): ${msg}`);
    }
  }

  throw new Error(
    `All LLM engines failed (${triedEngines.size} tried, ${totalEngines} total). Errors: ${errors.join("; ")}`
  );
}

/**
 * Derive Quick Facts for an article. Always non-fatal: returns null on any
 * failure (disabled, no engines, timeout, junk JSON, empty result).
 *
 * @param title    The article title.
 * @param bodyText The assembled plain-text body (sections/blocks joined).
 */
export async function deriveQuickFacts(
  title: string,
  bodyText: string
): Promise<QuickFacts | null> {
  if (isDisabled()) return null;
  if (!bodyText || bodyText.trim().length < 40) return null;
  if (EngineRegistry.getEngineCount() === 0) return null;

  try {
    const response = await callLLM(buildPrompt(title, bodyText));
    const parsed = parseQuickFacts(response);
    const facts = normalizeQuickFacts(parsed);
    logger.info(
      { title: title.slice(0, 60), hasFacts: facts !== null },
      "[QuickFacts] Derivation complete"
    );
    return facts;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), title: title.slice(0, 60) },
      "[QuickFacts] Derivation failed (non-fatal) — storing null"
    );
    return null;
  }
}

/**
 * Judgement and helper calls run on the cheap tier when one is configured.
 * Writing an article and rating one are different jobs; only the first needs
 * the strong model, and putting it behind the rest is most of the wall clock.
 */
function preferFast(tried: Set<string>) {
  const fast = EngineRegistry.getFastEngine();
  if (fast && !tried.has(fast.id) && fast.isHealthy) return fast;
  return EngineRegistry.getNextFromQueue(tried);
}
