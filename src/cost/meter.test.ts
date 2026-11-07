import { describe, it, expect, beforeEach, vi } from "vitest";
import { CostMeter } from "./meter.js";
import { UnknownModelPriceError } from "./prices.js";
import { withArticleCost, currentArticleId } from "./context.js";

/** A meter with a clock we control, so day-rollover is testable without waiting. */
function meterAt(startMs: number): { meter: CostMeter; setNow: (ms: number) => void } {
  let now = startMs;
  const meter = new CostMeter({ now: () => now });
  return { meter, setNow: (ms: number) => (now = ms) };
}

const DAY1 = Date.parse("2026-08-21T10:00:00Z");
const DAY1_LATE = Date.parse("2026-08-21T23:59:00Z");
const DAY2 = Date.parse("2026-08-22T00:01:00Z");

describe("CostMeter", () => {
  let meter: CostMeter;
  let setNow: (ms: number) => void;

  beforeEach(() => {
    ({ meter, setNow } = meterAt(DAY1));
  });

  it("records a model call with the real token counts and the computed cost", () => {
    const rec = meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 12_000,
      outputTokens: 3_000,
    });

    expect(rec.inputTokens).toBe(12_000);
    expect(rec.outputTokens).toBe(3_000);
    expect(rec.costUsd).toBeCloseTo(0.027, 10);
    expect(meter.spentTodayUsd()).toBeCloseTo(0.027, 10);
  });

  it("sums many calls into the daily total", () => {
    for (let i = 0; i < 10; i++) {
      meter.recordModelCall({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
    }
    expect(meter.spentTodayUsd()).toBeCloseTo(10.0, 8);
  });

  it("meters image generation, the most expensive item per article", () => {
    const rec = meter.recordImage({
      model: "gpt-image-1",
      size: "1536x1024",
      quality: "medium",
      count: 1,
      articleId: "art-1",
    });
    expect(rec.costUsd).toBeCloseTo(0.063, 10);
    expect(meter.articleCostUsd("art-1")).toBeCloseTo(0.063, 10);
  });

  it("attributes cost to an article so 'what did this customer cost us' is answerable", () => {
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 20_000,
      outputTokens: 6_000,
      articleId: "art-a",
    });
    meter.recordImage({
      model: "gpt-image-1",
      size: "1536x1024",
      quality: "medium",
      count: 1,
      articleId: "art-a",
    });
    meter.recordModelCall({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 1_000,
      outputTokens: 500,
      articleId: "art-b",
    });

    // 20_000/1e6*1 + 6_000/1e6*5 = 0.02 + 0.03 = 0.05, plus the $0.063 image.
    expect(meter.articleCostUsd("art-a")).toBeCloseTo(0.113, 10);
    expect(meter.articleCostUsd("art-b")).toBeGreaterThan(0);
    expect(meter.articleCostUsd("art-a")).not.toBeCloseTo(meter.articleCostUsd("art-b"), 6);

    const breakdown = meter.articleBreakdown("art-a");
    // `calls` counts model calls; images are counted separately.
    expect(breakdown.calls).toBe(1);
    expect(breakdown.images).toBe(1);
    expect(breakdown.costUsd).toBeCloseTo(0.113, 10);
    expect(breakdown.costEur).toBeGreaterThan(0);
  });

  it("picks up the article id from the async context when the caller cannot pass it", () => {
    // The engine registry is several layers below the orchestrator and has no
    // article id in its signature; the context carries it instead of forcing a
    // signature change through every call site.
    expect(currentArticleId()).toBeUndefined();
    withArticleCost("art-ctx", () => {
      meter.recordModelCall({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
    });
    expect(meter.articleCostUsd("art-ctx")).toBeCloseTo(1.0, 8);
    expect(currentArticleId()).toBeUndefined();
  });

  it("keeps article attribution across awaits inside the context", async () => {
    await withArticleCost("art-async", async () => {
      await Promise.resolve();
      expect(currentArticleId()).toBe("art-async");
      meter.recordModelCall({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
    });
    expect(meter.articleCostUsd("art-async")).toBeCloseTo(1.0, 8);
  });

  it("rolls over at UTC midnight — a new day starts from zero, history is kept", () => {
    setNow(DAY1_LATE);
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(meter.spentTodayUsd()).toBeCloseTo(1.0, 8);

    setNow(DAY2);
    expect(meter.spentTodayUsd()).toBe(0);
    expect(meter.spentOnDayUsd("2026-08-21")).toBeCloseTo(1.0, 8);
  });

  it("sums a month for billing questions", () => {
    setNow(Date.parse("2026-08-02T09:00:00Z"));
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      articleId: "art-m",
    });
    setNow(Date.parse("2026-08-17T09:00:00Z"));
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      articleId: "art-m",
    });
    expect(meter.spentInMonthUsd("2026-08")).toBeCloseTo(2.0, 8);
    expect(meter.spentInMonthUsd("2026-07")).toBe(0);
  });

  it("propagates the unknown-model failure instead of recording a free call", () => {
    expect(() =>
      meter.recordModelCall({
        provider: "openai",
        model: "gpt-9-turbo-imaginary",
        inputTokens: 100,
        outputTokens: 100,
      })
    ).toThrow(UnknownModelPriceError);
    expect(meter.spentTodayUsd()).toBe(0);
  });

  it("counts unpriced calls in the snapshot so an unknown model cannot hide", () => {
    meter.recordUnpriced({ provider: "openai", model: "gpt-9-turbo-imaginary", reason: "no price" });
    const snap = meter.snapshot();
    expect(snap.unpricedCalls).toBe(1);
    expect(snap.unpricedModels).toContain("openai/gpt-9-turbo-imaginary");
  });

  it("counts calls that came back with no usage numbers as unmetered, not as free", () => {
    // A provider that omits usage means we spent money we cannot measure. That
    // is a data-quality alarm, not a zero.
    meter.recordUnmetered({ provider: "groq", model: "llama-3.3-70b-versatile" });
    const snap = meter.snapshot();
    expect(snap.unmeteredCalls).toBe(1);
    expect(snap.spentTodayUsd).toBe(0);
  });

  it("breaks spend down by provider and by model for the dashboard", () => {
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    meter.recordModelCall({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const snap = meter.snapshot();
    expect(snap.byProvider["anthropic"]).toBeCloseTo(1.0, 8);
    expect(snap.byProvider["openai"]).toBeCloseTo(2.5, 8);
    expect(snap.byModel["openai/gpt-4o"]).toBeCloseTo(2.5, 8);
    expect(snap.spentTodayUsd).toBeCloseTo(3.5, 8);
    expect(snap.calls).toBe(2);
  });

  it("reports EUR alongside USD, because the margin is quoted in EUR", () => {
    meter.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const snap = meter.snapshot();
    expect(snap.spentTodayEur).toBeGreaterThan(0);
    expect(snap.spentTodayEur).toBeLessThan(snap.spentTodayUsd * 1.5);
    expect(snap.usdToEurRate).toBeGreaterThan(0);
  });

  it("does not grow without bound — old days are evicted", () => {
    // A server that runs for months must not accumulate a bucket per day forever.
    for (let d = 0; d < 90; d++) {
      setNow(DAY1 + d * 86_400_000);
      meter.recordModelCall({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 1_000,
        outputTokens: 0,
      });
    }
    expect(meter.trackedDayCount()).toBeLessThanOrEqual(CostMeter.MAX_TRACKED_DAYS);
  });

  it("logs each recorded call at debug level with the numbers that produced it", () => {
    const spy = vi.fn();
    const m = new CostMeter({ now: () => DAY1, onRecord: spy });
    m.recordModelCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
