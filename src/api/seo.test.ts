/**
 * The gate, tested as a mounted router rather than as a function.
 *
 * This is the one that matters for the fleet: the same codebase runs every
 * customer's install, the DataForSEO account is ours, and an install that is
 * not ours must not reach these routes at all. A unit test of `deskEnabled`
 * would pass even if the middleware were never wired up.
 */
import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { seoRouter } from "./seo.js";

let server: Server | null = null;

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/seo", seoRouter);

  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const address = server!.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  delete process.env.SEO_TOOLS_ENABLED;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
});

describe("the SEO desk routes", () => {
  it("answer 404 on an install where the desk is off", async () => {
    const base = await mount();

    for (const path of ["/status", "/history"]) {
      const res = await fetch(`${base}/api/admin/seo${path}`);
      expect(res.status, path).toBe(404);
    }

    const run = await fetch(`${base}/api/admin/seo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "serp", keyword: "anything" }),
    });
    expect(run.status).toBe(404);
    // No lookup was attempted, so nothing was spent.
    expect(((await run.json()) as { error: string }).error).toMatch(/not enabled/i);
  });

  it("stay closed when the login is present but the flag is not", async () => {
    process.env.DATAFORSEO_LOGIN = "someone";
    process.env.DATAFORSEO_PASSWORD = "secret";
    const base = await mount();

    expect((await fetch(`${base}/api/admin/seo/status`)).status).toBe(404);
  });

  it("reject an unknown tool before anything is bought", async () => {
    process.env.DATAFORSEO_LOGIN = "someone";
    process.env.DATAFORSEO_PASSWORD = "secret";
    process.env.SEO_TOOLS_ENABLED = "1";
    const base = await mount();

    const res = await fetch(`${base}/api/admin/seo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "../../etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("reject a run with a missing input before it costs anything", async () => {
    process.env.DATAFORSEO_LOGIN = "someone";
    process.env.DATAFORSEO_PASSWORD = "secret";
    process.env.SEO_TOOLS_ENABLED = "1";
    const base = await mount();

    const res = await fetch(`${base}/api/admin/seo/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "keyword-gap", target: "example.com" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/domain/i);
  });
});
