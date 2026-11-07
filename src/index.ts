/**
 * Octypo Engine — standalone entry point.
 *
 * Boots the autonomous content pipeline:
 *   RSS → Gate1 (selection) → Writer agents → Gate2 (approval) → published article
 */

import { afterAutowriteStart } from "./lib/autowrite-start.js";
import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { desc, eq } from "drizzle-orm";

import { db, client, closeDb } from "./db.js";
import { contents, articles, rssFeeds } from "./schema/index.js";
import { logger } from "./lib/logger.js";
import { getBuildInfo } from "./lib/build-info.js";
import { runMigrations } from "./lib/migrate.js";
import { entitled, grantedCapabilities } from "./config/entitlements.js";
import { jobQueue } from "./job-queue.js";
import { initializeOctypo } from "./octypo/index.js";
import { rssReader } from "./octypo/rss-reader.js";
import {
  startRSSScheduler,
  stopRSSScheduler,
  getRSSSchedulerStatus,
  getSchedulerStats,
} from "./octypo/rss-scheduler.js";
import {
  startLibraryScheduler,
  stopLibraryScheduler,
  getLibrarySchedulerStatus,
  getLibraryStats,
} from "./octypo/library/scheduler.js";
import { registerLibraryJobHandlers } from "./octypo/library/job-handlers.js";
import { startFieldDesk, fieldConfigFromEnv } from "./octypo/field/telegram.js";
import { registerIdeaJobHandlers } from "./research/idea-writer.js";
import {
  startIdeaScheduler,
  stopIdeaScheduler,
  getIdeaSchedulerStatus,
} from "./research/idea-scheduler.js";
import { bankSummary } from "./research/bank-store.js";
import { startRankTracker, stopRankTracker } from "./research/rank-tracker.js";
import { startPublishScheduler, stopPublishScheduler } from "./octypo/publish-scheduler.js";
import { handleLogin, requireAdmin, isAdminEnabled } from "./api/auth.js";
import { adminRouter, addFeedHandler, triggerPipelineHandler } from "./api/admin.js";
import { createSiteRouter } from "./api/site.js";
import { createIntakeRouter } from "./api/intake.js";
import { createReportHandler } from "./api/report.js";
import { seoRouter } from "./api/seo.js";
import { seoReportPageRouter } from "./api/seo-report-page.js";
import { growthRouter } from "./api/growth.js";
import { startGrowthController, stopGrowthController } from "./research/growth-controller.js";
import { octyGateRouter } from "./api/octygate.js";
import { startOctyGateScheduler, stopOctyGateScheduler } from "./octygate/scheduler.js";

const PORT = Number(process.env.PORT) || 3000;

// Built admin SPA lives one level above this file (src/ in dev, dist/ in prod)
const DIST_ADMIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist-admin");

function envFlag(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  return !["false", "0", "no", "off"].includes(v.toLowerCase());
}

async function main(): Promise<void> {
  // Before anything touches a table. A boot that serves traffic against a
  // schema older than the code is the failure this replaced: it stays quiet
  // until a query hits the missing column, in production, on a customer's site.
  if (envFlag("RUN_MIGRATIONS_ON_BOOT", true)) {
    await runMigrations();
  } else {
    logger.warn("[Engine] RUN_MIGRATIONS_ON_BOOT=false — schema NOT checked");
  }

  logger.info({ capabilities: grantedCapabilities() }, "[Engine] Customer entitlements");

  // Re-arm the daily cost ceiling from the durable ledger. Without this a
  // restart zeroes the in-memory count and the cap fails open mid-day.
  try {
    const { ledgerReport } = await import("./cost/index.js");
    const { costMeter } = await import("./cost/index.js");
    const report = await ledgerReport(2);
    if (report.todayUsd > 0) {
      costMeter.restoreTodaySpend(report.todayUsd);
      logger.info({ todayUsd: report.todayUsd }, "[Engine] Ceiling re-armed from the ledger");
    }
  } catch {
    logger.warn("[Engine] Could not seed today's spend from the ledger");
  }

  const app = express();
  app.use(express.json());
  // Express 5 leaves req.body undefined when a request has no JSON body.
  app.use((req, _res, next) => {
    req.body ??= {};
    next();
  });

  // CORS, deliberately open: Octypo is one deployment per client, and the
  // operator runs a single Studio console that talks to every install. Every
  // mutating surface is bearer-token protected; without these headers the
  // cross-install cockpit cannot exist at all.
  app.use((req, res, next) => {
    // Baseline hardening. The admin SPA is same-origin; nothing here embeds in
    // frames; MIME sniffing buys nothing but trouble.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // CLOSED SYSTEM: the engine is headless and must never be indexed by search
  // engines. The consuming site (which pulls via API) owns its own indexing.
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });

  // ── Initialize pipeline ────────────────────────────────────────────────
  // Creates rss_feed_items table, registers gatekeeper job handlers
  await initializeOctypo();

  // Register the Document Library job handlers (second content source)
  registerLibraryJobHandlers();
  // The field desk: the client's Telegram group feeds the library. On only
  // when a bot token is set; never in tests.
  if (envFlag("ENABLE_FIELD_TELEGRAM", true) && fieldConfigFromEnv()) {
    startFieldDesk();
    logger.info("[Engine] Field desk (Telegram) started");
    // Field photos that the publish gate cannot accept are converted and their
    // articles rewritten. Runs after boot, never in the way of serving.
    setTimeout(() => {
      import("./octypo/field/repair.js")
        .then(({ repairFieldMedia }) => repairFieldMedia())
        .catch(err => logger.warn({ error: err }, "[Field] Repair pass failed (non-fatal)"));
    }, 20_000).unref?.();
  }

  // Register the idea-bank writer (third content source: the plan)
  registerIdeaJobHandlers();

  // Start the persistent job queue (octypo_write / gatekeeper_review / …)
  if (envFlag("ENABLE_GATEKEEPER_PIPELINE", true)) {
    jobQueue.start();
    logger.info("[Engine] Job queue started");
  } else {
    logger.warn("[Engine] ENABLE_GATEKEEPER_PIPELINE=false — job queue NOT started");
  }

  // Start the RSS scheduler (fetch feeds → Gate1 → write jobs)
  if (envFlag("ENABLE_RSS_SCHEDULER", true)) {
    afterAutowriteStart("RSS scheduler", () => startRSSScheduler({
      intervalMinutes: Number(process.env.RSS_INTERVAL_MINUTES) || 30,
      globalDailyLimit: Number(process.env.RSS_GLOBAL_DAILY_LIMIT) || 20,
      dailyLimitPerTopic: Number(process.env.RSS_DAILY_LIMIT_PER_TOPIC) || 5,
      minQualityScore: Number(process.env.RSS_MIN_QUALITY_SCORE) || 70,
      enabled: true,
    }));
  } else {
    logger.warn("[Engine] ENABLE_RSS_SCHEDULER=false — scheduler NOT started");
  }

  // Start the Document Library scheduler (mined ideas → write jobs)
  if (envFlag("ENABLE_LIBRARY_SCHEDULER", true) && entitled("document-library")) {
    startLibraryScheduler({
      intervalMinutes: Number(process.env.LIBRARY_INTERVAL_MINUTES) || 30,
      dailyLimit: Number(process.env.LIBRARY_DAILY_LIMIT) || 3,
      enabled: true,
    });
    logger.info("[Engine] Library scheduler started");
  } else if (!entitled("document-library")) {
    logger.info("[Engine] Document library is not in this customer's plan — scheduler NOT started");
  } else {
    logger.warn("[Engine] ENABLE_LIBRARY_SCHEDULER=false — library scheduler NOT started");
  }

  // Start the idea-bank scheduler (planned ideas → write jobs)
  if (envFlag("ENABLE_IDEA_SCHEDULER", true)) {
    afterAutowriteStart("Idea-bank scheduler", () => startIdeaScheduler({
      intervalMinutes: Number(process.env.IDEA_INTERVAL_MINUTES) || 30,
      dailyLimit: Number(process.env.IDEA_BANK_DAILY_LIMIT) || 3,
      enabled: true,
    }));
  } else {
    logger.warn("[Engine] ENABLE_IDEA_SCHEDULER=false — idea scheduler NOT started");
  }

  // Start the publish scheduler (promotes `scheduled` articles when due)
  startPublishScheduler();

  // Once a month, where every target phrase stands in Google. On by default:
  // the tracker is what turns articles into a result the client can see, and
  // it quietly does nothing on an install with no SITE_URL or no DataForSEO
  // login rather than needing to be switched on.
  if (envFlag("ENABLE_RANK_TRACKING", true)) {
    startRankTracker();
    logger.info("[Engine] Rank tracker started");
  } else {
    logger.warn("[Engine] ENABLE_RANK_TRACKING=false — rankings NOT tracked");
  }

  // Maintain a multi-month plan while the idea scheduler keeps publishing at
  // the deliberately slow weekly pace. No seeds means a visible blocked state,
  // never invented topics.
  startGrowthController();
  startOctyGateScheduler();

  // ── REST API ───────────────────────────────────────────────────────────

  app.get("/health", async (_req, res) => {
    // Observe DB reachability without failing the check (single replica: a hard
    // fail would just restart-loop on an external DB outage). Always HTTP 200.
    let dbOk = false;
    try { await client`select 1`; dbOk = true; } catch { dbOk = false; }
    const build = getBuildInfo();
    res.json({
      status: dbOk ? "ok" : "degraded",
      uptime: process.uptime(),
      db: dbOk,
      version: build.sha,
      builtAt: build.builtAt,
    });
  });

  // List RSS feeds
  app.get("/api/feeds", requireAdmin, async (_req, res) => {
    try {
      const feeds = await db.select().from(rssFeeds).orderBy(desc(rssFeeds.createdAt));
      res.json({ feeds });
    } catch (error) {
      logger.error({ error }, "[API] Failed to list feeds");
      res.status(500).json({ error: "Failed to list feeds" });
    }
  });

  // Add an RSS feed (admin-protected; canonical path is /api/admin/feeds)
  app.post("/api/feeds", requireAdmin, addFeedHandler);

  // Latest published articles
  app.get("/api/articles", async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const rows = await db
        .select({
          id: contents.id,
          title: contents.title,
          slug: contents.slug,
          summary: contents.summary,
          answerCapsule: contents.answerCapsule,
          metaTitle: contents.metaTitle,
          metaDescription: contents.metaDescription,
          blocks: contents.blocks,
          quickFacts: contents.quickFacts,
          // The site importers file each article under its primary query.
          primaryKeyword: contents.primaryKeyword,
          wordCount: contents.wordCount,
          writerId: contents.writerId,
          publishedAt: contents.publishedAt,
          heroImage: contents.heroImage,
          heroImageAlt: contents.heroImageAlt,
          cardImage: contents.cardImage,
          cardImageAlt: contents.cardImageAlt,
          seoSchema: contents.seoSchema,
          aeoScore: contents.aeoScore,
          // From the joined articles row — drives the site's content-type chip.
          category: articles.category, // "news" | "diy" | "tips" | "guide"
          tags: articles.relatedTopicIds, // string[] topic slugs
        })
        .from(contents)
        .leftJoin(articles, eq(articles.contentId, contents.id))
        .where(eq(contents.status, "published"))
        .orderBy(desc(contents.publishedAt))
        .limit(limit);

      // The customer sites' importers require a search intent per article;
      // the engine has no column for it, so derive it from the writer: the
      // commercial writer answers buying questions, everything else informs.
      res.json({
        articles: rows.map((row) => ({
          ...row,
          searchIntent: row.writerId === "commercial" ? "informational-commercial" : "informational",
        })),
      });
    } catch (error) {
      logger.error({ error }, "[API] Failed to list articles");
      res.status(500).json({ error: "Failed to list articles" });
    }
  });

  // Single article by id, ANY status — drives the admin Review console's live
  // design preview (the marketing /guides template renders this in an iframe).
  // Token-guarded so unpublished drafts never leak to the public.
  app.get("/api/preview/:id", async (req, res) => {
    const expected = process.env.PREVIEW_TOKEN;
    const providedToken = typeof req.query.token === "string" ? req.query.token : "";
    if (
      !expected ||
      providedToken.length !== expected.length ||
      !timingSafeEqual(Buffer.from(providedToken), Buffer.from(expected))
    ) {
      res.status(401).json({ error: "Invalid preview token" });
      return;
    }
    try {
      const [row] = await db
        .select({
          id: contents.id,
          status: contents.status,
          title: contents.title,
          slug: contents.slug,
          summary: contents.summary,
          answerCapsule: contents.answerCapsule,
          metaTitle: contents.metaTitle,
          metaDescription: contents.metaDescription,
          blocks: contents.blocks,
          quickFacts: contents.quickFacts,
          wordCount: contents.wordCount,
          writerId: contents.writerId,
          publishedAt: contents.publishedAt,
          scheduledFor: contents.scheduledFor,
          heroImage: contents.heroImage,
          heroImageAlt: contents.heroImageAlt,
          cardImage: contents.cardImage,
          cardImageAlt: contents.cardImageAlt,
          seoSchema: contents.seoSchema,
          aeoScore: contents.aeoScore,
          category: articles.category,
          tags: articles.relatedTopicIds,
        })
        .from(contents)
        .leftJoin(articles, eq(articles.contentId, contents.id))
        .where(eq(contents.id, req.params.id));

      if (!row) {
        res.status(404).json({ error: "Article not found" });
        return;
      }
      res.json({ article: row });
    } catch (error) {
      logger.error({ error, id: req.params.id }, "[API] Failed to load preview article");
      res.status(500).json({ error: "Failed to load preview article" });
    }
  });

  // Pipeline status: scheduler state + RSS/job counts
  app.get("/api/pipeline/status", requireAdmin, async (_req, res) => {
    try {
      const scheduler = getRSSSchedulerStatus();
      const libraryScheduler = getLibrarySchedulerStatus();
      const [schedulerStats, rssStats, jobStats, libraryStats] = await Promise.all([
        getSchedulerStats(),
        rssReader.getStats(),
        jobQueue.getStats(),
        getLibraryStats(),
      ]);

      res.json({
        capabilities: grantedCapabilities(),
        scheduler,
        today: schedulerStats,
        rss: rssStats,
        jobs: jobStats,
        library: {
          scheduler: libraryScheduler,
          stats: libraryStats,
        },
        ideaBank: {
          scheduler: getIdeaSchedulerStatus(),
          stats: await bankSummary(),
        },
      });
    } catch (error) {
      logger.error({ error }, "[API] Failed to get pipeline status");
      res.status(500).json({ error: "Failed to get pipeline status" });
    }
  });

  // Force-trigger a pipeline run (admin-protected; canonical path is /api/admin/pipeline/trigger)
  app.post("/api/pipeline/trigger", requireAdmin, triggerPipelineHandler);

  // ── Admin API ──────────────────────────────────────────────────────────
  app.post("/api/auth/login", handleLogin);
  // The contract a customer's blog consumes. Published-only and read-only —
  // the blog cannot see drafts even with a valid site key.
  app.use("/api/site", createSiteRouter());

  // Read-only client report — the paying client's single link. Key-gated
  // (CLIENT_REPORT_KEY; 404 while unset), server-rendered HTML, no admin
  // code, no actions, no operational data.
  app.get("/report", createReportHandler());

  // Client questionnaire — token-gated public form whose answers become the
  // writer's confirmed facts (INTAKE_TOKEN; 404 while unset).
  app.use(createIntakeRouter());

  // The SEO desk. Ours too, billed to our own DataForSEO account, so it is off
  // unless SEO_TOOLS_ENABLED says otherwise and answers 404 everywhere else.
  app.use("/api/admin/seo", requireAdmin, seoRouter);
  app.use("/api/admin/growth", requireAdmin, growthRouter);
  app.use("/api/admin/octygate", requireAdmin, octyGateRouter);

  // The prospect's own view of a report we sent them. No admin session — the
  // unguessable token in the link is the credential, and the page is noindex.
  app.use(seoReportPageRouter);

  app.use("/api/admin", requireAdmin, adminRouter);
  if (!isAdminEnabled()) {
    logger.warn("[Engine] ADMIN_PASSWORD not set — admin API disabled (503)");
  }

  // ── Admin SPA (built by `npm --prefix admin run build` into dist-admin) ─
  if (fs.existsSync(DIST_ADMIN)) {
    app.use("/admin", express.static(DIST_ADMIN));
    // SPA fallback: deep links like /admin/articles/:id serve index.html
    app.get("/admin/{*path}", (_req, res) => {
      res.sendFile(path.join(DIST_ADMIN, "index.html"));
    });
    logger.info({ dir: DIST_ADMIN }, "[Engine] Admin SPA mounted at /admin");
  } else {
    logger.warn({ dir: DIST_ADMIN }, "[Engine] dist-admin not found — admin SPA not served");
  }

  const server = app.listen(PORT, () => {
    logger.info(`[Engine] Octypo engine listening on port ${PORT}`);
  });

  // Graceful shutdown: stop schedulers + job queue, drain in-flight HTTP, close
  // the DB pool, then exit. 15s hard cap so a stuck tick can't block a deploy.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "[Engine] shutdown starting");
    try { stopRSSScheduler(); } catch { /* ignore */ }
    try { stopLibraryScheduler(); } catch { /* ignore */ }
    try { stopIdeaScheduler(); } catch { /* ignore */ }
    try { stopRankTracker(); } catch { /* ignore */ }
    try { stopGrowthController(); } catch { /* ignore */ }
    try { stopOctyGateScheduler(); } catch { /* ignore */ }
    try { stopPublishScheduler(); } catch { /* ignore */ }
    try { jobQueue.stopProcessing(); } catch { /* ignore */ }
    server.close(() => {
      void closeDb()
        .catch(() => {})
        .finally(() => {
          logger.info("[Engine] shutdown complete");
          process.exit(0);
        });
    });
    setTimeout(() => {
      logger.error("[Engine] shutdown forced");
      process.exit(1);
    }, 15_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(err => {
  console.error("[Engine] Fatal startup error:", err);
  process.exit(1);
});
