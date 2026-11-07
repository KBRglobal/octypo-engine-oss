import { logger } from "../lib/logger.js";
import { CostMeter, type CostRecord } from "./meter.js";
import { SpendCeiling } from "./ceiling.js";
import { UnknownModelPriceError } from "./prices.js";
import { extractUsage } from "./usage.js";

export { CostMeter, dayKey, DEFAULT_USD_TO_EUR, resolveUsdToEur } from "./meter.js";
export type {
  CostRecord,
  CostSnapshot,
  ArticleBreakdown,
  ModelCallInput,
  ImageInput,
} from "./meter.js";
export {
  SpendCeiling,
  SpendCeilingExceededError,
  DEFAULT_DAILY_CAP_USD,
  WARN_AT_FRACTION,
  resolveDailyCapUsd,
} from "./ceiling.js";
export type { SpendCeilingState } from "./ceiling.js";
export {
  MODEL_PRICES,
  IMAGE_PRICES,
  UnknownModelPriceError,
  priceModelCall,
  priceImageGeneration,
  lookupModelPrice,
} from "./prices.js";
export type { ModelPrice, ImagePrice } from "./prices.js";
export { withArticleCost, currentArticleId } from "./context.js";
import { persistCostRecord } from "./ledger.js";
export { ledgerReport } from "./ledger.js";
export { extractUsage } from "./usage.js";
export type { RawUsage } from "./usage.js";

/**
 * Process-wide meter. In-process and lossy across restarts by design — see the
 * note in meter.ts. One instance so the ceiling caps the whole process.
 */
export const costMeter = new CostMeter({
  onRecord: (record: CostRecord) => {
    logger.debug(
      {
        provider: record.provider,
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        images: record.images,
        costUsd: Number(record.costUsd.toFixed(6)),
        articleId: record.articleId,
        unverifiedPrice: record.unverifiedPrice,
      },
      "[CostMeter] recorded spend"
    );
    // Durable twin of the log line — the per-client invoice lives in the DB.
    persistCostRecord(record);
  },
});

/** Process-wide ceiling, reading the live cap on every check. */
export const spendCeiling = new SpendCeiling({
  meter: costMeter,
  log: (level, msg, data) => logger[level](data ?? {}, msg),
});

/**
 * One read for a dashboard, an admin page or /health: what we have spent today,
 * whether the ceiling has stopped generation, and which articles cost the most.
 * Side-effect free, so polling it is safe.
 */
export function getCostDashboard() {
  const snapshot = costMeter.snapshot();
  const ceiling = spendCeiling.getState();
  return {
    ceiling,
    spend: snapshot,
    /** The number the business case rests on: average EUR per attributed article. */
    avgArticleCostEur:
      snapshot.topArticles.length > 0
        ? snapshot.topArticles.reduce((sum, a) => sum + a.costEur, 0) / snapshot.topArticles.length
        : 0,
  };
}

/**
 * Meter one completed provider call.
 *
 * Called from the engine registry after a response comes back. It never throws:
 * the money is already spent by this point, so failing here would lose the
 * paid-for result as well as the measurement. Instead each failure mode leaves a
 * visible counter in the snapshot and a log at the level it deserves.
 */
export function meterEngineCall(args: {
  provider: string;
  model: string;
  response: unknown;
  engineId?: string;
}): void {
  const usage = extractUsage(args.response);

  if (!usage) {
    costMeter.recordUnmetered({ provider: args.provider, model: args.model });
    logger.warn(
      { provider: args.provider, model: args.model, engineId: args.engineId },
      "[CostMeter] provider returned no usage — call is UNMETERED spend"
    );
    return;
  }

  try {
    costMeter.recordModelCall({
      provider: args.provider,
      model: args.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      engineId: args.engineId,
    });
  } catch (error) {
    if (error instanceof UnknownModelPriceError) {
      costMeter.recordUnpriced({ provider: args.provider, model: args.model });
      logger.error(
        {
          provider: args.provider,
          model: args.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        `[CostMeter] no price for this model — spend is UNMEASURED. ${error.message}`
      );
      return;
    }
    throw error;
  }
}

/**
 * Meter a generated image. Exposed for the image provider
 * (src/lib/image-provider.ts) to call after a successful generation:
 *
 *   meterImageGeneration({ model: "gpt-image-1", size: "1536x1024", quality: "medium" });
 *
 * Same contract as meterEngineCall: never throws, always leaves a trace.
 */
export function meterImageGeneration(args: {
  model: string;
  size: string;
  quality: string;
  count?: number;
  articleId?: string;
}): void {
  try {
    costMeter.recordImage(args);
  } catch (error) {
    costMeter.recordUnpriced({ provider: "openai", model: `${args.model} ${args.size}` });
    logger.error(
      { model: args.model, size: args.size, quality: args.quality },
      `[CostMeter] no price for this image variant — spend is UNMEASURED. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
