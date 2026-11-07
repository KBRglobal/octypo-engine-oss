/**
 * The fact questionnaire: a strong model's "inventions", captured as questions.
 *
 * When the capable models wrote without enough input, they invented exactly the
 * facts a real business owner actually knows — price bands, night surcharges,
 * seasonality, permits, staffing. That instinct is valuable when it produces
 * *questions* instead of claims. This runs once per cluster at onboarding; the
 * customer's answers become confirmed facts, and the everyday writer never
 * guesses again.
 */

import { CONTENT_LANGUAGE } from "../config/domain.js";
import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";

const TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = `You prepare a fact-collection checklist for a business owner, in ${CONTENT_LANGUAGE}.

Given a topic their site will publish buying-guide articles about, list 12-16 concrete facts only
they can supply. Cover ALL of these decision categories — a buyer-intent SERP is won on decision
data, and articles missing these lose to competitors who state them:
1. MONEY: a price range or starting price, what moves the price, what a quote includes vs extras.
2. HARD SPECS: the 3-5 numbers a buyer compares (sizes, capacity, brightness/power, duration).
3. PROCESS: lead time, minimum order, who operates/delivers, what the customer must provide.
4. CONSTRAINTS: service areas, weather/season limits, permits and who handles them.
5. PROOF: one real named example (client, event, campaign) the owner allows publishing.

Rules:
- Each item is one direct question the owner can answer in a sentence.
- Ask only for facts. Never for opinions, slogans or marketing language.
- No duplicates, no generic questions that fit any business.
- Return ONLY a JSON array of strings. No prose, no numbering, no code fences.`;

export function parseQuestionnaire(raw: string): string[] {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
  } catch {
    return [];
  }
}

export async function generateFactQuestionnaire(topic: string): Promise<string[]> {
  // The strong tier on purpose: this runs once per cluster, and its whole value
  // is the breadth of what it thinks to ask.
  const tried = new Set<string>();

  for (let attempt = 0; attempt < Math.max(EngineRegistry.getEngineCount(), 1); attempt++) {
    const engine = EngineRegistry.getNextFromQueue(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;

    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT, `Topic: ${topic}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("questionnaire timeout")), TIMEOUT_MS)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      const questions = parseQuestionnaire(response);
      if (questions.length > 0) return questions;
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  throw new Error("No engine produced a questionnaire");
}
