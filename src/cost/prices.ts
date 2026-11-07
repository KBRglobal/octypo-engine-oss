/**
 * PRICE TABLE — the single source of truth for what a model call costs.
 *
 * WHY this file is hand-maintained and heavily commented: a cost meter is only
 * as honest as its prices. A stale or mistyped figure does not fail — it quietly
 * reports a margin that does not exist. So every entry below carries the vendor
 * page it came from and the date it was read, and an unknown model throws
 * instead of costing zero.
 *
 * HOW TO UPDATE
 *   1. Open the `source` URL for the entry.
 *   2. Copy the published per-1M-token figures verbatim (USD, standard tier —
 *      not batch, not cached, not promotional).
 *   3. Update `checkedOn` to the date you read it.
 *   4. If the vendor no longer publishes a price (model retired), keep the entry
 *      but set `unverified: true` and say so in `note` — the meter then flags
 *      that spend separately instead of pretending the number is a quote.
 *   5. `npm test` — src/cost/prices.test.ts asserts hand-computed dollar amounts
 *      and that every model the engine registry can be configured with is priced.
 *
 * All figures below were read on 2026-08-21 from the vendor's own pages.
 */

/** Price of one model, as published by the vendor. USD per 1,000,000 tokens. */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * Flat fee charged per request on top of tokens. Perplexity bills a search
   * fee this way, and for short queries it is the larger half of the bill —
   * metering sonar on tokens alone under-reports by roughly 10x.
   */
  perRequestUsd?: number;
  /** Vendor page the figures were copied from. */
  source: string;
  /** ISO date the figures were last read from `source`. */
  checkedOn: string;
  /**
   * true = the vendor publishes no price for this model any more (it is retired
   * or an alias that moved). The figure is a documented best effort, and the
   * meter counts what it prices this way in `unverifiedCostUsd`.
   */
  unverified?: boolean;
  note?: string;
}

/** Price of one generated image, as published by the vendor. USD per image. */
export interface ImagePrice {
  usdPerImage: number;
  source: string;
  checkedOn: string;
  note?: string;
}

const CHECKED = "2026-08-21";

/**
 * Keyed `provider/model`, both lowercase. Provider is part of the key because
 * the same model id costs different money through different resellers.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ---- Anthropic -------------------------------------------------------
  // Dated snapshots (claude-haiku-4-5-20251001) resolve to the alias below;
  // Anthropic prices the snapshot and the alias identically.
  "anthropic/claude-haiku-4-5": {
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedOn: CHECKED,
    note: "Active. This is the engine registry's default Anthropic model.",
  },
  "anthropic/claude-fable-5": {
    inputUsdPerMTok: 10.0,
    outputUsdPerMTok: 50.0,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedOn: CHECKED,
    note: "Anthropic's most capable model. ~5x Sonnet 5 — the premium editorial tier.",
  },
  "anthropic/claude-sonnet-5": {
    inputUsdPerMTok: 2.0,
    outputUsdPerMTok: 10.0,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedOn: CHECKED,
    note: "Selected with ANTHROPIC_MODEL when a customer is paying for editorial quality.",
  },
  "anthropic/claude-sonnet-4-5": {
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    checkedOn: CHECKED,
    note: "Active but retires no sooner than 2026-09-29. Sonnet 5 is newer AND cheaper ($2/$10).",
  },

  // ---- OpenAI ----------------------------------------------------------
  "openai/gpt-4o": {
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 10.0,
    source: "https://developers.openai.com/api/docs/pricing",
    checkedOn: CHECKED,
    note: "Standard tier. platform.openai.com/docs/pricing now redirects here.",
  },
  "openai/gpt-4o-mini": {
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    source: "https://developers.openai.com/api/docs/pricing",
    checkedOn: CHECKED,
  },

  // ---- OpenRouter ------------------------------------------------------
  // RETIRED MODEL, STILL CONFIGURED. The registry sets OpenRouter's model to
  // `anthropic/claude-3.5-sonnet`, which Anthropic retired 2025-10-28 and which
  // OpenRouter no longer serves (its endpoints list is empty). No price is
  // published anywhere official. Priced at Anthropic's named replacement
  // (Sonnet 4.6, $3/$15) so that spend is not silently counted as zero, and
  // flagged unverified so nobody mistakes it for a quote. The real fix is to
  // change the model in src/services/engine-registry.ts.
  "openrouter/anthropic/claude-3.5-sonnet": {
    inputUsdPerMTok: 3.0,
    outputUsdPerMTok: 15.0,
    source: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    checkedOn: CHECKED,
    unverified: true,
    note: "RETIRED 2025-10-28, no published price. Figure is the replacement (Sonnet 4.6) rate.",
  },

  // ---- Google Gemini ---------------------------------------------------
  // RETIRED MODEL, STILL CONFIGURED. gemini-2.0-flash was shut down 2026-06-01;
  // Google still lists the old price, which is what is recorded here.
  "gemini/gemini-2.0-flash": {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.4,
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    checkedOn: CHECKED,
    unverified: true,
    note: "Shut down 2026-06-01. Price still on the pricing page; audio input is $0.70/MTok.",
  },
  "gemini/gemini-1.5-flash": {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.4,
    source: "https://ai.google.dev/gemini-api/docs/changelog",
    checkedOn: CHECKED,
    unverified: true,
    note: "Shut down 2025-09-29, no price published anywhere. Figure carried over from 2.0-flash.",
  },

  // ---- Groq ------------------------------------------------------------
  // RETIRED MODEL, STILL CONFIGURED. Groq shut llama-3.3-70b-versatile down on
  // 2026-08-16 and removed it from the pricing page. Priced at Groq's named
  // replacement (openai/gpt-oss-120b, $0.15/$0.60) and flagged unverified.
  "groq/llama-3.3-70b-versatile": {
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    source: "https://console.groq.com/docs/deprecations",
    checkedOn: CHECKED,
    unverified: true,
    note: "Shut down 2026-08-16, no published price. Figure is the replacement (gpt-oss-120b) rate.",
  },
  "groq/llama-3.1-70b-versatile": {
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.6,
    source: "https://console.groq.com/docs/deprecations",
    checkedOn: CHECKED,
    unverified: true,
    note: "Shut down 2025-01-24, no published price. Figure is the replacement (gpt-oss-120b) rate.",
  },

  // ---- Mistral ---------------------------------------------------------
  "mistral/mistral-large-latest": {
    inputUsdPerMTok: 0.5,
    outputUsdPerMTok: 1.5,
    source: "https://mistral.ai/pricing/api",
    checkedOn: CHECKED,
    note: "`-latest` now resolves to Mistral Large 3, not the 2411 snapshot — the alias moved.",
  },

  // ---- DeepSeek --------------------------------------------------------
  // DeepSeek charges DOUBLE during two UTC peak windows (01:00-04:00 and
  // 06:00-10:00) and halves everything outside them. The peak (higher) rate is
  // recorded so the ceiling errs towards stopping early rather than late; real
  // spend will be at or below what this reports.
  "deepseek/deepseek-chat": {
    inputUsdPerMTok: 0.44,
    outputUsdPerMTok: 1.32,
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    checkedOn: CHECKED,
    note: "Peak-hour cache-miss rate. Off-peak is exactly half. Alias retired 2026-07-24 and now routes to deepseek-v4-flash, whose rates these are.",
  },

  // ---- Together --------------------------------------------------------
  "together/meta-llama/llama-3.3-70b-instruct-turbo": {
    inputUsdPerMTok: 1.04,
    outputUsdPerMTok: 1.04,
    source: "https://docs.together.ai/docs/serverless-models",
    checkedOn: CHECKED,
    note: "Together bills one blended rate for input and output.",
  },

  // ---- Perplexity ------------------------------------------------------
  "perplexity/sonar": {
    inputUsdPerMTok: 0.25,
    outputUsdPerMTok: 2.5,
    // $8 per 1,000 requests at the default medium search context.
    perRequestUsd: 0.008,
    source: "https://docs.perplexity.ai/getting-started/pricing",
    checkedOn: CHECKED,
    note: "Search fee is per request and dominates short queries: low $5/1k, medium $8/1k, high $12/1k.",
  },
};

/**
 * Image generation, keyed `model/size/quality`.
 *
 * This is the single most expensive line item in an article, so it is metered
 * per image rather than per token. OpenAI publishes the per-image table on the
 * model page (labelled "legacy"), not on the main pricing page.
 */
export const IMAGE_PRICES: Record<string, ImagePrice> = {
  "gpt-image-1/1024x1024/low": {
    usdPerImage: 0.011,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1024x1536/low": {
    usdPerImage: 0.016,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1536x1024/low": {
    usdPerImage: 0.016,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1024x1024/medium": {
    usdPerImage: 0.042,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1024x1536/medium": {
    usdPerImage: 0.063,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  // This is the one the engine actually generates (src/lib/image-provider.ts).
  "gpt-image-1/1536x1024/medium": {
    usdPerImage: 0.063,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
    note: "The hero image size/quality the engine uses today — the priciest single item per article.",
  },
  "gpt-image-1/1024x1024/high": {
    usdPerImage: 0.167,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1024x1536/high": {
    usdPerImage: 0.25,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
  "gpt-image-1/1536x1024/high": {
    usdPerImage: 0.25,
    source: "https://developers.openai.com/api/docs/models/gpt-image-1",
    checkedOn: CHECKED,
  },
};

/** Thrown when something was billed that this table cannot price. */
export class UnknownModelPriceError extends Error {
  readonly provider: string;
  readonly model: string;

  constructor(provider: string, model: string, kind: "model" | "image" = "model") {
    super(
      `No ${kind} price for "${provider}/${model}". Spend cannot be measured. ` +
        `Add it to ${kind === "image" ? "IMAGE_PRICES" : "MODEL_PRICES"} in src/cost/prices.ts ` +
        `with its vendor source URL and today's date.`
    );
    this.name = "UnknownModelPriceError";
    this.provider = provider;
    this.model = model;
  }
}

/**
 * Anthropic ships dated snapshots (`claude-haiku-4-5-20251001`) priced exactly
 * like their alias, so the date suffix is stripped before lookup rather than
 * duplicating every row.
 */
function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/-\d{8}$/, "");
}

function priceKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}/${normalizeModel(model)}`;
}

/** Price lookup that returns null instead of throwing. */
export function lookupModelPrice(provider: string, model: string): ModelPrice | null {
  return MODEL_PRICES[priceKey(provider, model)] ?? null;
}

export interface PricedCall {
  inputCostUsd: number;
  outputCostUsd: number;
  perRequestUsd: number;
  costUsd: number;
  price: ModelPrice;
}

function assertTokenCount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label} token count: ${value}. Token counts must be finite and >= 0.`);
  }
}

/** Cost of one model call, from the provider's own token counts. */
export function priceModelCall(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): PricedCall {
  assertTokenCount(inputTokens, "input");
  assertTokenCount(outputTokens, "output");

  const price = lookupModelPrice(provider, model);
  if (!price) throw new UnknownModelPriceError(provider, model, "model");

  const inputCostUsd = (inputTokens / 1_000_000) * price.inputUsdPerMTok;
  const outputCostUsd = (outputTokens / 1_000_000) * price.outputUsdPerMTok;
  const perRequestUsd = price.perRequestUsd ?? 0;

  return {
    inputCostUsd,
    outputCostUsd,
    perRequestUsd,
    costUsd: inputCostUsd + outputCostUsd + perRequestUsd,
    price,
  };
}

export interface PricedImages {
  costUsd: number;
  price: ImagePrice;
}

/** Cost of generated images, at the vendor's published per-image rate. */
export function priceImageGeneration(
  model: string,
  size: string,
  quality: string,
  count: number
): PricedImages {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid image count: ${count}. Must be a positive integer.`);
  }

  const key = `${model.trim().toLowerCase()}/${size.trim().toLowerCase()}/${quality.trim().toLowerCase()}`;
  const price = IMAGE_PRICES[key];
  if (!price) throw new UnknownModelPriceError("openai", `${model} ${size} ${quality}`, "image");

  return { costUsd: price.usdPerImage * count, price };
}
