/**
 * Headlines for banked ideas.
 *
 * Planning is deterministic on purpose — which phrases become articles, in what
 * order, of what kind — but a title is writing, and a template shows. A bank of
 * two hundred articles all called "X, explained" reads as machine output before
 * anyone opens one, which is exactly the impression the whole product exists to
 * avoid.
 *
 * So titles come from the model, in one call per cluster rather than one per
 * idea, and the deterministic title stays as the fallback. Nothing here can
 * fail an install: a cluster whose titling call fails keeps its fallback lines.
 */

import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { CONTENT_DOMAIN } from "../config/domain.js";
import { logger } from "../lib/logger.js";
import type { PlannedIdea } from "./idea-bank.js";

const TIMEOUT_MS = 45_000;
/** One call per cluster; a batch much larger than this starts losing fidelity. */
export const TITLE_BATCH_SIZE = 25;

const SYSTEM_PROMPT = `You write headlines for an editorial publication about ${CONTENT_DOMAIN}.

Rules:
- One headline per input phrase, in the same order.
- The headline must contain the phrase or an obvious natural variant of it. It is what the article ranks for.
- Write the way a good editor writes: specific, concrete, no hype, no clickbait, no colons stacking two ideas together unless it genuinely reads better.
- Never use the words "ultimate", "complete guide", "everything you need to know", or "unlock".
- Vary the shape. If several headlines in a batch start the same way, rewrite them.
- Between 40 and 70 characters where the phrase allows it.
- Return ONLY a JSON array of strings. No prose, no numbering, no code fences.`;

export function buildTitlePrompt(ideas: PlannedIdea[]): string {
  const lines = ideas.map((idea, index) => {
    const role = idea.isPillar ? "pillar (broad, the cluster's reference)" : `supporting (${idea.articleType})`;
    return `${index + 1}. phrase: "${idea.targetKeyword}" — ${role}`;
  });
  return `Write one headline for each of these ${ideas.length} phrases.\n\n${lines.join("\n")}`;
}

/**
 * Accept only a well-formed answer of the right length.
 *
 * A short array would silently shift every title onto the wrong idea, which is
 * worse than keeping the fallbacks: the headline would then promise something
 * the article is not about.
 */
export function parseTitles(raw: string, expected: number): string[] | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) return null;

  const titles = parsed.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (titles.some((title) => title.length === 0)) return null;
  return titles;
}

async function callModel(prompt: string): Promise<string> {
  const tried = new Set<string>();
  const attempts = Math.max(EngineRegistry.getEngineCount(), 1);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const engine = preferFast(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;

    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT, prompt),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Title timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return response;
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  throw new Error("No healthy engine produced titles");
}

/**
 * Replace the fallback titles in place, batch by batch. Returns how many were
 * actually rewritten, so a caller can tell a fully-titled bank from one that
 * quietly fell back.
 */
export async function titleIdeas(ideas: PlannedIdea[]): Promise<number> {
  if (ideas.length === 0 || EngineRegistry.getEngineCount() === 0) return 0;

  let rewritten = 0;
  for (let i = 0; i < ideas.length; i += TITLE_BATCH_SIZE) {
    const batch = ideas.slice(i, i + TITLE_BATCH_SIZE);
    try {
      const titles = parseTitles(await callModel(buildTitlePrompt(batch)), batch.length);
      if (!titles) {
        logger.warn({ batch: i / TITLE_BATCH_SIZE }, "[IdeaBank] Unusable titles — keeping fallbacks");
        continue;
      }
      batch.forEach((idea, index) => {
        idea.title = titles[index];
      });
      rewritten += batch.length;
    } catch (error) {
      logger.warn({ error }, "[IdeaBank] Titling failed for a batch — keeping fallbacks");
    }
  }

  logger.info({ rewritten, total: ideas.length }, "[IdeaBank] Titles written");
  return rewritten;
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
