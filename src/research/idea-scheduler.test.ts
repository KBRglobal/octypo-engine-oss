import { beforeEach, describe, expect, it, vi } from "vitest";

const bank = vi.hoisted(() => ({
  planned: [] as Array<{ id: string; targetKeyword: string }>,
  marks: [] as Array<{ id: string; status: string; evidence?: Record<string, unknown> }>,
}));

vi.mock("../db.js", () => ({ db: {} }));
vi.mock("../job-queue.js", () => ({ jobQueue: { addJob: vi.fn() }, JobType: {} }));
vi.mock("../lib/advisory-lock.js", () => ({ withTickLock: vi.fn(), TICK_LOCKS: {} }));
vi.mock("../lib/logger.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./bank-store.js", () => ({
  nextPlannedIdeas: vi.fn(async (limit: number) => bank.planned.slice(0, limit)),
  claimIdeas: vi.fn(),
  markIdea: vi.fn(async (id: string, status: string, _contentId?: string, evidence?: Record<string, unknown>) => {
    bank.marks.push({ id, status, evidence });
    bank.planned = bank.planned.filter((idea) => idea.id !== id);
  }),
}));

import { writableIdeas } from "./idea-scheduler.js";
import { buildCoverageIndex } from "./site-coverage.js";

const coverage = buildCoverageIndex({
  siteGeneric: ["lakeview"],
  pages: [
    {
      url: "https://example.com/ferry-times/",
      path: "/ferry-times/",
      title: "Ferry departure and holiday times in Lakeview: exact times for Lakeview | Lakeview Guide",
      h1: "Ferry departure and holiday times in Lakeview: exact times for Lakeview",
    },
    {
      url: "https://example.com/vegan/",
      path: "/vegan/",
      title: "Vegan food in Lakeview: restaurants, hotel delivery and weekend meals | Lakeview Guide",
      h1: "Vegan food in Lakeview: restaurants, hotel delivery and weekend meals",
    },
  ],
});

describe("writableIdeas", () => {
  beforeEach(() => {
    bank.marks = [];
    bank.planned = [
      { id: "1", targetKeyword: "ferry times in lakeview" },
      { id: "2", targetKeyword: "health insurance lakeview visitors" },
      { id: "3", targetKeyword: "vegan restaurants in lakeview" },
      { id: "4", targetKeyword: "duty free lakeview" },
      { id: "5", targetKeyword: "language schools lakeview" },
    ];
  });

  it("skips covered ideas with the covering URL recorded, and refills the quota", async () => {
    const ideas = await writableIdeas(3, async () => coverage);
    expect(ideas.map((idea) => idea.id)).toEqual(["2", "4", "5"]);
    expect(bank.marks.map((mark) => [mark.id, mark.status])).toEqual([
      ["1", "skipped"],
      ["3", "skipped"],
    ]);
    expect(bank.marks[0].evidence).toMatchObject({
      skipReason: "covered_by_site_page",
      coveredBy: "https://example.com/ferry-times/",
    });
    expect(bank.marks[1].evidence).toMatchObject({ coveredBy: "https://example.com/vegan/" });
  });

  it("blocks nothing when the site cannot be read", async () => {
    const ideas = await writableIdeas(3, async () => null);
    expect(ideas.map((idea) => idea.id)).toEqual(["1", "2", "3"]);
    expect(bank.marks).toHaveLength(0);
  });

  it("returns fewer than the limit when the bank runs out", async () => {
    bank.planned = [
      { id: "1", targetKeyword: "ferry times in lakeview" },
      { id: "2", targetKeyword: "health insurance lakeview visitors" },
    ];
    const ideas = await writableIdeas(3, async () => coverage);
    expect(ideas.map((idea) => idea.id)).toEqual(["2"]);
  });
});
