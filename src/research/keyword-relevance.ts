/**
 * Keep only the phrases this business can actually write about.
 *
 * Keyword providers expand a seed by co-occurrence, not by meaning: "led screen for
 * business" comes back with "used business equipment", "led wall" with wall lamps, and scraped
 * result pages add navigation junk such as "english uk русский". Volume alone
 * cannot tell those apart, so the fast model judges each batch against the
 * install's content domain. A failed or malformed judgement keeps the batch:
 * relevance filtering must never be the reason an install gets no bank at all.
 */

import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { CONTENT_DOMAIN } from "../config/domain.js";
import { logger } from "../lib/logger.js";
import type { KeywordMetrics } from "./keyword-data.js";

export const RELEVANCE_BATCH_SIZE = 60;
const TIMEOUT_MS = 45_000;

/** Returns one verdict per phrase, in order; null when it could not judge. */
export type RelevanceJudge = (phrases: string[], domain: string) => Promise<boolean[] | null>;

const SYSTEM_PROMPT = (domain: string) => `You screen search phrases for a business that sells and operates: ${domain}.

For each phrase decide: could a person searching it be a realistic customer or reader of THIS business, so that an article on the phrase belongs on its website?

Answer false for: second-hand marketplace listings, unrelated products that merely share a word (lamps, laptops, game consoles, kitchen or restaurant equipment), navigation or language-menu fragments, brand logins, and anything outside the business's field.

Return ONLY a JSON array of true/false values, one per phrase, in the same order. No prose.`;

export function parseVerdicts(raw: string, expected: number): boolean[] | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    if (!parsed.every((v) => typeof v === "boolean")) return null;
    return parsed as boolean[];
  } catch {
    return null;
  }
}

export const modelJudge: RelevanceJudge = async (phrases, domain) => {
  if (EngineRegistry.getEngineCount() === 0) return null;
  const tried = new Set<string>();
  const attempts = Math.max(EngineRegistry.getEngineCount(), 1);
  const prompt = phrases.map((phrase, i) => `${i + 1}. ${phrase}`).join("\n");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const fast = EngineRegistry.getFastEngine();
    const engine = fast && !tried.has(fast.id) && fast.isHealthy ? fast : EngineRegistry.getNextFromQueue(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;
    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT(domain), prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Relevance timeout")), TIMEOUT_MS)),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return parseVerdicts(response, phrases.length);
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  return null;
};

export async function keepRelevant(
  keywords: KeywordMetrics[],
  judge: RelevanceJudge = modelJudge,
  domain: string = CONTENT_DOMAIN
): Promise<KeywordMetrics[]> {
  const kept: KeywordMetrics[] = [];
  let dropped = 0;
  for (let i = 0; i < keywords.length; i += RELEVANCE_BATCH_SIZE) {
    const batch = keywords.slice(i, i + RELEVANCE_BATCH_SIZE);
    let verdicts: boolean[] | null = null;
    try {
      verdicts = await judge(batch.map((k) => k.keyword), domain);
    } catch (error) {
      logger.warn({ error }, "[IdeaBank] Relevance check failed for a batch — keeping it");
    }
    if (!verdicts) {
      kept.push(...batch);
      continue;
    }
    batch.forEach((keyword, index) => {
      if (verdicts![index]) kept.push(keyword);
      else dropped += 1;
    });
  }
  if (dropped > 0) logger.info({ kept: kept.length, dropped }, "[IdeaBank] Off-topic phrases removed");
  return kept;
}
