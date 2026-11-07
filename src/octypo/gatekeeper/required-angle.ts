/**
 * A news item must concern the client's market before anything is spent on it.
 *
 * NEWS_REQUIRED_ANGLE (for example "Portugal") turns on a cheap yes/no screen
 * that runs before the full Gate 1 evaluation. A sign maker in Portugal has
 * no use for a projection show in England, however well it scores on SEO.
 * Unset, nothing changes. When the screen cannot answer, the item is skipped:
 * a missed story costs nothing, an off-market article costs money and trust.
 */

import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";

const TIMEOUT_MS = 30_000;

export type AngleJudge = (title: string, summary: string, angle: string) => Promise<boolean | null>;

export function requiredAngle(raw = process.env.NEWS_REQUIRED_ANGLE): string {
  return raw?.trim() ?? "";
}

export function parseAngleVerdict(raw: string): boolean | null {
  const text = raw.trim().toLowerCase();
  if (/^\W*(yes|true)\b/.test(text)) return true;
  if (/^\W*(no|false)\b/.test(text)) return false;
  return null;
}

export const modelAngleJudge: AngleJudge = async (title, summary, angle) => {
  if (EngineRegistry.getEngineCount() === 0) return null;
  const system = `You screen news items. Answer only YES or NO.
YES only if the item directly concerns ${angle}: a company, venue, city, authority, client, project, regulation, event or market in ${angle}. A passing mention or a global trend with no ${angle} connection is NO.`;
  const prompt = `Title: ${title}\nSummary: ${summary || "(none)"}`;
  const tried = new Set<string>();
  for (let attempt = 0; attempt < Math.max(EngineRegistry.getEngineCount(), 1); attempt++) {
    const fast = EngineRegistry.getFastEngine();
    const engine = fast && !tried.has(fast.id) && fast.isHealthy ? fast : EngineRegistry.getNextFromQueue(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;
    try {
      const response = await Promise.race([
        generateWithEngine(engine, system, prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Angle timeout")), TIMEOUT_MS)),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      return parseAngleVerdict(response);
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  return null;
};

/** True when the item may proceed to Gate 1. */
export async function passesRequiredAngle(
  title: string,
  summary: string,
  angle: string = requiredAngle(),
  judge: AngleJudge = modelAngleJudge
): Promise<boolean> {
  if (!angle) return true;
  try {
    return (await judge(title, summary, angle)) === true;
  } catch {
    return false;
  }
}
