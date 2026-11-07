/**
 * The news-duplicate check as wired into the Gatekeeper pipeline: a repeat of
 * a story written in the last 21 days is skipped before Gate 1 (no evaluation
 * cost, no write job); a new story goes on to Gate 1 as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  recent: [] as Array<Record<string, unknown>>,
  unprocessed: [] as Array<Record<string, unknown>>,
  executed: [] as string[],
  processed: [] as string[],
  jobs: [] as Array<{ type: string; data: Record<string, unknown> }>,
  evaluated: [] as string[],
}));

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown })?.value;
      return Array.isArray(value) ? value.join("") : typeof chunk === "string" ? chunk : "";
    })
    .join(" ");
}

vi.mock("../../db.js", () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      state.executed.push(text);
      if (text.includes("UNION ALL")) return state.recent;
      return [];
    }),
    query: { contents: { findFirst: vi.fn() } },
  },
}));
vi.mock("../../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../job-queue.js", () => ({
  jobQueue: {
    addJob: vi.fn(async (type: string, data: Record<string, unknown>) => {
      state.jobs.push({ type, data });
    }),
  },
  JobType: {},
}));
vi.mock("../rss-reader.js", () => ({
  rssReader: {
    getUnprocessedItems: vi.fn(async () => state.unprocessed),
    markProcessed: vi.fn(async (id: string) => {
      state.processed.push(id);
    }),
  },
}));
vi.mock("./gate1-selector.js", () => ({
  getGate1Selector: () => ({
    evaluate: vi.fn(async (input: { feedItemId: string }) => {
      state.evaluated.push(input.feedItemId);
      return {
        feedItemId: input.feedItemId,
        seoAnalysis: { score: 80 },
        aeoAnalysis: { score: 80 },
        viralityAnalysis: { score: 80 },
        totalScore: 80,
        tier: "S1",
        decision: "write",
        recommendedWriterId: "w1",
        writerName: "Writer",
        estimatedValue: "high",
        estimatedCost: "low",
        valueMatrixQuadrant: "quick_win",
        reasoning: "ok",
        contentType: "article",
        evaluatedAt: new Date(),
        processingTimeMs: 1,
      };
    }),
  }),
  Gate1Selector: class {},
}));
vi.mock("./gate2-approver.js", () => ({ getGate2Approver: () => ({}), Gate2Approver: class {} }));
vi.mock("../content-quality.js", () => ({ auditContentAgainstCorpus: vi.fn(async () => []) }));
vi.mock("../../quality/gate.js", () => ({ qualityContextFromContent: vi.fn(() => ({})) }));
vi.mock("../../lib/site-inventory.js", () => ({
  siteInventory: vi.fn(async () => ({ paths: [], error: "" })),
  slugsFromPaths: vi.fn(() => []),
}));
vi.mock("../../lib/primary-sources.js", () => ({ usablePrimarySources: vi.fn(() => []) }));

import { GatekeeperOrchestrator } from "./orchestrator.js";

const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe("Gatekeeper pipeline — news duplicate check", () => {
  beforeEach(() => {
    state.executed = [];
    state.processed = [];
    state.jobs = [];
    state.evaluated = [];
    state.recent = [
      {
        feedItemId: "old-1",
        feedTitle: "Harbor Air suspended Northport flights until 30 November",
        title: "Harbor Air suspended Northport flights until 30 November 2026",
        slug: "harbor-air-northport-route-suspended-november",
        primaryKeyword: "harbor air northport",
        at: daysAgo(2),
      },
      {
        feedItemId: null,
        feedTitle: null,
        title: "Rosa Vance at Northport Opera 2026: a new stand-up show",
        slug: "rosa-vance-coming-northport-opera-2026",
        primaryKeyword: null,
        at: daysAgo(15),
      },
    ];
    state.unprocessed = [
      { id: "n1", title: "Harbor Air pauses Northport flights 2026: what happened and what comes next", url: "https://news.example.com/a", summary: "" },
      { id: "n2", title: "Rosa Vance adds two more Northport shows in November", url: "https://whatson.example.org/b", summary: "" },
      { id: "n3", title: "Northport Metro Blue Line opens its first stations", url: "https://citypaper.example.net/c", summary: "" },
      { id: "n4", title: "Northport Metro Blue Line opening date confirmed", url: "https://daily.example.com/d", summary: "" },
    ];
  });

  it("skips repeats before Gate 1 and writes only the new story, once", async () => {
    const orchestrator = new GatekeeperOrchestrator();
    const stats = await orchestrator.runPipeline(10);

    // n1/n2 repeat stories on file; n4 repeats n3, approved earlier in this run.
    expect(state.evaluated).toEqual(["n3"]);
    expect(state.jobs.filter((job) => job.type === "octypo_write").map((job) => job.data.feedItemId)).toEqual(["n3"]);
    expect(stats.itemsSkipped).toBe(3);
    expect(stats.itemsApprovedForWriting).toBe(1);
    expect(state.processed).toEqual(["n1", "n2", "n4"]);
    const skipUpdates = state.executed.filter((text) => text.includes("gate1_decision = 'skip'"));
    expect(skipUpdates).toHaveLength(3);
  });

  it("runs as before when the recent-stories query fails", async () => {
    const { db } = await import("../../db.js");
    (db.execute as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const orchestrator = new GatekeeperOrchestrator();
    await orchestrator.runPipeline(10);
    expect(state.evaluated).toEqual(["n1", "n2", "n3", "n4"]);
  });
});
