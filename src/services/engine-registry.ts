import { logger } from "../lib/logger.js";
import { meterEngineCall, spendCeiling } from "../cost/index.js";
import type { GoogleGenAI } from "@google/genai";

// Lazy-loaded SDK constructors to avoid heavy imports at server startup
let _Anthropic: typeof import("@anthropic-ai/sdk").default | null = null;
let _OpenAI: typeof import("openai").default | null = null;
let _GoogleGenAI: typeof GoogleGenAI | null = null;
let _Groq: typeof import("groq-sdk").default | null = null;

async function getAnthropicCtor() {
  if (!_Anthropic) {
    const m = await import("@anthropic-ai/sdk");
    _Anthropic = m.default;
  }
  return _Anthropic;
}
async function getOpenAICtor() {
  if (!_OpenAI) {
    const m = await import("openai");
    _OpenAI = m.default;
  }
  return _OpenAI;
}
async function getGoogleGenAICtor() {
  if (!_GoogleGenAI) {
    const m = await import("@google/genai");
    _GoogleGenAI = m.GoogleGenAI;
  }
  return _GoogleGenAI;
}
async function getGroqCtor() {
  if (!_Groq) {
    const m = await import("groq-sdk");
    _Groq = m.default;
  }
  return _Groq;
}

export type ProviderType =
  | "anthropic"
  | "openai"
  | "gemini"
  | "groq"
  | "mistral"
  | "deepseek"
  | "openrouter"
  | "together"
  | "perplexity"
  | "kimi";

export interface EngineConfig {
  id: string;
  name: string;
  provider: ProviderType;
  model: string;
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
  maxTokens: number;
  weight: number;
  isHealthy: boolean;
  errorCount: number;
  lastError?: string;
  lastErrorAt?: Date;
  lastUsed?: Date;
  successCount: number;
}

export interface EngineStats {
  total: number;
  healthy: number;
  byProvider: Record<ProviderType, number>;
}

class EngineRegistryClass {
  private engines: EngineConfig[] = [];
  private currentIndex = 0;
  private initialized = false;
  /** When every provider went unhealthy, so the breaker can stay open. */
  private allTrippedAt: number | null = null;
  /** How long to stop calling providers once all of them have failed. */
  static readonly COOL_OFF_MS = 60_000;
  // Per-provider round-robin counters for true queue behavior
  private readonly providerCounters: Map<string, number> = new Map();
  // Global counter for all engines (true round-robin across ALL engines)
  private globalQueueIndex = 0;
  // Provider-level suspension tracking (when quota exhausted, suspend entire provider)
  private readonly suspendedProviders: Map<ProviderType, number> = new Map();
  // Provider priority order - prefer providers with available quota
  private readonly providerPriority: ProviderType[] = [
    "anthropic",
    "openrouter",
    "gemini",
    "groq",
    "mistral",
    "deepseek",
    "perplexity",
    "together",
    "kimi",
    "openai",
  ];

  private fastEngine: EngineConfig | null = null;

  initialize(): void {
    if (this.initialized) return;

    this.engines = [];

    this.loadAnthropicEngines();
    this.loadAnthropicFastEngine();
    this.loadOpenAIEngines();
    this.loadOpenRouterEngines();
    this.loadGeminiEngines();
    this.loadGroqEngines();
    this.loadMistralEngines();
    this.loadDeepSeekEngines();
    this.loadTogetherEngines();
    this.loadPerplexityEngines();

    this.initialized = true;
  }

  private loadAnthropicEngines(): void {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return;

    const heliconeKey = process.env.HELICONE_API_KEY;

    // Route through Helicone proxy when available (observability + logging)
    const baseURL = heliconeKey ? "https://anthropic.helicone.ai" : "https://api.anthropic.com";
    const headers = heliconeKey ? { "Helicone-Auth": `Bearer ${heliconeKey}` } : undefined;

    this.engines.push({
      id: "anthropic",
      name: heliconeKey ? "Anthropic Claude (via Helicone)" : "Anthropic Claude",
      provider: "anthropic",
      // Configurable because the model *is* the product here: a customer paying
      // for editorial quality and one paying for volume want different tiers.
      // The default stays where the measured €0.11-per-article figure came from.
      model: process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001",
      apiKey: key,
      baseURL,
      headers,
      // A 2,000-word article is far more tokens in many languages than in
      // English, and a response cut off at the ceiling arrives as unterminated
      // JSON — which reads like a parser bug and is not one.
      maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS) || 8192,
      weight: 1,
      isHealthy: true,
      errorCount: 0,
      successCount: 0,
    });
  }

  /**
   * A second Anthropic engine, deliberately cheap and fast.
   *
   * Writing an article and judging one are different jobs. The writer needs the
   * strong model; a gate deciding "is this good enough" or a helper deriving
   * five quick facts does not, and putting the strong model behind all of them
   * is most of the wall-clock time and most of the bill for no gain in the
   * article a reader sees.
   *
   * Registered under a distinct id and never returned by the normal queue, so
   * it is used only where a caller explicitly asks for it.
   */
  private loadAnthropicFastEngine(): void {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return;

    const heliconeKey = process.env.HELICONE_API_KEY;
    const baseURL = heliconeKey ? "https://anthropic.helicone.ai" : "https://api.anthropic.com";
    const headers = heliconeKey ? { "Helicone-Auth": `Bearer ${heliconeKey}` } : undefined;

    this.fastEngine = {
      id: "anthropic-fast",
      name: "Anthropic Claude (fast tier)",
      provider: "anthropic",
      model: process.env.ANTHROPIC_FAST_MODEL?.trim() || "claude-haiku-4-5-20251001",
      apiKey: key,
      baseURL,
      headers,
      maxTokens: Number(process.env.ANTHROPIC_FAST_MAX_TOKENS) || 8192,
      weight: 1,
      isHealthy: true,
      errorCount: 0,
      successCount: 0,
    };
  }

  /**
   * The engine for judgement and helper calls. Null when nothing is configured,
   * in which case a caller falls back to the normal queue and simply runs
   * slower — never fails.
   */
  getFastEngine(): EngineConfig | null {
    this.initialize();
    if (spendCeiling.isReached()) return null;
    return this.fastEngine;
  }

  private loadOpenAIEngines(): void {
    const key = process.env.OPENAI_API_KEY;
    if (key) {
      this.engines.push({
        id: "openai",
        name: "OpenAI GPT-4o",
        provider: "openai",
        model: "gpt-4o",
        apiKey: key,
        baseURL: "https://api.openai.com/v1",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadOpenRouterEngines(): void {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) {
      this.engines.push({
        id: "openrouter",
        name: "OpenRouter",
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
        apiKey: key,
        baseURL: "https://openrouter.ai/api/v1",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadGeminiEngines(): void {
    const key = process.env.GEMINI_API_KEY;
    if (key) {
      this.engines.push({
        id: "gemini",
        name: "Gemini Flash",
        provider: "gemini",
        model: "gemini-2.0-flash",
        apiKey: key,
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadGroqEngines(): void {
    const key = process.env.GROQ_API_KEY;
    if (key) {
      this.engines.push({
        id: "groq",
        name: "Groq Llama",
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        apiKey: key,
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadMistralEngines(): void {
    const key = process.env.MISTRAL_API_KEY;
    if (key) {
      this.engines.push({
        id: "mistral",
        name: "Mistral Large",
        provider: "mistral",
        model: "mistral-large-latest",
        apiKey: key,
        baseURL: "https://api.mistral.ai/v1",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadDeepSeekEngines(): void {
    const key = process.env.DEEPSEEK_API_KEY;
    if (key) {
      this.engines.push({
        id: "deepseek",
        name: "DeepSeek",
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: key,
        baseURL: "https://api.deepseek.com",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadTogetherEngines(): void {
    const key = process.env.TOGETHER_API_KEY;
    if (key) {
      this.engines.push({
        id: "together",
        name: "Together AI",
        provider: "together",
        model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        apiKey: key,
        baseURL: "https://api.together.xyz/v1",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadPerplexityEngines(): void {
    const key = process.env.PERPLEXITY_API_KEY;
    if (key) {
      this.engines.push({
        id: "perplexity",
        name: "Perplexity AI",
        provider: "perplexity",
        model: "sonar", // Current Perplexity model (formerly pplx-*-online)
        apiKey: key,
        baseURL: "https://api.perplexity.ai",
        maxTokens: 8192,
        weight: 1,
        isHealthy: true,
        errorCount: 0,
        successCount: 0,
      });
    }
  }

  private loadKimiEngines(): void {
    // Kimi/Moonshot disabled - API key invalid (401 auth error)
    // To re-enable: obtain valid API key from https://platform.moonshot.cn
    // and uncomment the engine registration below
  }

  getNextEngine(): EngineConfig | null {
    this.initialize();

    // Money gate. Handing back no engine is the same clean failure callers
    // already handle for "everything is unhealthy", so a reached spend ceiling
    // stops generation without crashing anything.
    if (spendCeiling.isReached()) return null;

    const healthyEngines = this.engines.filter(e => e.isHealthy);
    if (healthyEngines.length === 0) {
      // Every provider is tripped. This used to reset them all to healthy and
      // hand one back immediately, which turned a genuine outage into a hot loop
      // against paid APIs — the breaker defeated itself. Now the reset is
      // time-based: nothing is retried until the cool-off has actually elapsed,
      // and callers get null (a clean failure) until then.
      const now = Date.now();
      if (this.allTrippedAt === null) {
        this.allTrippedAt = now;
        logger.error(
          { engines: this.engines.length },
          "[EngineRegistry] All providers unhealthy — opening circuit, no calls until cool-off"
        );
      }
      if (now - this.allTrippedAt < EngineRegistryClass.COOL_OFF_MS) {
        return null;
      }
      logger.warn("[EngineRegistry] Cool-off elapsed — probing providers again");
      this.allTrippedAt = null;
      this.engines.forEach(e => {
        e.isHealthy = true;
        e.errorCount = 0;
      });
      return this.engines[0] || null;
    }

    // At least one provider is answering again.
    this.allTrippedAt = null;

    const engine = healthyEngines[this.currentIndex % healthyEngines.length];
    this.currentIndex++;
    engine.lastUsed = new Date();
    return engine;
  }

  reportSuccess(engineId: string): void {
    const engine = this.engines.find(e => e.id === engineId);
    if (engine) {
      engine.successCount++;
      engine.errorCount = Math.max(0, engine.errorCount - 1);
      engine.isHealthy = true;
    }
  }

  reportFailure(engineId: string, error: string): void {
    this.reportError(engineId, error);
  }

  reportError(engineId: string, error: string): void {
    const engine = this.engines.find(e => e.id === engineId);
    if (engine) {
      engine.errorCount++;
      engine.lastError = error;
      engine.lastErrorAt = new Date();

      const isQuotaError =
        error.includes("402") ||
        error.includes("insufficient") ||
        error.includes("Insufficient credits") ||
        error.includes("quota") ||
        error.includes("exceeded your current quota");

      // Fatal errors = immediate suspension (bad auth, quota, server error)
      const isFatalError =
        isQuotaError ||
        error.includes("401") ||
        error.includes("429") || // Rate limit
        error.includes("500") || // Server error
        error.includes("502") || // Bad gateway
        error.includes("503") || // Service unavailable
        error.includes("API key not valid") ||
        error.includes("INVALID_ARGUMENT") ||
        error.includes("invalid authentication");

      // Timeout = transient - suspend only after 2 consecutive timeouts
      const isTimeout =
        error.toLowerCase().includes("timeout") || error.toUpperCase().includes("TIMEOUT");

      if (isFatalError) {
        engine.isHealthy = false;
      } else if (isTimeout && engine.errorCount >= 2) {
        // 2+ consecutive timeouts → suspend temporarily
        engine.isHealthy = false;
      } else if (!isTimeout && engine.errorCount >= 2) {
        // 2+ non-timeout, non-fatal errors → suspend
        engine.isHealthy = false;
      }

      // PROVIDER-LEVEL suspension for quota errors - suspend ALL engines of this provider for 10 minutes
      if (isQuotaError) {
        const suspendUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
        this.suspendedProviders.set(engine.provider, suspendUntil);

        // Suspend all engines of this provider
        this.engines
          .filter(e => e.provider === engine.provider)
          .forEach(e => {
            e.isHealthy = false;
          });
      }

      // Timeout-based provider suspension - if 3+ engines from same provider timeout, suspend provider
      if (isTimeout) {
        const timedOutEngines = this.engines.filter(
          e =>
            e.provider === engine.provider &&
            !e.isHealthy &&
            e.lastError?.toLowerCase().includes("timeout")
        );
        if (timedOutEngines.length >= 3) {
          const suspendUntil = Date.now() + 2 * 60 * 1000; // 2 minutes for timeout (shorter than quota)
          this.suspendedProviders.set(engine.provider, suspendUntil);

          this.engines
            .filter(e => e.provider === engine.provider)
            .forEach(e => {
              e.isHealthy = false;
            });
        }
      }
    }
  }

  // Check if a provider is currently suspended
  isProviderSuspended(provider: ProviderType): boolean {
    const suspendUntil = this.suspendedProviders.get(provider);
    if (!suspendUntil) return false;
    if (Date.now() > suspendUntil) {
      this.suspendedProviders.delete(provider);

      return false;
    }
    return true;
  }

  // Reset suspended engines periodically (call this every few minutes)
  resetSuspendedEngines(): number {
    let resetCount = 0;
    const now = Date.now();
    for (const engine of this.engines) {
      if (!engine.isHealthy && engine.lastUsed) {
        // Reset after 5 minutes of suspension
        const suspendedMs = now - engine.lastUsed.getTime();
        if (suspendedMs > 5 * 60 * 1000) {
          engine.isHealthy = true;
          engine.errorCount = 0;
          resetCount++;
        }
      }
    }
    return resetCount;
  }

  /**
   * Reset ALL unhealthy engines back to healthy state.
   * Use with caution - intended for manual recovery or full reset scenarios.
   */
  resetAll(): number {
    let resetCount = 0;
    for (const engine of this.engines) {
      if (!engine.isHealthy) {
        engine.isHealthy = true;
        engine.errorCount = 0;
        resetCount++;
      }
    }
    // Also clear all provider suspensions
    this.suspendedProviders.clear();
    return resetCount;
  }

  /**
   * Reset engines that have been unhealthy for longer than maxAgeMs.
   * Only resets engines whose last error occurred more than maxAgeMs ago,
   * giving them a chance to recover from transient failures.
   */
  resetStaleEngines(maxAgeMs: number): number {
    let resetCount = 0;
    const now = Date.now();
    for (const engine of this.engines) {
      if (!engine.isHealthy && engine.lastErrorAt) {
        const staleDuration = now - engine.lastErrorAt.getTime();
        if (staleDuration > maxAgeMs) {
          engine.isHealthy = true;
          engine.errorCount = 0;
          resetCount++;
        }
      }
    }
    // Also clear expired provider suspensions
    for (const [provider, suspendUntil] of this.suspendedProviders.entries()) {
      if (now > suspendUntil) {
        this.suspendedProviders.delete(provider);
      }
    }
    return resetCount;
  }

  // Get all healthy engines for parallel execution
  getHealthyEngines(): EngineConfig[] {
    this.initialize();
    return this.engines.filter(e => e.isHealthy);
  }

  getEngineCount(): number {
    this.initialize();
    return this.engines.length;
  }

  getHealthyEngineCount(): number {
    this.initialize();
    return this.engines.filter(e => e.isHealthy).length;
  }

  getStats(): EngineStats {
    this.initialize();
    const byProvider: Record<ProviderType, number> = {
      anthropic: 0,
      openai: 0,
      openrouter: 0,
      gemini: 0,
      groq: 0,
      mistral: 0,
      deepseek: 0,
      together: 0,
      perplexity: 0,
      kimi: 0,
    };
    this.engines.forEach(e => byProvider[e.provider]++);

    return {
      total: this.engines.length,
      healthy: this.engines.filter(e => e.isHealthy).length,
      byProvider,
    };
  }

  getAllEngines(): EngineConfig[] {
    this.initialize();
    return [...this.engines];
  }

  /**
   * TRUE QUEUE SYSTEM: Get the next healthy engine from ALL engines using round-robin
   * Every call advances the queue - ensuring fair distribution across ALL API keys
   * PRIORITY: Prefers providers in priority order, skips suspended providers
   */
  getNextFromQueue(excludeIds: Set<string> = new Set()): EngineConfig | null {
    this.initialize();

    // Money gate — see getNextEngine().
    if (spendCeiling.isReached()) return null;

    // First, try to get an engine from a non-suspended provider in priority order
    for (const provider of this.providerPriority) {
      if (this.isProviderSuspended(provider)) {
        continue; // Skip suspended providers entirely
      }

      const providerEngines = this.engines.filter(
        e => e.provider === provider && e.isHealthy && !excludeIds.has(e.id)
      );

      if (providerEngines.length > 0) {
        // Get per-provider counter
        let counter = this.providerCounters.get(provider) || 0;
        const engine = providerEngines[counter % providerEngines.length];
        this.providerCounters.set(provider, counter + 1);
        engine.lastUsed = new Date();
        return engine;
      }
    }

    // Fallback: try any healthy engine
    const healthyEngines = this.engines.filter(e => e.isHealthy && !excludeIds.has(e.id));
    if (healthyEngines.length === 0) {
      return null;
    }

    // True round-robin: advance counter and get next engine
    const startIndex = this.globalQueueIndex;
    for (let i = 0; i < healthyEngines.length; i++) {
      const index = (startIndex + i) % healthyEngines.length;
      const engine = healthyEngines[index];
      if (engine.isHealthy) {
        this.globalQueueIndex = (index + 1) % healthyEngines.length;
        engine.lastUsed = new Date();
        return engine;
      }
    }

    return null;
  }

  /**
   * Get next healthy engine matching a provider preference using per-provider round-robin
   * This ensures load is distributed across all keys of the same provider type
   */
  getNextByProviderPreference(
    preferredProviders: string[],
    excludeIds: Set<string> = new Set()
  ): EngineConfig | null {
    this.initialize();

    // Money gate — see getNextEngine().
    if (spendCeiling.isReached()) return null;

    // Valid provider types for type-safe suspension lookup
    const validProviders: ProviderType[] = [
      "anthropic",
      "openai",
      "gemini",
      "groq",
      "mistral",
      "deepseek",
      "openrouter",
      "together",
      "perplexity",
      "kimi",
    ];

    // Collect all matching healthy engines across all preferred providers
    // CRITICAL: Skip providers that are suspended (quota exhausted or timing out)
    const matchingEngines: EngineConfig[] = [];
    for (const pref of preferredProviders) {
      // Extract actual provider name from preference - handle formats like "anthropic", "anthropic/helicone", etc.
      const prefLower = pref.toLowerCase().split("/")[0].split("-")[0];
      const providerName = validProviders.find(p => prefLower.includes(p) || p.includes(prefLower));

      // Skip entirely if this provider is suspended (type-safe check)
      if (providerName && this.isProviderSuspended(providerName)) {
        continue;
      }

      const engines = this.engines.filter(
        e => e.id.includes(pref) && e.isHealthy && !excludeIds.has(e.id)
      );
      matchingEngines.push(...engines);
    }

    if (matchingEngines.length === 0) {
      // Fall back to global queue if no preferred engines available
      return this.getNextFromQueue(excludeIds);
    }

    // Create a combined key for the preference set for per-preference round-robin
    const prefKey = preferredProviders.join(",");
    let counter = this.providerCounters.get(prefKey) || 0;

    // Round-robin across all matching engines
    const engine = matchingEngines[counter % matchingEngines.length];
    this.providerCounters.set(prefKey, counter + 1);
    engine.lastUsed = new Date();

    return engine;
  }

  /**
   * Get detailed stats for monitoring - shows usage per engine
   */
  getDetailedStats(): {
    engines: Array<{
      id: string;
      name: string;
      provider: string;
      healthy: boolean;
      successCount: number;
      errorCount: number;
      lastError?: string;
    }>;
    queueIndex: number;
  } {
    this.initialize();
    return {
      engines: this.engines.map(e => ({
        id: e.id,
        name: e.name,
        provider: e.provider,
        healthy: e.isHealthy,
        successCount: e.successCount,
        errorCount: e.errorCount,
        lastError: e.lastError,
      })),
      queueIndex: this.globalQueueIndex,
    };
  }
}

export const EngineRegistry = new EngineRegistryClass();

/** What each provider call returns: the text, plus the raw response to meter. */
interface EngineCallResult {
  text: string;
  response: unknown;
}

export async function generateWithEngine(
  engine: EngineConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  // Backstop for callers holding an engine reference obtained before the cap was
  // reached. Throws BEFORE any provider is contacted, so a tripped ceiling can
  // never be worked around by keeping a stale engine around.
  spendCeiling.assertNotReached();

  let result: EngineCallResult;
  switch (engine.provider) {
    case "anthropic":
      result = await generateWithAnthropic(engine, systemPrompt, userPrompt);
      break;
    case "openai":
    case "openrouter":
    case "mistral":
    case "deepseek":
    case "together":
    case "perplexity":
    case "kimi":
      result = await generateWithOpenAI(engine, systemPrompt, userPrompt);
      break;
    case "gemini":
      result = await generateWithGemini(engine, systemPrompt, userPrompt);
      break;
    case "groq":
      result = await generateWithGroq(engine, systemPrompt, userPrompt);
      break;
    default:
      throw new Error(`Unknown provider: ${engine.provider}`);
  }

  // Metered here, at the one place every provider call funnels through, using
  // the token counts the provider itself returned. Never throws — the spend has
  // already happened, so a metering problem must not also cost us the article.
  meterEngineCall({
    provider: engine.provider,
    model: engine.model,
    response: result.response,
    engineId: engine.id,
  });

  return result.text;
}

async function generateWithAnthropic(
  engine: EngineConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<EngineCallResult> {
  const Ctor = await getAnthropicCtor();
  const client = new Ctor({
    apiKey: engine.apiKey,
    baseURL: engine.baseURL,
    defaultHeaders: engine.headers,
  });

  // Streamed, always. A 2,000-word article is a long response, and the SDK
  // refuses a non-streaming request whose max_tokens implies more than ten
  // minutes of work — which is how raising the ceiling for a non-English site turned every
  // call into an immediate failure. Streaming also removes the HTTP-timeout
  // ceiling entirely, so the ceiling can be set by the content, not the wire.
  // Current Claude models reason before answering by default, and on a writing
  // task that reasoning is most of the wall-clock time for very little gain:
  // the brief is already explicit and the output is prose, not a decision.
  // Turning it off is what takes an article from six minutes to under two.
  // ANTHROPIC_THINKING=adaptive turns it back on where a task needs it.
  // Fable thinks always — an explicit {type: "disabled"} is rejected with a
  // 400, so on that family the parameter is omitted entirely and depth is
  // shaped with effort instead. Everywhere else, disabled remains the default
  // for prose (see above) and ANTHROPIC_THINKING=adaptive turns it back on.
  const isFable = engine.model.startsWith("claude-fable");
  const wantsAdaptive =
    process.env.ANTHROPIC_THINKING?.trim().toLowerCase() === "adaptive";
  const thinking = isFable
    ? undefined
    : wantsAdaptive
      ? { type: "adaptive" }
      : { type: "disabled" };

  const effort = process.env.ANTHROPIC_EFFORT?.trim();

  const stream = client.messages.stream({
    model: engine.model,
    max_tokens: engine.maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    ...(thinking ? { thinking: thinking as never } : {}),
    ...(effort ? { output_config: { effort } as never } : {}),
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "refusal") {
    // Metered first: the declined request still billed its input tokens.
    meterEngineCall({ provider: engine.provider, model: engine.model, response, engineId: engine.id });
    // Fable's safety layer can decline a request outright. It is not an engine
    // failure — retrying the same prompt on the same model returns the same
    // answer — so say what happened rather than looping.
    throw new Error("Anthropic declined this request (stop_reason: refusal)");
  }

  // A response cut off by the ceiling is NOT a response. With text present it
  // parses cleanly — title and body come first in the output contract — and a
  // mid-sentence article with its trailing fields silently lost would sail
  // into review looking normal. Truncation must fail loudly, never pass.
  if ((response.stop_reason as string) === "max_tokens") {
    meterEngineCall({ provider: engine.provider, model: engine.model, response, engineId: engine.id });
    throw new Error(
      `Anthropic response truncated at the ${engine.maxTokens}-token ceiling — raise ANTHROPIC_MAX_TOKENS`
    );
  }

  const textBlock = response.content.find(block => block.type === "text");
  if (textBlock?.type !== "text") {
    // Metered before throwing: those tokens were billed even though the
    // response is unusable to us.
    meterEngineCall({
      provider: engine.provider,
      model: engine.model,
      response,
      engineId: engine.id,
    });
    // Current models think by default. A response with no text block almost
    // always means the whole token budget went to reasoning and the answer was
    // cut off before it started — a ceiling problem, not a refusal.
    throw new Error(
      (response.stop_reason as string) === "max_tokens"
        ? `No text response from Anthropic — the ${engine.maxTokens}-token ceiling was reached before any text was produced. Raise ANTHROPIC_MAX_TOKENS.`
        : `No text response from Anthropic (stop_reason: ${response.stop_reason})`
    );
  }
  return { text: textBlock.text, response };
}

async function generateWithOpenAI(
  engine: EngineConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<EngineCallResult> {
  const Ctor = await getOpenAICtor();
  const client = new Ctor({
    apiKey: engine.apiKey,
    baseURL: engine.baseURL,
  });

  // Add response_format for providers that support it (OpenAI, DeepSeek, Mistral)
  // Helps enforce JSON output format
  const supportsJsonFormat = ["openai", "deepseek", "mistral"].includes(engine.provider);

  const response = await client.chat.completions.create({
    model: engine.model,
    max_tokens: engine.maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    ...(supportsJsonFormat && { response_format: { type: "json_object" as const } }),
  });

  // "length" means the ceiling cut the answer mid-thought. Truncated output
  // parses cleanly and ships broken — fail loudly instead.
  if (response.choices[0]?.finish_reason === "length") {
    throw new Error(`${engine.provider} response truncated at the ${engine.maxTokens}-token ceiling`);
  }
  return { text: response.choices[0]?.message?.content || "", response };
}

async function generateWithGemini(
  engine: EngineConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<EngineCallResult> {
  const Ctor = await getGoogleGenAICtor();
  const ai = new Ctor({ apiKey: engine.apiKey });

  const response = await ai.models.generateContent({
    model: engine.model,
    contents: `${systemPrompt}\n\n${userPrompt}`,
    config: {
      maxOutputTokens: engine.maxTokens,
    },
  });

  const geminiFinish = (response as { candidates?: { finishReason?: string }[] }).candidates?.[0]
    ?.finishReason;
  if (geminiFinish === "MAX_TOKENS") {
    throw new Error(`gemini response truncated at the ${engine.maxTokens}-token ceiling`);
  }
  return { text: response.text || "", response };
}

async function generateWithGroq(
  engine: EngineConfig,
  systemPrompt: string,
  userPrompt: string
): Promise<EngineCallResult> {
  const Ctor = await getGroqCtor();
  const client = new Ctor({ apiKey: engine.apiKey });

  const response = await client.chat.completions.create({
    model: engine.model,
    max_tokens: engine.maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  return { text: response.choices[0]?.message?.content || "", response };
}
