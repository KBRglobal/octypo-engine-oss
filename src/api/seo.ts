/**
 * The SEO desk's HTTP surface.
 *
 * Mounted at /api/admin/seo behind requireAdmin. Every route answers 404 when
 * the desk is off, so a customer's install does not advertise a bench that is
 * ours — and the UI hides the section on the same signal.
 *
 * Errors are forwarded with the provider's own message. On a desk where each
 * click is a purchase, "no rows" and "the account is out of money" must never
 * arrive looking the same.
 */

import { Router, type Response } from "express";

import { logger } from "../lib/logger.js";
import { SeoApiError } from "../seo/client.js";
import { deskEnabled, deskStatus, quoteTool, requireClient, runTool } from "../seo/desk.js";
import { markets } from "../seo/markets.js";
import { buildProspectReport } from "../seo/report.js";
import { renderProspectReport } from "../seo/report-html.js";
import { buildWorklist, renderWorklistMarkdown } from "../seo/worklist.js";
import type { ProspectReport } from "../seo/report.js";
import { buildCatalogue, FAMILIES, type Family } from "../seo/catalogue.js";
import { adHocEndpoint, runEndpoint } from "../seo/explorer.js";
import { templateFor } from "../seo/params.js";
import { accountStatus } from "../seo/prices.js";
import { clearCache } from "../seo/store.js";
import { SEO_TOOLS, isSeoToolId, type SeoToolId } from "../seo/tools.js";

export const seoRouter = Router();

function fail(res: Response, error: unknown, fallback: string): void {
  if (error instanceof SeoApiError) {
    res.status(error.status).json({ error: error.message, providerCode: error.providerCode });
    return;
  }
  logger.error({ error }, `[SEO] ${fallback}`);
  res.status(500).json({ error: fallback });
}

/** Off installs answer a plain, honest "not here" rather than a 403. */
seoRouter.use((_req, res, next) => {
  if (!deskEnabled()) {
    res.status(404).json({ error: "The SEO desk is not enabled on this install." });
    return;
  }
  next();
});

// GET /api/admin/seo/status — tools, prices and the account balance.
seoRouter.get("/status", async (_req, res) => {
  try {
    res.json(await deskStatus());
  } catch (error) {
    fail(res, error, "Could not read the SEO desk status.");
  }
});

// GET /api/admin/seo/markets — the countries and their available languages.
seoRouter.get("/markets", async (_req, res) => {
  try {
    res.json({ markets: await markets(requireClient()) });
  } catch (error) {
    fail(res, error, "Could not read the country list.");
  }
});

// GET /api/admin/seo/catalogue — every endpoint the account can call.
seoRouter.get("/catalogue", async (req, res) => {
  try {
    const client = requireClient();
    const account = await accountStatus(client);
    const catalogue = await buildCatalogue(client, account.prices, req.query.refresh === "1");
    res.json(catalogue);
  } catch (error) {
    fail(res, error, "Could not read the endpoint catalogue.");
  }
});

// POST /api/admin/seo/template — a plausible body for one endpoint.
seoRouter.post("/template", async (req, res) => {
  const { path, family, locationCode, languageCode } = req.body ?? {};
  if (typeof path !== "string" || !path.trim()) {
    res.status(400).json({ error: "A path is required." });
    return;
  }
  const endpoint = await resolveEndpoint(path, family);
  res.json({
    endpoint,
    params: templateFor(endpoint, {
      locationCode: typeof locationCode === "number" ? locationCode : undefined,
      languageCode: typeof languageCode === "string" ? languageCode : undefined,
    }),
  });
});

/**
 * POST /api/admin/seo/call — the explorer's one route.
 *
 * Anything in the catalogue, plus anything typed by hand: the body is passed
 * to DataForSEO as given, and its answer comes back whole. The desk does not
 * validate parameters, because it has no schema to validate them against and
 * a wrong guess here would block a call the provider would have accepted.
 */
seoRouter.post("/call", async (req, res) => {
  const { path, family, params, refresh, taskId, locationCode, languageCode } = req.body ?? {};
  if (typeof path !== "string" || !path.trim()) {
    res.status(400).json({ error: "A path is required." });
    return;
  }
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    res.status(400).json({ error: "Parameters must be a JSON object." });
    return;
  }

  try {
    const endpoint = await resolveEndpoint(path, family);
    const run = await runEndpoint(requireClient(), endpoint, (params ?? {}) as Record<string, unknown>, {
      refresh: refresh === true,
      taskId: typeof taskId === "string" ? taskId : undefined,
      market: {
        locationCode: typeof locationCode === "number" ? locationCode : undefined,
        languageCode: typeof languageCode === "string" ? languageCode : undefined,
      },
    });
    res.json({ endpoint, run });
  } catch (error) {
    fail(res, error, "The call failed.");
  }
});

/**
 * The catalogue entry for a path, or a synthesised one.
 *
 * A path the catalogue does not know is still run: the list is six hours old
 * at worst, and refusing an endpoint because our copy of the menu is stale is
 * the failure this desk exists to avoid.
 */
async function resolveEndpoint(path: string, family: unknown) {
  const wanted = path.trim().replace(/^v3\//, "/");
  const guessedFamily = (
    FAMILIES.includes(family as Family) ? family : wanted.split("/").filter(Boolean)[0]
  ) as Family;

  try {
    const client = requireClient();
    const account = await accountStatus(client);
    const { endpoints } = await buildCatalogue(client, account.prices);
    const found = endpoints.find((entry) => entry.path === wanted || entry.path === `/${wanted}`);
    if (found) return found;
  } catch {
    // The catalogue is a convenience here, not a gate.
  }
  return adHocEndpoint(wanted, FAMILIES.includes(guessedFamily) ? guessedFamily : "serp");
}

// POST /api/admin/seo/quote — what one run would cost at this limit.
seoRouter.post("/quote", async (req, res) => {
  const { tool, limit } = req.body ?? {};
  if (!isSeoToolId(tool)) {
    res.status(400).json({ error: "Unknown tool." });
    return;
  }
  const asked = Number(limit);
  const definition = SEO_TOOLS[tool as SeoToolId];
  const rows =
    Number.isFinite(asked) && asked > 0
      ? Math.min(Math.trunc(asked), definition.maxLimit)
      : definition.defaultLimit;

  res.json({ tool, limit: rows, estimateUsd: await quoteTool(tool, rows) });
});

// POST /api/admin/seo/run — the purchase.
seoRouter.post("/run", async (req, res) => {
  const { tool, target, keyword, rival, limit, refresh, locationCode, languageCode } =
    req.body ?? {};
  if (!isSeoToolId(tool)) {
    res.status(400).json({ error: "Unknown tool." });
    return;
  }

  try {
    const run = await runTool(
      tool,
      {
        target: typeof target === "string" ? target : undefined,
        keyword: typeof keyword === "string" ? keyword : undefined,
        rival: typeof rival === "string" ? rival : undefined,
        limit: typeof limit === "number" ? limit : undefined,
        locationCode: typeof locationCode === "number" ? locationCode : undefined,
        languageCode: typeof languageCode === "string" ? languageCode : undefined,
      },
      { refresh: refresh === true }
    );
    res.json(run);
  } catch (error) {
    fail(res, error, "The lookup failed.");
  }
});

/**
 * POST /api/admin/seo/report — build a prospect report and keep it.
 *
 * Stored rather than rebuilt on view: the client opens the link days later,
 * and must see the document that was sent, with the date it carries.
 */
seoRouter.post("/report", async (req, res) => {
  const { domain, clientName, seed, locationCode, languageCode, rivals } = req.body ?? {};
  if (typeof domain !== "string" || !domain.trim()) {
    res.status(400).json({ error: "A domain is required." });
    return;
  }

  try {
    const report = await buildProspectReport(requireClient(), {
      domain,
      clientName: typeof clientName === "string" ? clientName : undefined,
      seed: typeof seed === "string" ? seed : undefined,
      rivals: typeof rivals === "number" ? rivals : undefined,
      market: {
        locationCode: typeof locationCode === "number" ? locationCode : undefined,
        languageCode: typeof languageCode === "string" ? languageCode : undefined,
      },
    });

    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(12).toString("base64url");

    const { db } = await import("../db.js");
    const { seoReports } = await import("../schema/index.js");
    await db.insert(seoReports).values({
      token,
      domain: report.domain,
      clientName: report.clientName,
      seed: typeof seed === "string" ? seed : null,
      payload: report as unknown as Record<string, unknown>,
      costMicroUsd: Math.round(report.costUsd * 1e6),
    });

    res.json({ token, path: `/r/${token}`, report });
  } catch (error) {
    fail(res, error, "Could not build the report.");
  }
});

// GET /api/admin/seo/reports — the ones already built.
seoRouter.get("/reports", async (_req, res) => {
  try {
    const { db } = await import("../db.js");
    const { seoReports } = await import("../schema/index.js");
    const { desc } = await import("drizzle-orm");

    const rows = await db
      .select({
        token: seoReports.token,
        domain: seoReports.domain,
        clientName: seoReports.clientName,
        costMicroUsd: seoReports.costMicroUsd,
        createdAt: seoReports.createdAt,
      })
      .from(seoReports)
      .orderBy(desc(seoReports.createdAt))
      .limit(30);

    res.json({
      reports: rows.map((row) => ({
        token: row.token,
        domain: row.domain,
        clientName: row.clientName,
        costUsd: row.costMicroUsd / 1e6,
        createdAt: row.createdAt?.toISOString() ?? null,
        path: `/r/${row.token}`,
      })),
    });
  } catch (error) {
    fail(res, error, "Could not read the reports.");
  }
});

/**
 * GET /api/admin/seo/report/:token/worklist — what to do about the report.
 *
 * Admin-only and deliberately not under `/r/`: the document is the client's,
 * this is ours. `?format=md` returns the file to hand to whoever does the
 * work; the default is JSON for anything that wants to read it as data.
 */
seoRouter.get("/report/:token/worklist", async (req, res) => {
  try {
    const { db } = await import("../db.js");
    const { seoReports } = await import("../schema/index.js");
    const { eq } = await import("drizzle-orm");

    const [row] = await db
      .select()
      .from(seoReports)
      .where(eq(seoReports.token, req.params.token))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "No such report." });
      return;
    }

    const worklist = buildWorklist(row.payload as unknown as ProspectReport);
    if (req.query.format === "md") {
      res.type("text/markdown; charset=utf-8").send(renderWorklistMarkdown(worklist));
      return;
    }
    res.json(worklist);
  } catch (error) {
    fail(res, error, "Could not build the work list.");
  }
});

// GET /api/admin/seo/history — what this desk has already bought.
seoRouter.get("/history", async (_req, res) => {
  try {
    // Imported here rather than at the top: the database connects on import,
    // and this router has to stay importable on an install with no database
    // configured — which is also what lets the gate above be tested at all.
    const { db } = await import("../db.js");
    const { seoLookups } = await import("../schema/index.js");
    const { desc } = await import("drizzle-orm");

    const rows = await db
      .select({
        id: seoLookups.id,
        tool: seoLookups.tool,
        input: seoLookups.input,
        costMicroUsd: seoLookups.costMicroUsd,
        createdAt: seoLookups.createdAt,
      })
      .from(seoLookups)
      .orderBy(desc(seoLookups.createdAt))
      .limit(50);

    res.json({
      lookups: rows.map((row) => ({
        id: row.id,
        tool: row.tool,
        input: row.input,
        costUsd: row.costMicroUsd / 1e6,
        fetchedAt: row.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    fail(res, error, "Could not read the lookup history.");
  }
});

// POST /api/admin/seo/cache/clear — buy the next one fresh.
seoRouter.post("/cache/clear", async (req, res) => {
  const { tool } = req.body ?? {};
  if (tool !== undefined && !isSeoToolId(tool)) {
    res.status(400).json({ error: "Unknown tool." });
    return;
  }
  try {
    res.json({ cleared: await clearCache(tool as SeoToolId | undefined) });
  } catch (error) {
    fail(res, error, "Could not clear the cache.");
  }
});
