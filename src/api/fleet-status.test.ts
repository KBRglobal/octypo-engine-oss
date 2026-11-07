import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { requireAdmin } from "./auth.js";
import {
  buildFleetStatus,
  fleetStatusHandler,
  publishedCutoff,
  PUBLISHED_WINDOW_DAYS,
  type FleetStatusDeps,
  type FleetStatusPayload,
} from "./fleet-status.js";

/**
 * The fleet monitor's whole picture of an install comes from this endpoint.
 * A wrong answer here is a client incident nobody hears about — so the auth
 * gate, the payload shape, and the 7-day window all get pinned.
 */

const PASSWORD = "fleet-status-test-password";
const TOKEN = createHmac("sha256", PASSWORD).update("octypo-admin").digest("hex");

const now = new Date();
const fresh = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
const stale = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

// An in-memory stand-in for the contents table: one freshly published row,
// one ancient one. The endpoint must count exactly the fresh one.
const publishedRows = [{ publishedAt: fresh }, { publishedAt: stale }];

// One article due next week and one whose time has already passed. The
// difference matters: a queue with something ahead of it is a healthy drip,
// and a queue with something behind it is a schedule being missed.
const soon = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
const missed = new Date(now.getTime() - 2 * 60 * 60 * 1000);
const scheduledRows = [{ scheduledFor: soon }, { scheduledFor: missed }];

const deps: FleetStatusDeps = {
  getBuildInfo: () => ({ sha: "d".repeat(40), builtAt: "2026-08-23T00:00:00.000Z" }),
  probeDb: async () => true,
  ceilingState: () => ({ tripped: false, spentUsd: 1.25, capUsd: 5 }),
  countPublishedSince: async (cutoff) => publishedRows.filter((r) => r.publishedAt >= cutoff).length,
  nextScheduledAt: async () =>
    scheduledRows.map((r) => r.scheduledFor).sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
  countOverdueScheduled: async (at) => scheduledRows.filter((r) => r.scheduledFor <= at).length,
};

let server: Server;
let base = "";

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = PASSWORD;
  const app = express();
  app.get("/api/admin/fleet-status", requireAdmin, fleetStatusHandler(deps));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("GET /api/admin/fleet-status", () => {
  it("rejects a request without a bearer token", async () => {
    const res = await fetch(`${base}/api/admin/fleet-status`);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(`${base}/api/admin/fleet-status`, {
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });

  it("answers with all four sections behind a valid bearer", async () => {
    const res = await fetch(`${base}/api/admin/fleet-status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetStatusPayload;
    expect(body.version).toBe("d".repeat(40));
    expect(body.builtAt).toBe("2026-08-23T00:00:00.000Z");
    expect(body.db).toBe(true);
    expect(body.ceiling).toEqual({ tripped: false, spentUsd: 1.25, capUsd: 5 });
    expect(body.publishedLast7d).toBe(1); // fresh row counted, 30-day-old row ignored
    // Quiet is only a fault when nothing is queued behind it — so the monitor
    // is given both the next one due and how many are already late.
    expect(body.nextScheduledAt).toBe(missed.toISOString());
    expect(body.overdueScheduled).toBe(1);
  });
});

describe("publishedCutoff", () => {
  it("is exactly the 7-day window", () => {
    const at = new Date("2026-08-23T12:00:00.000Z");
    expect(publishedCutoff(at).toISOString()).toBe("2026-08-16T12:00:00.000Z");
    expect(PUBLISHED_WINDOW_DAYS).toBe(7);
  });
});

describe("site check in the payload", () => {
  it("carries the install-versus-site verdict when a checker is wired", async () => {
    const payload = await buildFleetStatus({
      ...deps,
      siteCheck: async () => ({
        siteUrl: "https://example.com",
        articlePathPrefix: "/insights/",
        sitemapOk: true,
        prefixOk: false,
        observedPrefixes: ["/articles/"],
        pageCount: 74,
        checkedAt: "2026-09-15T08:00:00.000Z",
        error: "",
      }),
    });
    expect(payload.site?.prefixOk).toBe(false);
    expect(payload.site?.observedPrefixes).toEqual(["/articles/"]);
  });

  it("omits the section for a caller without a checker, and survives a checker that throws", async () => {
    expect((await buildFleetStatus(deps)).site).toBeUndefined();
    const payload = await buildFleetStatus({ ...deps, siteCheck: async () => { throw new Error("boom"); } });
    expect(payload.site).toBeUndefined();
    expect(payload.db).toBe(true);
  });

  it("reports articles held in review past a day, and stays quiet without the counter", async () => {
    let asked: Date | null = null;
    const payload = await buildFleetStatus({
      ...deps,
      countHeldSince: async (cutoff) => {
        asked = cutoff;
        return 6;
      },
    });
    expect(payload.heldInReview).toBe(6);
    expect(Date.now() - (asked as unknown as Date).getTime()).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 1000);
    expect((await buildFleetStatus(deps)).heldInReview).toBeUndefined();
  });
});
