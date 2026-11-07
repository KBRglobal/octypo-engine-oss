import { CostMeter, dayKey } from "./meter.js";

/**
 * SPEND CEILING — the hard stop.
 *
 * WHY: a provider having a bad day, or a retry storm, could previously run up an
 * unbounded bill with nothing to stop it. This caps spend per UTC day and, once
 * the cap is hit, refuses to hand out an engine at all.
 *
 * Three rules shape the design:
 *  1. It must STOP work. Not warn, not slow down — no engine is returned and
 *     the low-level call path throws before contacting a provider.
 *  2. It must be LOUD. One error-level log the moment it trips, plus a state
 *     object a dashboard or /health can read.
 *  3. It must NOT crash. No process.exit, no unhandled rejection: generation
 *     fails cleanly the same way "all providers unhealthy" already does, and
 *     the service keeps serving reads.
 *
 * The window is a UTC day, so it clears itself at midnight UTC without a
 * restart, and raising OCTYPO_DAILY_COST_CAP_USD takes effect on the next check.
 */

/**
 * Default cap when OCTYPO_DAILY_COST_CAP_USD is unset.
 *
 * Sized against real business volume, not against what the pipeline could
 * theoretically burn. The largest plan is 300 articles/month — about 10 a day —
 * and measured marginal cost is roughly $0.11 per published article, so a normal
 * day costs around $1. $5 leaves generous headroom for retries and catch-up runs
 * while still tripping within hours of a runaway rather than after a full day of
 * burn. Installs that legitimately need more raise it explicitly.
 *
 * There is deliberately no "unlimited" setting: an unset cap is what created
 * this problem.
 */
export const DEFAULT_DAILY_CAP_USD = 5;

/** Fraction of the cap at which a single warning is emitted. */
export const WARN_AT_FRACTION = 0.8;

/** Thrown when a caller tries to spend after the cap has been reached. */
export class SpendCeilingExceededError extends Error {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly day: string;

  constructor(capUsd: number, spentUsd: number, day: string) {
    super(
      `Daily spend ceiling reached: $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} on ${day} (UTC). ` +
        `Generation is stopped until the next UTC day or until OCTYPO_DAILY_COST_CAP_USD is raised.`
    );
    this.name = "SpendCeilingExceededError";
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
    this.day = day;
  }
}

export interface SpendCeilingState {
  day: string;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  pctUsed: number;
  tripped: boolean;
  /** Epoch ms when the cap was first reached today, or null. */
  trippedAt: number | null;
}

export type CeilingLogLevel = "warn" | "error";

export interface SpendCeilingOptions {
  meter: CostMeter;
  now?: () => number;
  /** Read fresh on every check, so a config change lands without a restart. */
  capUsd?: () => number;
  log?: (level: CeilingLogLevel, msg: string, data?: Record<string, unknown>) => void;
}

/**
 * Reads OCTYPO_DAILY_COST_CAP_USD. Anything that is not a positive finite
 * number falls back to the default — a typo in an env var must never be an
 * accidental "no limit", and must never be an accidental "stop everything"
 * either (which is why 0 is rejected rather than honoured).
 */
export function resolveDailyCapUsd(): number {
  const raw = process.env.OCTYPO_DAILY_COST_CAP_USD;
  if (raw === undefined) return DEFAULT_DAILY_CAP_USD;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAILY_CAP_USD;
  return parsed;
}

export class SpendCeiling {
  private readonly meter: CostMeter;
  private readonly now: () => number;
  private readonly capUsd: () => number;
  private readonly log: (
    level: CeilingLogLevel,
    msg: string,
    data?: Record<string, unknown>
  ) => void;

  /** Day the alarms below refer to; resets the state at UTC midnight. */
  private alarmDay: string | null = null;
  private trippedAt: number | null = null;
  private errorLogged = false;
  private warned = false;

  constructor(options: SpendCeilingOptions) {
    this.meter = options.meter;
    this.now = options.now ?? (() => Date.now());
    this.capUsd = options.capUsd ?? resolveDailyCapUsd;
    this.log = options.log ?? (() => undefined);
  }

  /**
   * Is generation stopped right now? This is the method that emits the alarms,
   * exactly once per day each, so calling it on every engine hand-out is cheap
   * and does not flood the logs.
   */
  isReached(): boolean {
    const state = this.observe();

    if (state.tripped) {
      if (!this.errorLogged) {
        this.errorLogged = true;
        this.log("error", "[SpendCeiling] Daily spend ceiling reached — generation stopped", {
          day: state.day,
          capUsd: state.capUsd,
          spentUsd: state.spentUsd,
        });
      }
      return true;
    }

    if (!this.warned && state.pctUsed >= WARN_AT_FRACTION * 100) {
      this.warned = true;
      this.log("warn", "[SpendCeiling] Daily spend approaching the ceiling", {
        day: state.day,
        capUsd: state.capUsd,
        spentUsd: state.spentUsd,
        pctUsed: state.pctUsed,
      });
    }
    return false;
  }

  /** Throws if the ceiling is reached. Used as a backstop at the call site. */
  assertNotReached(): void {
    if (this.isReached()) {
      const state = this.observe();
      throw new SpendCeilingExceededError(state.capUsd, state.spentUsd, state.day);
    }
  }

  /**
   * Read for dashboards, /health and tests. It never logs, so polling it cannot
   * flood the logs and — importantly — cannot swallow the error-level alarm
   * that `isReached()` owns.
   */
  getState(): SpendCeilingState {
    return this.observe();
  }

  /** Clears the latched alarms. Tests and manual recovery only. */
  reset(): void {
    this.alarmDay = null;
    this.trippedAt = null;
    this.errorLogged = false;
    this.warned = false;
  }

  /**
   * Recomputes the state and keeps the latched flags honest: a new UTC day, or
   * a raised cap, un-latches them so a later breach alarms again instead of
   * staying silently tripped.
   */
  private observe(): SpendCeilingState {
    const day = dayKey(this.now());
    if (this.alarmDay !== day) {
      this.alarmDay = day;
      this.trippedAt = null;
      this.errorLogged = false;
      this.warned = false;
    }

    const capUsd = this.capUsd();
    const spentUsd = this.meter.spentOnDayUsd(day);
    const tripped = spentUsd >= capUsd;

    if (tripped) {
      // First observation of the breach stamps the time, whoever observed it.
      if (this.trippedAt === null) this.trippedAt = this.now();
    } else {
      this.trippedAt = null;
      this.errorLogged = false;
    }

    return {
      day,
      capUsd,
      spentUsd,
      remainingUsd: Math.max(0, capUsd - spentUsd),
      pctUsed: capUsd > 0 ? (spentUsd / capUsd) * 100 : 100,
      tripped,
      trippedAt: this.trippedAt,
    };
  }
}
