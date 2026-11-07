import type { BankSummary } from "./bank-store.js";

export interface GrowthConfig {
  enabled: boolean;
  seeds: string[];
  articlesPerWeek: number;
  planningWeeks: number;
  reserveWeeks: number;
  country: string;
  lang: string;
  intervalHours: number;
}

export interface GrowthDecision {
  action: "idle" | "bootstrap" | "replenish" | "blocked";
  reason: string;
  target: number;
  reserve: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function parseGrowthSeeds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const values = raw.trim().startsWith("[")
    ? (() => {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })()
    : raw.split(/[\n,]/);
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function growthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GrowthConfig {
  const enabled = !["false", "0", "no", "off"].includes(
    (env.ENABLE_GROWTH_PLANNER ?? "false").toLowerCase()
  );
  return {
    enabled,
    seeds: parseGrowthSeeds(env.GROWTH_SEEDS),
    articlesPerWeek: positiveInteger(env.GROWTH_ARTICLES_PER_WEEK, 2),
    planningWeeks: positiveInteger(env.GROWTH_PLANNING_WEEKS, 26),
    reserveWeeks: positiveInteger(env.GROWTH_RESERVE_WEEKS, 6),
    country: (env.GROWTH_COUNTRY || "US").toUpperCase(),
    lang: (env.GROWTH_LANGUAGE || "en").toLowerCase(),
    intervalHours: positiveInteger(env.GROWTH_CHECK_INTERVAL_HOURS, 24),
  };
}

export function decideGrowthAction(summary: BankSummary, config: GrowthConfig): GrowthDecision {
  const target = config.articlesPerWeek * config.planningWeeks;
  const reserve = config.articlesPerWeek * config.reserveWeeks;
  if (!config.enabled) return { action: "idle", reason: "planner-disabled", target, reserve };
  if (config.seeds.length === 0) {
    return { action: "blocked", reason: "missing-growth-seeds", target, reserve };
  }
  if (summary.total === 0) return { action: "bootstrap", reason: "empty-plan", target, reserve };
  if (summary.planned < reserve) {
    return { action: "replenish", reason: "reserve-below-threshold", target, reserve };
  }
  return { action: "idle", reason: "healthy-reserve", target, reserve };
}
