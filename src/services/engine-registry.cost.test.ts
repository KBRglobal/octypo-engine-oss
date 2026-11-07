import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { EngineConfig } from "./engine-registry.js";
import { EngineRegistry, generateWithEngine } from "./engine-registry.js";
import { costMeter, spendCeiling, SpendCeilingExceededError, withArticleCost } from "../cost/index.js";

// No live API calls: both SDKs are replaced with fakes that return the response
// shape the real ones do, including the `usage` block the meter reads.
const anthropicCreate = vi.fn(async () => ({
  content: [{ type: "text", text: "anthropic answer" }],
  usage: { input_tokens: 12_000, output_tokens: 3_000 },
}));
const openaiCreate = vi.fn(async () => ({
  choices: [{ message: { content: "openai answer" } }],
  usage: { prompt_tokens: 200_000, completion_tokens: 50_000 },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    messages = {
      stream: (...args: Parameters<typeof anthropicCreate>) => ({
        finalMessage: () => anthropicCreate(...args),
      }),
    };
  },
}));
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: openaiCreate } };
  },
}));

const anthropicEngine: EngineConfig = {
  id: "anthropic",
  name: "Anthropic Claude",
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
  apiKey: "test-key",
  maxTokens: 8192,
  weight: 1,
  isHealthy: true,
  errorCount: 0,
  successCount: 0,
};

const openaiEngine: EngineConfig = {
  ...anthropicEngine,
  id: "openai",
  name: "OpenAI",
  provider: "openai",
  model: "gpt-4o",
};

const CAP_ENV = "OCTYPO_DAILY_COST_CAP_USD";
const originalCap = process.env[CAP_ENV];

beforeEach(() => {
  process.env[CAP_ENV] = "10";
  costMeter.reset();
  spendCeiling.reset();
  anthropicCreate.mockClear();
  openaiCreate.mockClear();
});

afterAll(() => {
  if (originalCap === undefined) delete process.env[CAP_ENV];
  else process.env[CAP_ENV] = originalCap;
});

/** Burn USD on the meter using a model whose input price is exactly $1/MTok. */
function burn(usd: number): void {
  costMeter.recordModelCall({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: Math.round(usd * 1_000_000),
    outputTokens: 0,
  });
}

describe("engine registry — metering at the call site", () => {
  it("records the provider's real token counts, not an estimate", async () => {
    const text = await generateWithEngine(anthropicEngine, "sys", "user");
    expect(text).toBe("anthropic answer");

    const snap = costMeter.snapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(12_000);
    expect(snap.outputTokens).toBe(3_000);
    // 12_000/1e6*$1 + 3_000/1e6*$5 = $0.027
    expect(snap.spentTodayUsd).toBeCloseTo(0.027, 10);
    expect(snap.unmeteredCalls).toBe(0);
  });

  it("reads the OpenAI-shaped usage block (prompt/completion tokens)", async () => {
    await generateWithEngine(openaiEngine, "sys", "user");
    const snap = costMeter.snapshot();
    expect(snap.inputTokens).toBe(200_000);
    expect(snap.outputTokens).toBe(50_000);
    // 0.2 * $2.50 + 0.05 * $10.00 = $1.00
    expect(snap.spentTodayUsd).toBeCloseTo(1.0, 8);
    expect(snap.byProvider["openai"]).toBeCloseTo(1.0, 8);
  });

  it("attributes the call to the article being generated", async () => {
    await withArticleCost("article-42", () => generateWithEngine(anthropicEngine, "sys", "user"));
    expect(costMeter.articleCostUsd("article-42")).toBeCloseTo(0.027, 10);
  });

  it("flags a call whose response carried no usage as unmetered, never as free", async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "no usage here" }],
    } as never);
    const text = await generateWithEngine(anthropicEngine, "sys", "user");
    expect(text).toBe("no usage here");
    const snap = costMeter.snapshot();
    expect(snap.unmeteredCalls).toBe(1);
    expect(snap.calls).toBe(0);
  });

  it("counts an unpriced model loudly but still returns the paid-for text", async () => {
    // The API call already happened and was already billed. Throwing here would
    // waste the spend as well as mis-measure it, so the loud signal is the
    // counter plus an error log — not a lost article.
    const unpriced: EngineConfig = { ...anthropicEngine, model: "claude-imaginary-9" };
    const text = await generateWithEngine(unpriced, "sys", "user");
    expect(text).toBe("anthropic answer");
    const snap = costMeter.snapshot();
    expect(snap.unpricedCalls).toBe(1);
    expect(snap.unpricedModels).toContain("anthropic/claude-imaginary-9");
  });
});

describe("engine registry — the spend ceiling actually stops work", () => {
  it("hands out engines while under the cap", () => {
    process.env.GROQ_API_KEY = "test-key";
    expect(EngineRegistry.getNextFromQueue()).not.toBeNull();
  });

  it("hands out NO engine once the daily cap is reached", () => {
    process.env.GROQ_API_KEY = "test-key";
    burn(10.5);
    expect(EngineRegistry.getNextFromQueue()).toBeNull();
    expect(EngineRegistry.getNextEngine()).toBeNull();
    expect(EngineRegistry.getNextByProviderPreference(["anthropic"])).toBeNull();
  });

  it("refuses to spend even if a caller holds an engine reference from before the trip", async () => {
    burn(10.5);
    await expect(generateWithEngine(anthropicEngine, "sys", "user")).rejects.toBeInstanceOf(
      SpendCeilingExceededError
    );
    // The decisive check: no provider call was made.
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("leaves a state a dashboard can read after stopping", () => {
    burn(12);
    EngineRegistry.getNextFromQueue();
    const state = spendCeiling.getState();
    expect(state.tripped).toBe(true);
    expect(state.spentUsd).toBeCloseTo(12, 8);
    expect(state.capUsd).toBe(10);
    expect(state.remainingUsd).toBe(0);
  });

  it("resumes handing out engines when the cap is raised (config, not a restart)", () => {
    process.env.GROQ_API_KEY = "test-key";
    burn(10.5);
    expect(EngineRegistry.getNextFromQueue()).toBeNull();
    process.env[CAP_ENV] = "100";
    expect(EngineRegistry.getNextFromQueue()).not.toBeNull();
  });
});
