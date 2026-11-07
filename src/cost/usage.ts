/**
 * Reads the token counts providers return on their responses.
 *
 * WHY read them instead of estimating: an estimate is a guess about money. Every
 * provider the engine talks to reports exact usage, in one of three shapes, and
 * those are the numbers we are billed on. If a response carries no usage at all
 * the right answer is "unmetered" — never zero, and never an approximation.
 */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Handles all three response shapes in use:
 *  - Anthropic:        usage.input_tokens / usage.output_tokens
 *  - OpenAI-compatible: usage.prompt_tokens / usage.completion_tokens
 *    (OpenAI, OpenRouter, Mistral, DeepSeek, Together, Perplexity, Groq)
 *  - Google GenAI:     usageMetadata.promptTokenCount / candidatesTokenCount
 *
 * Returns null when no usage block is present, which the caller must treat as an
 * alarm rather than a free call.
 */
export function extractUsage(response: unknown): RawUsage | null {
  if (!response || typeof response !== "object") return null;
  const res = response as Record<string, unknown>;

  const usage = res.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    const anthropicIn = num(usage.input_tokens);
    const anthropicOut = num(usage.output_tokens);
    if (anthropicIn !== null || anthropicOut !== null) {
      return { inputTokens: anthropicIn ?? 0, outputTokens: anthropicOut ?? 0 };
    }
    const openaiIn = num(usage.prompt_tokens);
    const openaiOut = num(usage.completion_tokens);
    if (openaiIn !== null || openaiOut !== null) {
      return { inputTokens: openaiIn ?? 0, outputTokens: openaiOut ?? 0 };
    }
  }

  const meta = res.usageMetadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const geminiIn = num(meta.promptTokenCount);
    const geminiOut = num(meta.candidatesTokenCount);
    if (geminiIn !== null || geminiOut !== null) {
      return { inputTokens: geminiIn ?? 0, outputTokens: geminiOut ?? 0 };
    }
  }

  return null;
}
