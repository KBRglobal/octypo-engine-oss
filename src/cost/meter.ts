import { currentArticleId } from "./context.js";
import { priceImageGeneration, priceModelCall } from "./prices.js";

/**
 * COST METER — records what every model call and every generated image actually
 * cost, using the token counts the providers return.
 *
 * WHY it exists: Octypo is sold on a margin (~EUR 0.11 marginal cost per
 * published article). Before this, nothing measured that number and nothing
 * would notice a provider having a bad day. The meter is the measurement half;
 * `ceiling.ts` is the enforcement half that reads it.
 *
 * Design notes:
 *  - It is in-process and deliberately dependency-free, so recording a cost can
 *    never fail because a database is down. Losing the ledger on restart is
 *    acceptable; blocking generation on it is not.
 *  - Spend is bucketed per UTC day, which is also the unit the ceiling caps.
 *  - Buckets are bounded (see MAX_TRACKED_DAYS / MAX_TRACKED_ARTICLES) so a
 *    long-running server cannot leak memory through the meter.
 */

/** Money is kept in USD because that is what every provider bills in. */
export interface CostRecord {
  /** "research" is a paid third-party lookup: no tokens, a price per call. */
  kind: "model" | "image" | "research";
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  images: number;
  costUsd: number;
  /** true when the price used carries no current vendor quote (retired model). */
  unverifiedPrice: boolean;
  articleId: string | null;
  at: number;
  day: string;
}

export interface ModelCallInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Overrides the async context; leave unset to inherit it. */
  articleId?: string;
  engineId?: string;
}

export interface ImageInput {
  model: string;
  size: string;
  quality: string;
  count?: number;
  articleId?: string;
}

export interface ArticleBreakdown {
  articleId: string;
  calls: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEur: number;
}

export interface CostSnapshot {
  day: string;
  spentTodayUsd: number;
  spentTodayEur: number;
  usdToEurRate: number;
  calls: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  /** Spend priced from a figure the vendor no longer publishes — treat as soft. */
  unverifiedCostUsd: number;
  /** Calls we could not price at all. Money spent, not measured. */
  unpricedCalls: number;
  unpricedModels: string[];
  /** Calls whose response carried no usage numbers. Money spent, not measured. */
  unmeteredCalls: number;
  topArticles: ArticleBreakdown[];
  recent: CostRecord[];
}

interface DayBucket {
  day: string;
  costUsd: number;
  calls: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  byProvider: Map<string, number>;
  byModel: Map<string, number>;
  unverifiedCostUsd: number;
  unpricedCalls: number;
  unpricedModels: Set<string>;
  unmeteredCalls: number;
}

interface ArticleBucket {
  calls: number;
  images: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostMeterOptions {
  /** Injectable clock — the tests drive day rollover with it. */
  now?: () => number;
  /** Called for every priced record; the singleton wires this to the logger. */
  onRecord?: (record: CostRecord) => void;
  /** USD -> EUR rate for reporting. */
  usdToEur?: () => number;
}

/**
 * USD -> EUR conversion for reporting only (the business quotes its margin in
 * EUR; providers bill in USD).
 *
 * Source: ECB euro foreign exchange reference rate for 2026-08-21,
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml — EUR 1 = USD
 * 1.1699, so USD 1 = EUR 0.8548. This is a spot rate on one day, not the rate
 * your card issuer actually charged: set OCTYPO_USD_EUR_RATE to the rate
 * accounting uses before quoting EUR figures to anyone outside engineering.
 */
export const DEFAULT_USD_TO_EUR = 0.8548;

export function resolveUsdToEur(): number {
  const raw = process.env.OCTYPO_USD_EUR_RATE;
  if (raw === undefined) return DEFAULT_USD_TO_EUR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USD_TO_EUR;
  return parsed;
}

/** UTC day key. UTC, not local time, so a server move cannot shift the cap window. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class CostMeter {
  /** ~6 weeks: enough to answer "what did this customer cost us last month". */
  static readonly MAX_TRACKED_DAYS = 45;
  /** Bounded article ledger; oldest entries are evicted first. */
  static readonly MAX_TRACKED_ARTICLES = 20_000;
  /** Small ring of raw records, for eyeballing what the engine just did. */
  static readonly MAX_RECENT_RECORDS = 200;

  private readonly now: () => number;
  private readonly onRecord?: (record: CostRecord) => void;
  private readonly usdToEur: () => number;

  private readonly days = new Map<string, DayBucket>();
  private readonly articles = new Map<string, ArticleBucket>();
  private recent: CostRecord[] = [];

  constructor(options: CostMeterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onRecord = options.onRecord;
    this.usdToEur = options.usdToEur ?? resolveUsdToEur;
  }

  // ---- recording -------------------------------------------------------

  /**
   * Record one model call. Token counts MUST be the ones the provider returned;
   * estimating them would defeat the purpose of the meter.
   *
   * Throws UnknownModelPriceError if the model is not in the price table — a
   * loud failure is the only honest response to "we spent money and cannot say
   * how much". Call sites that must not lose already-paid-for work catch it and
   * call `recordUnpriced` so the gap is still visible.
   */
  recordModelCall(input: ModelCallInput): CostRecord {
    const priced = priceModelCall(
      input.provider,
      input.model,
      input.inputTokens,
      input.outputTokens
    );
    return this.commit({
      kind: "model",
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      images: 0,
      costUsd: priced.costUsd,
      unverifiedPrice: priced.price.unverified === true,
      articleId: input.articleId ?? currentArticleId() ?? null,
    });
  }

  /** Record generated images — the biggest single line item in an article. */
  recordImage(input: ImageInput): CostRecord {
    const count = input.count ?? 1;
    const priced = priceImageGeneration(input.model, input.size, input.quality, count);
    return this.commit({
      kind: "image",
      provider: "openai",
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      images: count,
      costUsd: priced.costUsd,
      unverifiedPrice: false,
      articleId: input.articleId ?? currentArticleId() ?? null,
    });
  }

  /**
   * A call we were billed for but could not price (model missing from the
   * table). Recorded as a counter, never as zero cost — a zero would look like
   * a free call and quietly flatter the margin.
   */
  recordUnpriced(input: { provider: string; model: string; reason?: string }): void {
    const bucket = this.bucketFor(this.now());
    bucket.unpricedCalls++;
    bucket.unpricedModels.add(`${input.provider}/${input.model}`);
  }

  /**
   * A call whose response carried no usage numbers. Same reasoning as
   * `recordUnpriced`: money left the account, we just cannot size it.
   */
  recordUnmetered(input: { provider: string; model: string; reason?: string }): void {
    this.bucketFor(this.now()).unmeteredCalls++;
  }

  private commit(partial: Omit<CostRecord, "at" | "day">): CostRecord {
    const at = this.now();
    const day = dayKey(at);
    const record: CostRecord = { ...partial, at, day };

    const bucket = this.bucketFor(at);
    bucket.costUsd += record.costUsd;
    bucket.inputTokens += record.inputTokens;
    bucket.outputTokens += record.outputTokens;
    if (record.kind === "image") bucket.images += record.images;
    else bucket.calls++;
    if (record.unverifiedPrice) bucket.unverifiedCostUsd += record.costUsd;
    bucket.byProvider.set(
      record.provider,
      (bucket.byProvider.get(record.provider) ?? 0) + record.costUsd
    );
    const modelKey = `${record.provider}/${record.model}`;
    bucket.byModel.set(modelKey, (bucket.byModel.get(modelKey) ?? 0) + record.costUsd);

    if (record.articleId) this.creditArticle(record.articleId, record);

    this.recent.push(record);
    if (this.recent.length > CostMeter.MAX_RECENT_RECORDS) {
      this.recent = this.recent.slice(-CostMeter.MAX_RECENT_RECORDS);
    }

    this.onRecord?.(record);
    return record;
  }

  private creditArticle(articleId: string, record: CostRecord): void {
    let bucket = this.articles.get(articleId);
    if (!bucket) {
      bucket = { calls: 0, images: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      this.articles.set(articleId, bucket);
      if (this.articles.size > CostMeter.MAX_TRACKED_ARTICLES) {
        // Map iteration is insertion-ordered, so this drops the oldest article.
        const oldest = this.articles.keys().next();
        if (!oldest.done) this.articles.delete(oldest.value);
      }
    }
    bucket.costUsd += record.costUsd;
    bucket.inputTokens += record.inputTokens;
    bucket.outputTokens += record.outputTokens;
    if (record.kind === "image") bucket.images += record.images;
    else bucket.calls++;
  }

  private bucketFor(at: number): DayBucket {
    const day = dayKey(at);
    let bucket = this.days.get(day);
    if (!bucket) {
      bucket = {
        day,
        costUsd: 0,
        calls: 0,
        images: 0,
        inputTokens: 0,
        outputTokens: 0,
        byProvider: new Map(),
        byModel: new Map(),
        unverifiedCostUsd: 0,
        unpricedCalls: 0,
        unpricedModels: new Set(),
        unmeteredCalls: 0,
      };
      this.days.set(day, bucket);
      this.evictOldDays();
    }
    return bucket;
  }

  private evictOldDays(): void {
    while (this.days.size > CostMeter.MAX_TRACKED_DAYS) {
      // Sorted rather than insertion-ordered: clock skew or a backfill could
      // otherwise evict the newest bucket.
      const oldest = [...this.days.keys()].sort()[0];
      this.days.delete(oldest);
    }
  }

  // ---- reading ---------------------------------------------------------

  /** USD spent so far in the current UTC day. This is what the ceiling caps. */
  spentTodayUsd(): number {
    return this.days.get(dayKey(this.now()))?.costUsd ?? 0;
  }

  spentOnDayUsd(day: string): number {
    return this.days.get(day)?.costUsd ?? 0;
  }

  /** `month` is "YYYY-MM". Only days still in the window are counted. */
  spentInMonthUsd(month: string): number {
    let total = 0;
    for (const [day, bucket] of this.days) {
      if (day.startsWith(`${month}-`)) total += bucket.costUsd;
    }
    return total;
  }

  articleCostUsd(articleId: string): number {
    return this.articles.get(articleId)?.costUsd ?? 0;
  }

  articleBreakdown(articleId: string): ArticleBreakdown {
    const bucket = this.articles.get(articleId) ?? {
      calls: 0,
      images: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    return {
      articleId,
      calls: bucket.calls,
      images: bucket.images,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      costUsd: bucket.costUsd,
      costEur: bucket.costUsd * this.usdToEur(),
    };
  }

  /** Article ledger, most expensive first — "what did this customer cost us". */
  topArticles(limit = 10): ArticleBreakdown[] {
    return [...this.articles.entries()]
      .map(([articleId]) => this.articleBreakdown(articleId))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, limit);
  }

  trackedDayCount(): number {
    return this.days.size;
  }

  /** Everything a dashboard needs, in one read with no side effects. */
  /**
   * Seed today's spend from the durable ledger at boot.
   *
   * Without this a restart wipes the in-memory count and the daily ceiling
   * fails open — the engine could spend the whole cap again mid-day. Called
   * once at startup with the ledger's sum for today.
   */
  restoreTodaySpend(costUsd: number, calls = 0): void {
    if (costUsd <= 0) return;
    const bucket = this.bucketFor(this.now());
    bucket.costUsd += costUsd;
    bucket.calls += calls;
  }

  snapshot(): CostSnapshot {
    const day = dayKey(this.now());
    const bucket = this.days.get(day);
    const rate = this.usdToEur();
    const spentUsd = bucket?.costUsd ?? 0;
    return {
      day,
      spentTodayUsd: spentUsd,
      spentTodayEur: spentUsd * rate,
      usdToEurRate: rate,
      calls: bucket?.calls ?? 0,
      images: bucket?.images ?? 0,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      byProvider: Object.fromEntries(bucket?.byProvider ?? []),
      byModel: Object.fromEntries(bucket?.byModel ?? []),
      unverifiedCostUsd: bucket?.unverifiedCostUsd ?? 0,
      unpricedCalls: bucket?.unpricedCalls ?? 0,
      unpricedModels: [...(bucket?.unpricedModels ?? [])],
      unmeteredCalls: bucket?.unmeteredCalls ?? 0,
      topArticles: this.topArticles(),
      recent: [...this.recent].slice(-20),
    };
  }

  /** Wipes the ledger. Tests and manual recovery only. */
  reset(): void {
    this.days.clear();
    this.articles.clear();
    this.recent = [];
  }
}
