import { describe, it, expect } from "vitest";
import { extractUsage } from "./usage.js";

describe("extractUsage", () => {
  it("reads the Anthropic shape", () => {
    expect(extractUsage({ usage: { input_tokens: 120, output_tokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("reads the OpenAI-compatible shape (OpenAI, Groq, DeepSeek, Together, ...)", () => {
    expect(
      extractUsage({ usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } })
    ).toEqual({ inputTokens: 900, outputTokens: 100 });
  });

  it("reads the Google GenAI shape", () => {
    expect(
      extractUsage({ usageMetadata: { promptTokenCount: 77, candidatesTokenCount: 11 } })
    ).toEqual({ inputTokens: 77, outputTokens: 11 });
  });

  it("returns null when there is no usage at all — the caller must alarm, not assume zero", () => {
    expect(extractUsage({ choices: [] })).toBeNull();
    expect(extractUsage({ usage: {} })).toBeNull();
    expect(extractUsage(null)).toBeNull();
    expect(extractUsage("nope")).toBeNull();
  });

  it("ignores garbage values rather than recording them as tokens", () => {
    expect(extractUsage({ usage: { input_tokens: -1, output_tokens: "many" } })).toBeNull();
    expect(extractUsage({ usage: { input_tokens: 10, output_tokens: null } })).toEqual({
      inputTokens: 10,
      outputTokens: 0,
    });
  });
});
