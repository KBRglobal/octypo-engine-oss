import { logger } from "../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";
import { bankSummary, type BankSummary } from "./bank-store.js";
import { buildIdeaBank, type BuildBankResult } from "./build-bank.js";
import {
  decideGrowthAction,
  growthConfigFromEnv,
  type GrowthConfig,
  type GrowthDecision,
} from "./growth-strategy.js";
import { discoverGrowthSeeds } from "./site-understanding.js";
import { SITE_URL, CONTENT_DOMAIN } from "../config/domain.js";

export interface GrowthRun {
  at: string;
  decision: GrowthDecision;
  before: BankSummary;
  built: Pick<BuildBankResult, "requested" | "produced" | "inserted" | "skipped"> | null;
}

let timer: NodeJS.Timeout | null = null;
let currentConfig: GrowthConfig = growthConfigFromEnv();
let lastRun: GrowthRun | null = null;
let lastError: string | null = null;

export async function runGrowthCycle(config: GrowthConfig = currentConfig): Promise<GrowthRun> {
  const before = await bankSummary();
  let effectiveConfig = config;
  if (config.enabled && config.seeds.length === 0 && SITE_URL) {
    const profile = await discoverGrowthSeeds({
      siteUrl: SITE_URL,
      domainDescription: CONTENT_DOMAIN,
      language: config.lang,
    });
    if (profile.seeds.length > 0) {
      effectiveConfig = { ...config, seeds: profile.seeds };
      currentConfig = effectiveConfig;
    }
  }
  const decision = decideGrowthAction(before, effectiveConfig);
  let built: GrowthRun["built"] = null;

  if (decision.action === "bootstrap" || decision.action === "replenish") {
    const result = await buildIdeaBank({
      seeds: effectiveConfig.seeds,
      target: decision.target,
      articlesPerMonth: Math.max(1, Math.round(effectiveConfig.articlesPerWeek * 4.33)),
      country: effectiveConfig.country,
      lang: effectiveConfig.lang,
      persist: true,
    });
    built = {
      requested: result.requested,
      produced: result.produced,
      inserted: result.inserted,
      skipped: result.skipped,
    };
  }

  lastRun = { at: new Date().toISOString(), decision, before, built };
  lastError = null;
  logger.info(lastRun, "[Growth] Autonomous planning cycle complete");
  return lastRun;
}

export function startGrowthController(config: GrowthConfig = growthConfigFromEnv()): void {
  currentConfig = config;
  if (timer) clearInterval(timer);
  if (!config.enabled) return;
  const tick = () =>
    withTickLock(TICK_LOCKS.growthPlanner, () => runGrowthCycle(config)).catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      logger.error({ error }, "[Growth] Planning cycle failed");
    });
  timer = setInterval(tick, config.intervalHours * 3_600_000);
  setTimeout(tick, 60_000).unref?.();
}

export function stopGrowthController(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function growthControllerStatus() {
  return { running: timer !== null, config: currentConfig, lastRun, lastError };
}
