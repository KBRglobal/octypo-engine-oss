/**
 * AI Provider Management
 * Handles multi-provider AI client initialization with fallback chain
 * Uses native SDKs for each provider with unified interface
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentTier, ModelConfig } from "./types.js";

// ============================================================================
// Unified AI Interface
// ============================================================================

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletionOptions {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" } | { type: "text" };
}

export interface AICompletionResult {
  content: string;
  provider: string;
  model: string;
}

export interface UnifiedAIProvider {
  name: string;
  model: string;
  generateCompletion: (options: AICompletionOptions) => Promise<AICompletionResult>;
}

// ============================================================================
// API Key Validation
// ============================================================================

export function getValidOpenAIKey(): string | null {
  const integrationsKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (integrationsKey && !integrationsKey.includes("DUMMY")) {
    return integrationsKey;
  }
  const directKey = process.env.OPENAI_API_KEY;
  if (directKey && !directKey.includes("DUMMY")) {
    return directKey;
  }
  return null;
}

// ============================================================================
// OpenAI Provider
// ============================================================================

function createOpenAIProvider(): UnifiedAIProvider | null {
  const apiKey = getValidOpenAIKey();
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
  });

  return {
    name: "openai",
    model: "gpt-4o-mini",
    generateCompletion: async options => {
      const completion = await client.chat.completions.create({
        model: options.model || "gpt-4o-mini",
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 12000,
        ...(options.responseFormat?.type === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
      });
      return {
        content: completion.choices[0]?.message?.content || "",
        provider: "openai",
        model: options.model || "gpt-4o-mini",
      };
    },
  };
}

// ============================================================================
// Anthropic Provider (using native SDK)
// ============================================================================

function createAnthropicProvider(): UnifiedAIProvider | null {
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return null;

  const client = new Anthropic({
    apiKey,
    baseURL: baseURL || undefined,
  });

  return {
    name: "anthropic",
    model: "claude-sonnet-4-5",
    generateCompletion: async options => {
      const systemMessage = options.messages.find(m => m.role === "system");
      const userMessages = options.messages.filter(m => m.role !== "system");

      const messages = userMessages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      let systemPrompt = systemMessage?.content || "";
      if (options.responseFormat?.type === "json_object") {
        systemPrompt +=
          "\n\nIMPORTANT: You MUST respond with valid JSON only. No other text before or after the JSON.";
      }

      const response = await client.messages.create({
        model: options.model || "claude-sonnet-4-5",
        max_tokens: options.maxTokens ?? 8192,
        system: systemPrompt,
        messages,
      });

      // Extract all text content blocks and concatenate them
      const textParts: string[] = [];
      for (const block of response.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        }
      }
      const content = textParts.join("\n");

      if (!content) {
        throw new Error("Empty response from Anthropic - no text content blocks found");
      }

      return {
        content,
        provider: "anthropic",
        model: options.model || "claude-sonnet-4-5",
      };
    },
  };
}

// ============================================================================
// OpenRouter Provider (OpenAI-compatible)
// ============================================================================

function createOpenRouterProvider(): UnifiedAIProvider | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      ...(process.env.SITE_URL ? { "HTTP-Referer": process.env.SITE_URL } : {}),
      "X-Title": "Octypo Engine",
    },
  });

  return {
    name: "openrouter",
    model: "anthropic/claude-3.5-sonnet",
    generateCompletion: async options => {
      const completion = await client.chat.completions.create({
        model: options.model || "anthropic/claude-3.5-sonnet",
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 12000,
      });
      return {
        content: completion.choices[0]?.message?.content || "",
        provider: "openrouter",
        model: options.model || "anthropic/claude-3.5-sonnet",
      };
    },
  };
}

// ============================================================================
// DeepSeek Provider (OpenAI-compatible)
// ============================================================================

function createDeepSeekProvider(): UnifiedAIProvider | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
  });

  return {
    name: "deepseek",
    model: "deepseek-chat",
    generateCompletion: async options => {
      // DeepSeek API has max_tokens limit of 8192
      const maxTokens = Math.min(options.maxTokens ?? 8192, 8192);
      const completion = await client.chat.completions.create({
        model: options.model || "deepseek-chat",
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: maxTokens,
      });
      return {
        content: completion.choices[0]?.message?.content || "",
        provider: "deepseek",
        model: options.model || "deepseek-chat",
      };
    },
  };
}

// ============================================================================
// Google Gemini Provider (OpenAI-compatible via Google AI)
// ============================================================================

function createGeminiProvider(): UnifiedAIProvider | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });

  return {
    name: "gemini",
    model: "gemini-1.5-flash",
    generateCompletion: async options => {
      const completion = await client.chat.completions.create({
        model: options.model || "gemini-1.5-flash",
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 8192,
      });
      return {
        content: completion.choices[0]?.message?.content || "",
        provider: "gemini",
        model: options.model || "gemini-1.5-flash",
      };
    },
  };
}

// ============================================================================
// Groq Provider (Fast inference via Groq Cloud)
// ============================================================================

function createGroqProvider(): UnifiedAIProvider | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  return {
    name: "groq",
    model: "llama-3.1-70b-versatile",
    generateCompletion: async options => {
      // Groq has specific token limits per model
      const maxTokens = Math.min(options.maxTokens ?? 8000, 8000);
      const completion = await client.chat.completions.create({
        model: options.model || "llama-3.1-70b-versatile",
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: maxTokens,
      });
      return {
        content: completion.choices[0]?.message?.content || "",
        provider: "groq",
        model: options.model || "llama-3.1-70b-versatile",
      };
    },
  };
}

// ============================================================================
// Provider Availability Tracking
// ============================================================================

const failedProviders = new Set<string>();
const failedProviderExpiry = new Map<string, number>();
const creditExhaustedProviders = new Set<string>();
const creditExhaustedExpiry = new Map<string, number>();

export type FailureReason = "rate_limited" | "no_credits" | "error";

export function markProviderFailed(provider: string, reason: FailureReason = "rate_limited"): void {
  if (reason === "no_credits") {
    // Credit exhaustion lasts longer (1 hour) since balance won't change quickly
    creditExhaustedProviders.add(provider);
    creditExhaustedExpiry.set(provider, Date.now() + 60 * 60 * 1000);
  } else {
    // Rate limits expire after 5 minutes
    failedProviders.add(provider);
    failedProviderExpiry.set(provider, Date.now() + 5 * 60 * 1000);
  }
}

export function hasNoCredits(provider: string): boolean {
  if (!creditExhaustedProviders.has(provider)) return false;
  const expiry = creditExhaustedExpiry.get(provider);
  if (expiry && Date.now() > expiry) {
    creditExhaustedProviders.delete(provider);
    creditExhaustedExpiry.delete(provider);
    return false;
  }
  return true;
}

export function isRateLimited(provider: string): boolean {
  if (!failedProviders.has(provider)) return false;
  const expiry = failedProviderExpiry.get(provider);
  if (expiry && Date.now() > expiry) {
    failedProviders.delete(provider);
    failedProviderExpiry.delete(provider);
    return false;
  }
  return true;
}

export function markProviderSuccess(provider: string): void {
  // Clear any failure states when a provider succeeds
  failedProviders.delete(provider);
  failedProviderExpiry.delete(provider);
  creditExhaustedProviders.delete(provider);
  creditExhaustedExpiry.delete(provider);
}

function isProviderAvailable(provider: string): boolean {
  // Check credit exhaustion first
  if (hasNoCredits(provider)) return false;

  // Then check rate limiting
  return !isRateLimited(provider);
}

// ============================================================================
// Get All Available Providers (Unified Interface)
// ============================================================================

// Provider registry: name -> factory function (priority order)
const UNIFIED_PROVIDER_REGISTRY: Array<{ name: string; create: () => UnifiedAIProvider | null }> = [
  { name: "anthropic", create: createAnthropicProvider },
  { name: "openrouter", create: createOpenRouterProvider },
  { name: "deepseek", create: createDeepSeekProvider },
  { name: "gemini", create: createGeminiProvider },
  { name: "groq", create: createGroqProvider },
  { name: "openai", create: createOpenAIProvider },
];

export function getAllUnifiedProviders(): UnifiedAIProvider[] {
  const providers: UnifiedAIProvider[] = [];

  for (const entry of UNIFIED_PROVIDER_REGISTRY) {
    if (!isProviderAvailable(entry.name)) continue;
    const provider = entry.create();
    if (provider) providers.push(provider);
  }

  return providers;
}

// ============================================================================
// Legacy OpenAI-compatible interface (for backwards compatibility)
// ============================================================================

export function getOpenAIClient(): OpenAI | null {
  const apiKey = getValidOpenAIKey();
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
  });
}

export type AIProvider = { client: OpenAI; provider: string; model: string };

interface LegacyProviderDef {
  name: string;
  model: string;
  create: () => { client: OpenAI; valid: boolean } | null;
}

function createLegacyOpenAI(): { client: OpenAI; valid: boolean } | null {
  const openai = getOpenAIClient();
  return openai ? { client: openai, valid: true } : null;
}

function createLegacyOpenRouter(): { client: OpenAI; valid: boolean } | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return {
    client: new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        ...(process.env.SITE_URL ? { "HTTP-Referer": process.env.SITE_URL } : {}),
        "X-Title": "Octypo Engine",
      },
    }),
    valid: true,
  };
}

function createLegacyDeepSeek(): { client: OpenAI; valid: boolean } | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return { client: new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" }), valid: true };
}

function createLegacyGemini(): { client: OpenAI; valid: boolean } | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) return null;
  return {
    client: new OpenAI({
      apiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    }),
    valid: true,
  };
}

function createLegacyGroq(): { client: OpenAI; valid: boolean } | null {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return { client: new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" }), valid: true };
}

const LEGACY_PROVIDER_REGISTRY: LegacyProviderDef[] = [
  { name: "openai", model: "gpt-4o-mini", create: createLegacyOpenAI },
  { name: "openrouter", model: "anthropic/claude-3.5-sonnet", create: createLegacyOpenRouter },
  { name: "deepseek", model: "deepseek-chat", create: createLegacyDeepSeek },
  { name: "gemini", model: "gemini-1.5-flash", create: createLegacyGemini },
  { name: "groq", model: "llama-3.1-70b-versatile", create: createLegacyGroq },
];

export function getAllAIClients(): AIProvider[] {
  const clients: AIProvider[] = [];

  for (const def of LEGACY_PROVIDER_REGISTRY) {
    if (!isProviderAvailable(def.name)) continue;
    const result = def.create();
    if (result) {
      clients.push({ client: result.client, provider: def.name, model: def.model });
    }
  }

  return clients;
}

export function getAIClient(): { client: OpenAI; provider: string } | null {
  const clients = getAllAIClients();
  if (clients.length > 0) {
    return { client: clients[0].client, provider: clients[0].provider };
  }

  return null;
}

// ============================================================================
// Model Configuration
// ============================================================================

const MODEL_CONFIGS: Record<ContentTier, Omit<ModelConfig, "model">> = {
  premium: {
    maxTokens: 16000,
    temperature: 0.7,
  },
  standard: {
    maxTokens: 8000,
    temperature: 0.7,
  },
};

export function getModelForProvider(provider: string, tier: ContentTier = "standard"): string {
  switch (provider) {
    case "openai":
      return tier === "premium" ? "gpt-4o" : "gpt-4o-mini";
    case "anthropic":
      return "claude-sonnet-4-5";
    case "openrouter":
      return "anthropic/claude-3.5-sonnet";
    case "deepseek":
      return "deepseek-chat";
    default:
      return "gpt-4o-mini";
  }
}

export function getContentTier(contentType: string): ContentTier {
  const premiumTypes = ["guide", "research", "deep-dive"];
  return premiumTypes.includes(contentType.toLowerCase()) ? "premium" : "standard";
}

export function getModelConfig(tier: ContentTier, provider: string = "openai"): ModelConfig {
  const config = MODEL_CONFIGS[tier];
  return {
    model: getModelForProvider(provider, tier),
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  };
}

// ============================================================================
// Provider Status API
// ============================================================================

export interface ProviderStatus {
  name: string;
  model: string;
  status: "available" | "rate_limited" | "no_credits" | "not_configured";
  message?: string;
  retryAfter?: number; // seconds until available
}

function getProviderStatusValue(provider: string, isConfigured: boolean): ProviderStatus["status"] {
  if (!isConfigured) return "not_configured";
  if (hasNoCredits(provider)) return "no_credits";
  if (isRateLimited(provider)) return "rate_limited";
  return "available";
}

function getProviderMessage(provider: string, isConfigured: boolean): string {
  if (!isConfigured) return "No API key configured";
  if (hasNoCredits(provider)) return "Insufficient credits/balance";
  if (isRateLimited(provider)) return "Temporarily rate limited";
  return "Ready";
}

export function getProviderStatus(): ProviderStatus[] {
  const statuses: ProviderStatus[] = [];

  // Check Anthropic
  const hasAnthropic = !!(
    process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  );
  statuses.push({
    name: "Anthropic (Claude)",
    model: "claude-sonnet-4-5",
    status: getProviderStatusValue("anthropic", hasAnthropic),
    message: getProviderMessage("anthropic", hasAnthropic),
    retryAfter: getRetryAfter("anthropic"),
  });

  // Check OpenRouter
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  statuses.push({
    name: "OpenRouter",
    model: "anthropic/claude-3.5-sonnet",
    status: getProviderStatusValue("openrouter", hasOpenRouter),
    message: getProviderMessage("openrouter", hasOpenRouter),
    retryAfter: getRetryAfter("openrouter"),
  });

  // Check DeepSeek
  const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
  statuses.push({
    name: "DeepSeek",
    model: "deepseek-chat",
    status: getProviderStatusValue("deepseek", hasDeepSeek),
    message: getProviderMessage("deepseek", hasDeepSeek),
    retryAfter: getRetryAfter("deepseek"),
  });

  // Check OpenAI
  const hasOpenAI = !!getValidOpenAIKey();
  statuses.push({
    name: "OpenAI",
    model: "gpt-4o-mini",
    status: getProviderStatusValue("openai", hasOpenAI),
    message: getProviderMessage("openai", hasOpenAI),
    retryAfter: getRetryAfter("openai"),
  });

  return statuses;
}

function getRetryAfter(provider: string): number | undefined {
  // Check credit exhaustion first (longer timeout)
  const creditExpiry = creditExhaustedExpiry.get(provider);
  if (creditExpiry) {
    const remaining = creditExpiry - Date.now();
    if (remaining > 0) return Math.ceil(remaining / 1000);
  }

  // Then check rate limit expiry
  const expiry = failedProviderExpiry.get(provider);
  if (!expiry) return undefined;
  const remaining = expiry - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : undefined;
}
