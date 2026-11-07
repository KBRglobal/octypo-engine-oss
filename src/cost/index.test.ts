import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  costMeter,
  spendCeiling,
  meterEngineCall,
  meterImageGeneration,
  getCostDashboard,
  withArticleCost,
} from "./index.js";

const CAP_ENV = "OCTYPO_DAILY_COST_CAP_USD";
const originalCap = process.env[CAP_ENV];

beforeEach(() => {
  process.env[CAP_ENV] = "10";
  costMeter.reset();
  spendCeiling.reset();
});

afterAll(() => {
  if (originalCap === undefined) delete process.env[CAP_ENV];
  else process.env[CAP_ENV] = originalCap;
});

describe("meterEngineCall", () => {
  it("meters a provider response and never throws", () => {
    withArticleCost("art-1", () => {
      meterEngineCall({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        response: { usage: { input_tokens: 12_000, output_tokens: 3_000 } },
      });
    });
    expect(costMeter.articleCostUsd("art-1")).toBeCloseTo(0.027, 10);
  });

  it("does not throw on an unknown model — it counts it instead", () => {
    expect(() =>
      meterEngineCall({
        provider: "anthropic",
        model: "claude-not-a-real-model",
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      })
    ).not.toThrow();
    expect(costMeter.snapshot().unpricedCalls).toBe(1);
  });

  it("does not throw on a response with no usage — it counts it as unmetered", () => {
    expect(() =>
      meterEngineCall({ provider: "groq", model: "llama-3.3-70b-versatile", response: {} })
    ).not.toThrow();
    expect(costMeter.snapshot().unmeteredCalls).toBe(1);
  });
});

describe("meterImageGeneration", () => {
  it("meters the hero image the engine generates", () => {
    meterImageGeneration({
      model: "gpt-image-1",
      size: "1536x1024",
      quality: "medium",
      articleId: "art-img",
    });
    expect(costMeter.articleCostUsd("art-img")).toBeCloseTo(0.063, 10);
  });

  it("does not throw on an unknown variant", () => {
    expect(() =>
      meterImageGeneration({ model: "gpt-image-1", size: "9x9", quality: "medium" })
    ).not.toThrow();
    expect(costMeter.snapshot().unpricedCalls).toBe(1);
  });
});

describe("getCostDashboard", () => {
  it("reports spend, the ceiling state and the per-article figure in EUR", () => {
    withArticleCost("art-x", () => {
      meterEngineCall({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        response: { usage: { input_tokens: 100_000, output_tokens: 20_000 } },
      });
      meterImageGeneration({ model: "gpt-image-1", size: "1536x1024", quality: "medium" });
    });

    const dash = getCostDashboard();
    // 0.1 * $1 + 0.02 * $5 = $0.20, plus $0.063 image = $0.263
    expect(dash.spend.spentTodayUsd).toBeCloseTo(0.263, 10);
    expect(dash.ceiling.tripped).toBe(false);
    expect(dash.ceiling.capUsd).toBe(10);
    expect(dash.avgArticleCostEur).toBeGreaterThan(0);
    expect(dash.spend.topArticles[0].articleId).toBe("art-x");
  });
});
