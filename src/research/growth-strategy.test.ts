import { describe, expect, it } from "vitest";
import { decideGrowthAction, growthConfigFromEnv, parseGrowthSeeds } from "./growth-strategy.js";

const summary = (planned: number, total = planned) => ({ planned, queued: 0, written: 0, skipped: 0, total });

describe("growth strategy", () => {
  it("parses unique seeds from CSV or JSON", () => {
    expect(parseGrowthSeeds("flights, hotels,flights\nreal estate")).toEqual([
      "flights", "hotels", "real estate",
    ]);
    expect(parseGrowthSeeds('["flights to lisbon","lisbon real estate"]')).toEqual([
      "flights to lisbon", "lisbon real estate",
    ]);
  });

  it("uses a healthy two-per-week default instead of bulk publishing", () => {
    const config = growthConfigFromEnv({ ENABLE_GROWTH_PLANNER: "true", GROWTH_SEEDS: "lisbon" });
    expect(config.articlesPerWeek).toBe(2);
    expect(decideGrowthAction(summary(0, 0), config)).toMatchObject({ action: "bootstrap", target: 52 });
  });

  it("replenishes only when the reserve falls below six weeks", () => {
    const config = growthConfigFromEnv({ ENABLE_GROWTH_PLANNER: "true", GROWTH_SEEDS: "lisbon" });
    expect(decideGrowthAction(summary(11, 20), config).action).toBe("replenish");
    expect(decideGrowthAction(summary(12, 20), config).action).toBe("idle");
  });

  it("blocks research when the site has no declared seeds", () => {
    expect(decideGrowthAction(summary(0, 0), growthConfigFromEnv({ ENABLE_GROWTH_PLANNER: "true" }))).toMatchObject({
      action: "blocked",
      reason: "missing-growth-seeds",
    });
  });

  it("stays off by default on every non-beta install", () => {
    expect(decideGrowthAction(summary(0, 0), growthConfigFromEnv({ GROWTH_SEEDS: "lisbon" }))).toMatchObject({
      action: "idle",
      reason: "planner-disabled",
    });
  });
});
