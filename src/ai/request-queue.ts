/**
 * AI Request Queue System
 * Enhanced with:
 * A) Token Bucket Algorithm - Smooth rate limiting with burst capacity
 * B) Priority Queue System - Priority levels with aging to prevent starvation
 * C) Exponential Backoff - Jittered backoff for error recovery
 */

import {
  getAllUnifiedProviders,
  UnifiedAIProvider,
  AICompletionOptions,
  AICompletionResult,
} from "./providers.js";
import { randomInt } from "node:crypto";
import pino from "pino";

const logger = pino({ level: "info" });

// ============================================================================
// Types
// ============================================================================

export enum RequestPriority {
  CRITICAL = 1, // System-critical requests (e.g., user-facing real-time)
  HIGH = 2, // Important requests (e.g., content generation)
  NORMAL = 5, // Standard requests
  LOW = 8, // Background tasks
  BATCH = 10, // Bulk processing, can wait
}

/**
 * Task category for AI orchestrator governance
 * PHASE 14: All AI calls MUST specify an explicit category
 */
export type AITaskCategory =
  | "news"
  | "evergreen"
  | "enrichment"
  | "content"
  | "translation"
  | "image"
  | "research"
  | "localization"
  | "seo"
  | "internal";

interface QueuedRequest {
  id: string;
  options: AICompletionOptions;
  priority: RequestPriority;
  effectivePriority: number; // Adjusted priority considering age
  addedAt: number;
  resolve: (result: AICompletionResult) => void;
  reject: (error: Error) => void;
  retries: number;
  maxRetries: number;
  preferredProvider?: string;
  lastError?: string;
  backoffUntil?: number; // When this request can be retried
  category?: AITaskCategory; // PHASE 14: Task category for governance
}

interface TokenBucket {
  tokens: number; // Current available tokens
  maxTokens: number; // Maximum burst capacity
  refillRate: number; // Tokens per second
  lastRefill: number; // Last refill timestamp
  requestsThisMinute: number;
  requestsThisHour: number;
  minuteResetAt: number;
  hourResetAt: number;
  blockedUntil: number; // Hard block from rate limit errors
  consecutiveErrors: number;
  lastErrorType?: string;
}

interface QueueStats {
  queueLength: number;
  processing: boolean;
  activeRequests: number;
  completedRequests: number;
  failedRequests: number;
  providers: {
    name: string;
    available: boolean;
    tokens: number;
    maxTokens: number;
    requestsThisMinute: number;
    requestsThisHour: number;
    blockedUntil: number | null;
    waitTimeSeconds: number;
    status: string;
  }[];
  estimatedWaitSeconds: number;
  estimatedWait: string;
}

// ============================================================================
// Configuration
// ============================================================================

const PROVIDER_CONFIG = {
  anthropic: {
    maxTokens: 20, // Burst capacity
    refillRate: 0.25, // 15 per minute = 0.25 per second
    perMinute: 15,
    perHour: 200,
    baseBackoffMs: 5000,
  },
  openrouter: {
    maxTokens: 40,
    refillRate: 0.5, // 30 per minute
    perMinute: 30,
    perHour: 500,
    baseBackoffMs: 3000,
  },
  deepseek: {
    maxTokens: 25,
    refillRate: 0.33, // 20 per minute
    perMinute: 20,
    perHour: 300,
    baseBackoffMs: 4000,
  },
  openai: {
    maxTokens: 25,
    refillRate: 0.33,
    perMinute: 20,
    perHour: 300,
    baseBackoffMs: 4000,
  },
  default: {
    maxTokens: 15,
    refillRate: 0.17,
    perMinute: 10,
    perHour: 100,
    baseBackoffMs: 5000,
  },
};

const MAX_RETRIES = 5;
const QUEUE_PROCESS_INTERVAL_MS = 50; // Check queue every 50ms
const PRIORITY_AGE_FACTOR = 0.05; // Priority boost per second of waiting (slower aging)
const MIN_EFFECTIVE_PRIORITY = 0; // Clamp effective priority to prevent negative values
const MAX_CONCURRENT_REQUESTS = 10; // Increased from 3 - better utilization of burst capacity
const JITTER_FACTOR = 0.3; // 30% jitter on backoff times

// ============================================================================
// Exponential Backoff with Jitter
// ============================================================================

function calculateBackoff(
  baseMs: number,
  attempt: number,
  maxBackoffMs: number = 300000 // 5 minutes max
): number {
  // Exponential: base * 2^attempt
  const exponentialBackoff = baseMs * Math.pow(2, attempt);

  // Cap at max
  const cappedBackoff = Math.min(exponentialBackoff, maxBackoffMs);

  // Add jitter: ±30% (using crypto.randomInt for unpredictable jitter)
  const jitterSign = randomInt(0, 2) === 0 ? -1 : 1;
  const jitterMagnitude = randomInt(0, Math.max(1, Math.floor(cappedBackoff * JITTER_FACTOR)));
  const jitter = jitterSign * jitterMagnitude;

  return Math.max(baseMs, Math.floor(cappedBackoff + jitter));
}

function categorizeError(
  error: any
): "rate_limit" | "server_error" | "client_error" | "network" | "unknown" {
  const status = error?.status || error?.response?.status;
  const message = (error?.message || "").toLowerCase();

  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return "rate_limit";
  }
  if (status >= 500) {
    return "server_error";
  }
  if (status >= 400 && status < 500) {
    return "client_error";
  }
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused")
  ) {
    return "network";
  }
  return "unknown";
}

// ============================================================================
// Token Bucket Implementation
// ============================================================================

class TokenBucketRateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();

  private getConfig(providerName: string) {
    return PROVIDER_CONFIG[providerName as keyof typeof PROVIDER_CONFIG] || PROVIDER_CONFIG.default;
  }

  private getBucket(providerName: string): TokenBucket {
    let bucket = this.buckets.get(providerName);
    if (!bucket) {
      const config = this.getConfig(providerName);
      const now = Date.now();
      bucket = {
        tokens: config.maxTokens, // Start with full bucket
        maxTokens: config.maxTokens,
        refillRate: config.refillRate,
        lastRefill: now,
        requestsThisMinute: 0,
        requestsThisHour: 0,
        minuteResetAt: now + 60000,
        hourResetAt: now + 3600000,
        blockedUntil: 0,
        consecutiveErrors: 0,
      };
      this.buckets.set(providerName, bucket);
    }
    return bucket;
  }

  /**
   * Calculate current token count without modifying state (for checks)
   */
  private calculateCurrentTokens(bucket: TokenBucket): number {
    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    return Math.min(bucket.maxTokens, bucket.tokens + elapsedSeconds * bucket.refillRate);
  }

  /**
   * Refill tokens and reset counters - only call when consuming
   */
  private refillAndConsume(bucket: TokenBucket): boolean {
    const now = Date.now();
    // Calculate current tokens with refill
    bucket.tokens = this.calculateCurrentTokens(bucket);
    bucket.lastRefill = now;

    // Reset minute/hour counters if needed
    if (now > bucket.minuteResetAt) {
      bucket.requestsThisMinute = 0;
      bucket.minuteResetAt = now + 60000;
    }
    if (now > bucket.hourResetAt) {
      bucket.requestsThisHour = 0;
      bucket.hourResetAt = now + 3600000;
    }

    // Check if we can consume
    if (bucket.tokens < 1) {
      return false;
    }

    // Consume token
    bucket.tokens -= 1;
    bucket.requestsThisMinute++;
    bucket.requestsThisHour++;
    return true;
  }

  /**
   * Try to consume a token (returns true if successful)
   * This is the ONLY method that modifies bucket state
   */
  tryConsume(providerName: string): boolean {
    const bucket = this.getBucket(providerName);
    const config = this.getConfig(providerName);
    const now = Date.now();

    // Check hard block first
    if (bucket.blockedUntil > now) {
      return false;
    }

    // Check hourly limit (using potentially stale counter, but safe)
    if (now <= bucket.hourResetAt && bucket.requestsThisHour >= config.perHour) {
      return false;
    }

    // Refill and consume atomically
    return this.refillAndConsume(bucket);
  }

  /**
   * Check if provider is available (without consuming or modifying state)
   */
  isAvailable(providerName: string): boolean {
    const bucket = this.getBucket(providerName);
    const config = this.getConfig(providerName);
    const now = Date.now();

    // Check hard block
    if (bucket.blockedUntil > now) return false;

    // Check hourly limit (reset if expired)
    const hourlyRequestCount = now > bucket.hourResetAt ? 0 : bucket.requestsThisHour;
    if (hourlyRequestCount >= config.perHour) return false;

    // Calculate current tokens without modifying state
    const simulatedTokens = this.calculateCurrentTokens(bucket);

    return simulatedTokens >= 1;
  }

  /**
   * Get time until provider is available (without modifying state)
   */
  getWaitTime(providerName: string): number {
    const bucket = this.getBucket(providerName);
    const config = this.getConfig(providerName);
    const now = Date.now();

    // If blocked, return block time
    if (bucket.blockedUntil > now) {
      return bucket.blockedUntil - now;
    }

    // Calculate current tokens without modifying state
    const currentTokens = this.calculateCurrentTokens(bucket);
    const hourlyRequestCount = now > bucket.hourResetAt ? 0 : bucket.requestsThisHour;

    // If we have tokens and under hourly limit, no wait
    if (currentTokens >= 1 && hourlyRequestCount < config.perHour) {
      return 0;
    }

    // Calculate time until next token
    if (currentTokens < 1) {
      const tokensNeeded = 1 - currentTokens;
      return Math.ceil((tokensNeeded / bucket.refillRate) * 1000);
    }

    // Hit hourly limit - wait until reset
    return Math.max(0, bucket.hourResetAt - now);
  }

  /**
   * Record a rate limit error with exponential backoff
   */
  recordError(providerName: string, errorType: string): void {
    const bucket = this.getBucket(providerName);
    const config = this.getConfig(providerName);

    bucket.consecutiveErrors++;
    bucket.lastErrorType = errorType;

    // Calculate backoff with jitter
    const backoffMs = calculateBackoff(config.baseBackoffMs, bucket.consecutiveErrors - 1);

    bucket.blockedUntil = Date.now() + backoffMs;
    bucket.tokens = 0; // Empty the bucket on error

    logger.warn(
      {
        provider: providerName,
        errorType,
        backoffSeconds: Math.ceil(backoffMs / 1000),
        consecutiveErrors: bucket.consecutiveErrors,
      },
      "[TokenBucket] Provider blocked with exponential backoff"
    );
  }

  /**
   * Record successful request (reset error counter)
   */
  recordSuccess(providerName: string): void {
    const bucket = this.getBucket(providerName);
    bucket.consecutiveErrors = 0;
    bucket.lastErrorType = undefined;
  }

  /**
   * Get stats for all providers (without modifying state)
   */
  getProviderStats(providerNames: string[]): QueueStats["providers"] {
    const now = Date.now();

    return providerNames.map(name => {
      const bucket = this.getBucket(name);
      const config = this.getConfig(name);

      // Calculate current tokens without modifying state
      const currentTokens = this.calculateCurrentTokens(bucket);
      const hourlyRequestCount = now > bucket.hourResetAt ? 0 : bucket.requestsThisHour;
      const minuteRequestCount = now > bucket.minuteResetAt ? 0 : bucket.requestsThisMinute;

      const isBlocked = bucket.blockedUntil > now;
      const hasTokens = currentTokens >= 1;
      const underHourLimit = hourlyRequestCount < config.perHour;
      const available = !isBlocked && hasTokens && underHourLimit;

      let waitTimeSeconds = 0;
      let status = "ready";

      if (isBlocked) {
        waitTimeSeconds = Math.ceil((bucket.blockedUntil - now) / 1000);
        status = `blocked (${bucket.lastErrorType || "error"})`;
      } else if (!hasTokens) {
        waitTimeSeconds = Math.ceil((1 - currentTokens) / bucket.refillRate);
        status = "refilling";
      } else if (!underHourLimit) {
        waitTimeSeconds = Math.ceil((bucket.hourResetAt - now) / 1000);
        status = "hourly limit";
      }

      return {
        name,
        available,
        tokens: Math.floor(currentTokens * 10) / 10, // Round to 1 decimal
        maxTokens: bucket.maxTokens,
        requestsThisMinute: minuteRequestCount,
        requestsThisHour: hourlyRequestCount,
        blockedUntil: isBlocked ? bucket.blockedUntil : null,
        waitTimeSeconds: Math.max(0, waitTimeSeconds),
        status,
      };
    });
  }
}

// ============================================================================
// Priority Queue with Aging
// ============================================================================

class PriorityQueueManager {
  private readonly queue: QueuedRequest[] = [];
  private completedCount = 0;
  private failedCount = 0;

  /**
   * Add request to queue with priority ordering
   */
  enqueue(request: QueuedRequest): number {
    // Calculate initial effective priority
    request.effectivePriority = request.priority;

    // Binary search for insertion point
    let left = 0;
    let right = this.queue.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      this.updateEffectivePriority(this.queue[mid]);

      if (this.queue[mid].effectivePriority > request.effectivePriority) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }

    this.queue.splice(left, 0, request);
    return left + 1; // 1-based position
  }

  /**
   * Update effective priority based on age (prevents starvation)
   * Clamps to MIN_EFFECTIVE_PRIORITY to prevent negative values breaking sort
   */
  private updateEffectivePriority(request: QueuedRequest): void {
    const ageSeconds = (Date.now() - request.addedAt) / 1000;
    // Lower priority number = higher priority
    // Subtract age factor to boost priority over time, but clamp to minimum
    const aged = request.priority - ageSeconds * PRIORITY_AGE_FACTOR;
    request.effectivePriority = Math.max(MIN_EFFECTIVE_PRIORITY, aged);
  }

  /**
   * Get next request that's ready to process
   */
  dequeue(): QueuedRequest | null {
    const now = Date.now();

    // Re-sort by effective priority (with aging applied)
    this.queue.forEach(r => this.updateEffectivePriority(r));
    this.queue.sort((a, b) => a.effectivePriority - b.effectivePriority);

    // Find first request that's not in backoff
    const index = this.queue.findIndex(r => !r.backoffUntil || r.backoffUntil <= now);

    if (index === -1) return null;

    return this.queue.splice(index, 1)[0];
  }

  /**
   * Peek at next available request without removing
   */
  peek(): QueuedRequest | null {
    const now = Date.now();
    this.queue.forEach(r => this.updateEffectivePriority(r));
    this.queue.sort((a, b) => a.effectivePriority - b.effectivePriority);

    return this.queue.find(r => !r.backoffUntil || r.backoffUntil <= now) || null;
  }

  /**
   * Return request to queue (for retry)
   */
  requeue(request: QueuedRequest): void {
    // Update effective priority and re-insert
    this.updateEffectivePriority(request);
    this.enqueue(request);
  }

  /**
   * Record completion
   */
  recordComplete(): void {
    this.completedCount++;
  }

  /**
   * Record failure
   */
  recordFailure(): void {
    this.failedCount++;
  }

  get length(): number {
    return this.queue.length;
  }

  get completed(): number {
    return this.completedCount;
  }

  get failed(): number {
    return this.failedCount;
  }

  /**
   * Clear all requests
   */
  clear(): QueuedRequest[] {
    const cleared = this.queue.splice(0);
    return cleared;
  }
}

// ============================================================================
// AI Request Queue Class
// ============================================================================

class AIRequestQueue {
  private readonly priorityQueue = new PriorityQueueManager();
  private readonly rateLimiter = new TokenBucketRateLimiter();
  private activeRequests = 0;
  private processTimer: NodeJS.Timeout | null = null;
  private requestCounter = 0;

  constructor() {
    this.startProcessing();
  }

  /**
   * Add a request to the queue
   */
  async enqueue(
    options: AICompletionOptions,
    priority: RequestPriority = RequestPriority.NORMAL,
    preferredProvider?: string
  ): Promise<AICompletionResult> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest = {
        id: `req_${++this.requestCounter}_${Date.now()}`,
        options,
        priority,
        effectivePriority: priority,
        addedAt: Date.now(),
        resolve,
        reject,
        retries: 0,
        maxRetries: MAX_RETRIES,
        preferredProvider,
      };

      const position = this.priorityQueue.enqueue(request);

      logger.info(
        {
          requestId: request.id,
          queuePosition: position,
          queueLength: this.priorityQueue.length,
          priority: RequestPriority[priority] || priority,
        },
        "[Queue] Request added to priority queue"
      );
    });
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    const providers = getAllUnifiedProviders();
    const providerStats = this.rateLimiter.getProviderStats(providers.map(p => p.name));

    // Calculate estimated wait time
    const availableProviders = providerStats.filter(p => p.available).length;
    const avgRequestTime = 3; // seconds per request

    let estimatedWaitSeconds: number;
    if (availableProviders > 0) {
      estimatedWaitSeconds = Math.ceil(
        (this.priorityQueue.length * avgRequestTime) /
          Math.max(availableProviders, MAX_CONCURRENT_REQUESTS)
      );
    } else {
      const minWait = Math.min(...providerStats.map(p => p.waitTimeSeconds));
      estimatedWaitSeconds = minWait + this.priorityQueue.length * avgRequestTime;
    }

    const estimatedWait =
      estimatedWaitSeconds < 60
        ? `${estimatedWaitSeconds} seconds`
        : `${Math.ceil(estimatedWaitSeconds / 60)} minutes`;

    return {
      queueLength: this.priorityQueue.length,
      processing: this.activeRequests > 0,
      activeRequests: this.activeRequests,
      completedRequests: this.priorityQueue.completed,
      failedRequests: this.priorityQueue.failed,
      providers: providerStats,
      estimatedWaitSeconds,
      estimatedWait,
    };
  }

  /**
   * Get the best available provider
   */
  private getBestProvider(preferredProvider?: string): UnifiedAIProvider | null {
    const providers = getAllUnifiedProviders();

    // Try preferred provider first
    if (preferredProvider) {
      const preferred = providers.find(p => p.name === preferredProvider);
      if (preferred && this.rateLimiter.tryConsume(preferred.name)) {
        return preferred;
      }
    }

    // Find first available provider (already sorted by priority)
    for (const provider of providers) {
      if (this.rateLimiter.tryConsume(provider.name)) {
        return provider;
      }
    }

    return null;
  }

  /**
   * Start queue processing
   */
  private startProcessing(): void {
    if (this.processTimer) return;

    this.processTimer = setInterval(() => {
      this.processNext();
    }, QUEUE_PROCESS_INTERVAL_MS);
  }

  /**
   * Process next request in queue
   */
  private async processNext(): Promise<void> {
    // Check concurrent limit
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS) return;
    if (this.priorityQueue.length === 0) return;

    // Peek at next request
    const nextRequest = this.priorityQueue.peek();
    if (!nextRequest) return;

    // Try to get a provider
    const provider = this.getBestProvider(nextRequest.preferredProvider);
    if (!provider) return;

    // Actually dequeue the request
    const request = this.priorityQueue.dequeue();
    if (!request) return;

    this.activeRequests++;

    try {
      logger.info(
        {
          requestId: request.id,
          provider: provider.name,
          remainingQueue: this.priorityQueue.length,
          priority: RequestPriority[request.priority] || request.priority,
          retries: request.retries,
        },
        "[Queue] Processing request"
      );

      const result = await provider.generateCompletion(request.options);

      this.rateLimiter.recordSuccess(provider.name);
      this.priorityQueue.recordComplete();
      request.resolve(result);
    } catch (error: any) {
      const errorType = categorizeError(error);

      logger.error(
        {
          requestId: request.id,
          provider: provider.name,
          errorType,
          error: error.message,
          retries: request.retries,
        },
        "[Queue] Request failed"
      );

      if (errorType === "rate_limit") {
        this.rateLimiter.recordError(provider.name, errorType);
      }

      // Retry logic with exponential backoff
      if (request.retries < request.maxRetries && errorType !== "client_error") {
        request.retries++;
        request.lastError = error.message;

        // Calculate backoff for request retry
        const config =
          PROVIDER_CONFIG[provider.name as keyof typeof PROVIDER_CONFIG] || PROVIDER_CONFIG.default;
        const backoffMs = calculateBackoff(config.baseBackoffMs, request.retries - 1, 60000);
        request.backoffUntil = Date.now() + backoffMs;

        logger.info(
          {
            requestId: request.id,
            retry: request.retries,
            maxRetries: request.maxRetries,
            backoffSeconds: Math.ceil(backoffMs / 1000),
          },
          "[Queue] Request re-queued with backoff"
        );

        this.priorityQueue.requeue(request);
      } else {
        this.priorityQueue.recordFailure();
        request.reject(
          new Error(`Request failed after ${request.retries} retries: ${error.message}`)
        );
      }
    } finally {
      this.activeRequests--;
    }
  }

  /**
   * Clear the queue
   */
  clear(): void {
    const rejected = this.priorityQueue.clear();
    rejected.forEach(r => r.reject(new Error("Queue cleared")));
    logger.info({ clearedCount: rejected.length }, "[Queue] Queue cleared");
  }

  /**
   * Stop processing
   */
  stop(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const aiQueue = new AIRequestQueue();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Options for queued AI requests with category enforcement
 * PHASE 14: All AI calls MUST specify an explicit category
 */
export interface QueuedAIRequestOptions {
  category: AITaskCategory; // REQUIRED: Task category for governance
  priority?: RequestPriority | number;
  preferredProvider?: string;
}

/**
 * AI task rejection error
 * PHASE 14: Structured rejection for visibility
 */
export class AITaskRejectionError extends Error {
  constructor(
    public taskId: string,
    public category: AITaskCategory,
    public reason: string,
    public provider?: string
  ) {
    super(`[AI] Task rejected: ${reason}`);
    this.name = "AITaskRejectionError";

    // PHASE 14: Structured log event for rejections
    logger.warn(
      {
        taskId,
        provider: provider || "unknown",
        category,
        reason,
      },
      "[AI] Task rejected"
    );
  }
}

/**
 * Make an AI request through the queue
 * PHASE 14: Now requires explicit category
 */
export async function queuedAIRequest(
  options: AICompletionOptions,
  priority: RequestPriority | number = RequestPriority.NORMAL,
  preferredProvider?: string,
  category: AITaskCategory = "internal"
): Promise<AICompletionResult> {
  // PHASE 14: Log if category is missing (default to 'internal' but warn)
  if (!category || category === "internal") {
    logger.warn(
      {
        priority,
        preferredProvider,
      },
      "[Queue] AI request missing explicit category - defaulting to internal"
    );
  }

  return await aiQueue.enqueue(options, priority as RequestPriority, preferredProvider);
}

/**
 * Make an AI request with explicit category (recommended)
 * PHASE 14: Use this function for all new code
 */
export async function categorizedAIRequest(
  options: AICompletionOptions,
  requestOptions: QueuedAIRequestOptions
): Promise<AICompletionResult> {
  const { category, priority = RequestPriority.NORMAL, preferredProvider } = requestOptions;

  // PHASE 14: Validate category
  const validCategories: AITaskCategory[] = [
    "news",
    "evergreen",
    "enrichment",
    "content",
    "translation",
    "image",
    "research",
    "localization",
    "seo",
    "internal",
  ];

  if (!validCategories.includes(category)) {
    const taskId = `req_${Date.now()}_validation`;
    throw new AITaskRejectionError(
      taskId,
      category,
      `Invalid category "${category}". Valid: ${validCategories.join(", ")}`
    );
  }

  logger.info(
    {
      category,
      priority: RequestPriority[priority as RequestPriority] || priority,
      preferredProvider,
    },
    "[Queue] Categorized AI request queued"
  );

  return await aiQueue.enqueue(options, priority as RequestPriority, preferredProvider);
}

/**
 * Get queue status
 */
export function getQueueStats(): QueueStats {
  return aiQueue.getStats();
}

/**
 * Batch multiple requests with same priority
 */
export async function batchQueuedRequests(
  requests: { options: AICompletionOptions; preferredProvider?: string }[],
  priority: RequestPriority = RequestPriority.BATCH
): Promise<AICompletionResult[]> {
  const promises = requests.map(r => aiQueue.enqueue(r.options, priority, r.preferredProvider));
  return await Promise.all(promises);
}

/**
 * Clear all pending requests
 */
export function clearQueue(): void {
  aiQueue.clear();
}
