/**
 * AI Module Main Entry Point
 *
 * This module provides AI-powered content generation for the configured
 * content domain. It supports multiple AI providers (Anthropic, OpenAI,
 * Gemini, Groq, OpenRouter, DeepSeek) with automatic fallback and cost
 * optimization through tiered model selection.
 *
 * Architecture:
 * - providers.ts: AI client initialization and model configuration
 * - multi-model-provider.ts: fallback-chain provider with latency tracking
 * - request-queue.ts: token-bucket rate limiting + priority queue
 * - content-generator.ts: SEO-validated content generation
 * - internal-linking-engine.ts: automatic internal link insertion
 * - plagiarism-detector.ts: embedding-based similarity detection
 */

// ============================================================================
// Type Exports
// ============================================================================
export type { ContentTier, ModelConfig, SeoScoreResult } from "./types.js";

// ============================================================================
// Provider Exports
// ============================================================================
export {
  getValidOpenAIKey,
  getOpenAIClient,
  getAIClient,
  getModelForProvider,
  getContentTier,
  getModelConfig,
  getAllAIClients,
  getAllUnifiedProviders,
  markProviderFailed,
} from "./providers.js";

export type {
  AIMessage,
  AICompletionOptions,
  AICompletionResult,
  UnifiedAIProvider,
  AIProvider,
} from "./providers.js";

// ============================================================================
// Utility Exports
// ============================================================================
export { generateBlockId, generateSlug } from "./utils.js";
