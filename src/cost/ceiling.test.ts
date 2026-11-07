import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CostMeter } from "./meter.js";
import {
  SpendCeiling,
  SpendCeilingExceededError,
  DEFAULT_DAILY_CAP_USD,
  resolveDailyCapUsd,
} from "./ceiling.js";

const DAY1 = Date.parse("2026-08-21T10:00:00Z");
const DAY2 = Date.parse("2026-08-22T00:01:00Z");

/** Meter + ceiling wired together on a clock we control. */
function harness(capUsd: number, startMs = DAY1) {
  let now = startMs;
  const logs: Array<{ level: string; msg: string; data?: unknown }> = [];
  const meter = new CostMeter({ now: () => now });
  const ceiling = new SpendCeiling({
    meter,
    now: () => now,
    capUsd: () => capUsd,
    log: (level, msg, data) => logs.push({ level, msg, data }),
  });
  return { meter, ceiling, logs, setNow: (ms: number) => (now = ms) };
}

function spend(meter: CostMeter, usd: number): void {
  // claude-haiku-4-5 input is $1/MTok, so N million input tokens == $N.
  meter.recordModelCall({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: Math.round(usd * 1_000_000),
    outputTokens: 0,
  });
}

describe("SpendCeiling", () => {
  it("allows work while spend is under the cap", () => {
    const { meter, ceiling } = harness(10);
    spend(meter, 4);
    expect(ceiling.isReached()).toBe(false);
    expect(() => ceiling.assertNotReached()).not.toThrow();
    const state = ceiling.getState();
    expect(state.tripped).toBe(false);
    expect(state.remainingUsd).toBeCloseTo(6, 8);
    expect(state.pctUsed).toBeCloseTo(40, 6);
  });

  it("STOPS work once the cap is reached", () => {
    const { meter, ceiling } = harness(10);
    spend(meter, 10);
    expect(ceiling.isReached()).toBe(true);
    expect(() => ceiling.assertNotReached()).toThrow(SpendCeilingExceededError);
  });

  it("stops work when the cap is overshot by a single expensive call", () => {
    const { meter, ceiling } = harness(1);
    expect(ceiling.isReached()).toBe(false);
    spend(meter, 1.5);
    expect(ceiling.isReached()).toBe(true);
  });

  it("logs at ERROR level when it trips, and only once — not on every check", () => {
    const { meter, ceiling, logs } = harness(10);
    spend(meter, 11);
    ceiling.isReached();
    ceiling.isReached();
    ceiling.isReached();
    const errors = logs.filter(l => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toMatch(/spend/i);
  });

  it("warns once before the cap, so someone can react before work stops", () => {
    const { meter, ceiling, logs } = harness(10);
    spend(meter, 8.5);
    ceiling.isReached();
    ceiling.isReached();
    const warns = logs.filter(l => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(logs.filter(l => l.level === "error")).toHaveLength(0);
  });

  it("does NOT crash the process — the tripped state is a value, not an exit", () => {
    const { meter, ceiling } = harness(1);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    spend(meter, 5);
    expect(ceiling.isReached()).toBe(true);
    expect(ceiling.getState().tripped).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("exposes a state a dashboard can read without side effects", () => {
    const { meter, ceiling, logs } = harness(10);
    spend(meter, 12);
    const state = ceiling.getState();
    expect(state).toMatchObject({ tripped: true, capUsd: 10 });
    expect(state.spentUsd).toBeCloseTo(12, 8);
    expect(state.remainingUsd).toBe(0);
    expect(state.day).toBe("2026-08-21");
    expect(state.trippedAt).not.toBeNull();
    // Reading state must not emit the alarm — otherwise a polling dashboard
    // becomes a log flood.
    expect(logs).toHaveLength(0);
  });

  it("clears itself at the next UTC day, and can alarm again", () => {
    const { meter, ceiling, logs, setNow } = harness(10);
    spend(meter, 11);
    expect(ceiling.isReached()).toBe(true);

    setNow(DAY2);
    expect(ceiling.isReached()).toBe(false);
    expect(ceiling.getState().spentUsd).toBe(0);

    spend(meter, 11);
    expect(ceiling.isReached()).toBe(true);
    expect(logs.filter(l => l.level === "error")).toHaveLength(2);
  });

  it("carries the numbers on the thrown error so the caller can report them", () => {
    const { meter, ceiling } = harness(2);
    spend(meter, 3);
    try {
      ceiling.assertNotReached();
      throw new Error("expected assertNotReached to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SpendCeilingExceededError);
      const e = err as SpendCeilingExceededError;
      expect(e.capUsd).toBe(2);
      expect(e.spentUsd).toBeCloseTo(3, 8);
      expect(e.day).toBe("2026-08-21");
    }
  });
});

describe("resolveDailyCapUsd", () => {
  const original = process.env.OCTYPO_DAILY_COST_CAP_USD;

  beforeEach(() => {
    delete process.env.OCTYPO_DAILY_COST_CAP_USD;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OCTYPO_DAILY_COST_CAP_USD;
    else process.env.OCTYPO_DAILY_COST_CAP_USD = original;
  });

  it("uses the documented default when unset — never unlimited", () => {
    expect(resolveDailyCapUsd()).toBe(DEFAULT_DAILY_CAP_USD);
    expect(Number.isFinite(DEFAULT_DAILY_CAP_USD)).toBe(true);
    expect(DEFAULT_DAILY_CAP_USD).toBeGreaterThan(0);
  });

  it("honours a configured cap", () => {
    process.env.OCTYPO_DAILY_COST_CAP_USD = "3.5";
    expect(resolveDailyCapUsd()).toBe(3.5);
  });

  it("falls back to the default on garbage config rather than running uncapped", () => {
    for (const bad of ["", "  ", "abc", "-1", "0", "NaN", "Infinity"]) {
      process.env.OCTYPO_DAILY_COST_CAP_USD = bad;
      expect(resolveDailyCapUsd(), `value ${JSON.stringify(bad)}`).toBe(DEFAULT_DAILY_CAP_USD);
    }
  });
});
