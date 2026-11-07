/**
 * Stock libraries are indexed in English.
 *
 * Pexels and Pixabay match on English keywords and English descriptions. A
 * query in Arabic, Greek or Japanese returns nothing at every rung of the ladder —
 * which is exactly what happened to the first non-English customer: every
 * article published without an image and the log only said "no relevant match".
 *
 * So a non-Latin query is translated before it is searched. The translation is
 * a visual description, not a dictionary lookup: a query about renting LED screens for events
 * wants photographs of an LED screen at an event, not the phrase "rental".
 */

import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { logger } from "../lib/logger.js";

const TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You turn a topic into a short English stock-photo search query.

Rules:
- Two to four English words, lowercase, no punctuation.
- Describe what should be VISIBLE in the photograph, not the abstract subject.
  "led screen rental for events" → "led screen outdoor event"
  "municipal event planning" → "outdoor stage city event"
- Never output the original language, a brand name, or a word a photographer
  would not tag a photo with.
- Return ONLY the query. No quotes, no explanation.`;

/** True when the text contains no Latin letters at all. */
export function needsTranslation(query: string): boolean {
  return !/[a-z]/i.test(query);
}

/** A cheap guard against sending junk to a stock API. */
export function sanitiseQuery(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .replace(/["'`.,:;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || needsTranslation(cleaned)) return null;
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5);
  return words.length > 0 ? words.join(" ") : null;
}

export type QueryTranslator = (query: string) => Promise<string | null>;

/**
 * Translate through whichever engine is healthy. Returns null on any failure —
 * the caller then searches with the original query and, failing that, publishes
 * without an image. A missing photo is never a reason to lose an article.
 */
export async function translateQuery(query: string): Promise<string | null> {
  if (EngineRegistry.getEngineCount() === 0) return null;

  const tried = new Set<string>();
  for (let attempt = 0; attempt < Math.max(EngineRegistry.getEngineCount(), 1); attempt++) {
    const engine = preferFast(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;

    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT, query),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("query translation timeout")), TIMEOUT_MS)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      const cleaned = sanitiseQuery(response);
      if (cleaned) {
        logger.info({ from: query, to: cleaned }, "[StockImage] Query translated for search");
        return cleaned;
      }
      return null;
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  return null;
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
