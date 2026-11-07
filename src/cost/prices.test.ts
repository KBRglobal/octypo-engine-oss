import { describe, it, expect } from "vitest";
import {
  MODEL_PRICES,
  IMAGE_PRICES,
  UnknownModelPriceError,
  priceModelCall,
  priceImageGeneration,
  lookupModelPrice,
} from "./prices.js";

describe("model price table", () => {
  it("prices a call against known token counts (haiku 4.5: $1/MTok in, $5/MTok out)", () => {
    // 1M input + 1M output at the published Anthropic rate must be exactly $6.
    // A single wrong digit in the table changes this number, which is the whole
    // point of asserting a hand-computed figure instead of re-deriving it.
    const cost = priceModelCall("anthropic", "claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(cost.costUsd).toBeCloseTo(6.0, 10);
    expect(cost.inputCostUsd).toBeCloseTo(1.0, 10);
    expect(cost.outputCostUsd).toBeCloseTo(5.0, 10);
  });

  it("scales linearly for a realistic article-sized call", () => {
    // 12,000 in + 3,000 out on haiku 4.5 = 12_000/1e6*1 + 3_000/1e6*5
    //                                    = 0.012 + 0.015 = $0.027
    const cost = priceModelCall("anthropic", "claude-haiku-4-5", 12_000, 3_000);
    expect(cost.costUsd).toBeCloseTo(0.027, 10);
  });

  it("prices gpt-4o against its published rate ($2.50/MTok in, $10/MTok out)", () => {
    const cost = priceModelCall("openai", "gpt-4o", 200_000, 50_000);
    // 0.2 * 2.50 = 0.50 ; 0.05 * 10 = 0.50
    expect(cost.costUsd).toBeCloseTo(1.0, 10);
  });

  it("treats a dated Anthropic snapshot id as its alias (same price)", () => {
    // The registry configures `claude-haiku-4-5-20251001`; Anthropic prices the
    // dated snapshot identically to the alias, so the meter must not blow up on it.
    const dated = priceModelCall("anthropic", "claude-haiku-4-5-20251001", 1_000_000, 0);
    const alias = priceModelCall("anthropic", "claude-haiku-4-5", 1_000_000, 0);
    expect(dated.costUsd).toBe(alias.costUsd);
  });

  it("is case-insensitive about the model id", () => {
    const a = priceModelCall("together", "meta-llama/Llama-3.3-70B-Instruct-Turbo", 1_000_000, 0);
    const b = priceModelCall("together", "meta-llama/llama-3.3-70b-instruct-turbo", 1_000_000, 0);
    expect(a.costUsd).toBe(b.costUsd);
  });

  it("FAILS LOUDLY on an unknown model instead of costing zero", () => {
    // Silently pricing an unknown model at $0 is the failure mode that makes a
    // cost meter a lie. It must throw, and the message must say how to fix it.
    expect(() => priceModelCall("openai", "gpt-9-turbo-imaginary", 1000, 1000)).toThrow(
      UnknownModelPriceError
    );
    expect(() => priceModelCall("openai", "gpt-9-turbo-imaginary", 1000, 1000)).toThrow(
      /src\/cost\/prices\.ts/
    );
  });

  it("fails loudly on a model that exists under a different provider", () => {
    // gpt-4o is real, but not on anthropic — the pair is what gets billed.
    expect(() => priceModelCall("anthropic", "gpt-4o", 10, 10)).toThrow(UnknownModelPriceError);
  });

  it("rejects negative or non-finite token counts rather than crediting spend", () => {
    expect(() => priceModelCall("anthropic", "claude-haiku-4-5", -5, 0)).toThrow(/token/i);
    expect(() => priceModelCall("anthropic", "claude-haiku-4-5", Number.NaN, 0)).toThrow(/token/i);
  });

  it("lookupModelPrice returns null instead of throwing, for callers that want to probe", () => {
    expect(lookupModelPrice("openai", "gpt-9-turbo-imaginary")).toBeNull();
    expect(lookupModelPrice("openai", "gpt-4o")).not.toBeNull();
  });

  it("covers every model the engine registry can be configured with", () => {
    // These are the exact provider/model pairs hard-coded in
    // src/services/engine-registry.ts. If someone adds an engine there without
    // adding a price here, this test tells them before production does.
    const configured: Array<[string, string]> = [
      ["anthropic", "claude-haiku-4-5-20251001"],
      ["openai", "gpt-4o"],
      ["openrouter", "anthropic/claude-3.5-sonnet"],
      ["gemini", "gemini-2.0-flash"],
      ["groq", "llama-3.3-70b-versatile"],
      ["mistral", "mistral-large-latest"],
      ["deepseek", "deepseek-chat"],
      ["together", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
      ["perplexity", "sonar"],
    ];
    for (const [provider, model] of configured) {
      expect(lookupModelPrice(provider, model), `${provider}/${model} has no price`).not.toBeNull();
    }
  });

  it("documents a source and a check date for every price", () => {
    // A price with no provenance cannot be audited or refreshed.
    for (const [key, price] of Object.entries(MODEL_PRICES)) {
      expect(price.source, `${key} has no source`).toMatch(/^https?:\/\//);
      expect(price.checkedOn, `${key} has no check date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const [key, price] of Object.entries(IMAGE_PRICES)) {
      expect(price.source, `${key} has no source`).toMatch(/^https?:\/\//);
      expect(price.checkedOn, `${key} has no check date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("image price table", () => {
  it("prices the hero image the engine actually generates at its published rate", () => {
    // gpt-image-1, 1536x1024, quality "medium" = $0.063 per image.
    const one = priceImageGeneration("gpt-image-1", "1536x1024", "medium", 1);
    expect(one.costUsd).toBeCloseTo(0.063, 10);
    const three = priceImageGeneration("gpt-image-1", "1536x1024", "medium", 3);
    expect(three.costUsd).toBeCloseTo(0.189, 10);
  });

  it("fails loudly on an unknown size/quality combination", () => {
    expect(() => priceImageGeneration("gpt-image-1", "4096x4096", "medium", 1)).toThrow(
      UnknownModelPriceError
    );
    expect(() => priceImageGeneration("dall-e-9", "1536x1024", "medium", 1)).toThrow(
      UnknownModelPriceError
    );
  });

  it("rejects a nonsensical image count", () => {
    expect(() => priceImageGeneration("gpt-image-1", "1536x1024", "medium", 0)).toThrow(/count/i);
    expect(() => priceImageGeneration("gpt-image-1", "1536x1024", "medium", -1)).toThrow(/count/i);
  });
});
