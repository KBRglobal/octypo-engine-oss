/**
 * Admin API — manual content management on top of the autonomous pipeline.
 *
 * Mounted under /api/admin behind requireAdmin (see auth.ts). Also exports
 * the shared handlers for the backwards-compatible mutating public paths
 * (POST /api/feeds, POST /api/pipeline/trigger) which are admin-protected too.
 */

import { storeIdeas } from "../research/bank-store.js";
import { Router, type Request, type Response } from "express";
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import multer from "multer";

import { db, client } from "../db.js";
import {
  contents,
  articles,
  rssFeeds,
  documents,
  libraryItems,
  type ContentBlock,
  type ContentStatus,
  type LibraryItemStatus,
  serpBriefs,
  backgroundJobs,
} from "../schema/index.js";
import { SITE_NAME, SITE_URL } from "../config/domain.js";
import { logger } from "../lib/logger.js";
import { entitled } from "../config/entitlements.js";
import { searchClientFromEnv } from "../research/brave.js";
import { buildTopicBank, toTopicsJson } from "../research/topic-bank.js";
import { buildIdeaBank } from "../research/build-bank.js";
import { generateFactQuestionnaire } from "../writer/questionnaire.js";
import { getCostDashboard, ledgerReport, spendCeiling } from "../cost/index.js";
import { getBuildInfo } from "../lib/build-info.js";
import { fleetStatusHandler } from "./fleet-status.js";
import { siteCheck } from "../lib/site-check.js";
import { isAggregatorUrl, resolveSourceUrl } from "../lib/source-url.js";
import { discoverPrimarySources } from "../lib/primary-sources.js";
import { autoScheduleConfig, planSlots } from "../octypo/auto-schedule.js";
import { bankSummary, markIdea } from "../research/bank-store.js";
import { measureRankings, rankReport, rankTrackerStatus } from "../research/rank-tracker.js";
import { contentIdeas, clusterFacts, clusterSettings, type ContentIdeaStatus } from "../schema/index.js";
import { LANGUAGE_NAMES } from "../config/locale.js";
import { sanitizeBlocks } from "../lib/sanitize-blocks.js";
import { notifyBlog, notifySiteDeploy } from "../lib/site-notify.js";
import { jobQueue } from "../job-queue.js";
import { rssReader } from "../octypo/rss-reader.js";
import {
  getRSSSchedulerStatus,
  getSchedulerStats,
  forceTrigger,
} from "../octypo/rss-scheduler.js";
import { getGate2Approver } from "../octypo/gatekeeper/gate2-approver.js";
import { publishContentById, redeliverPublishedContent } from "../octypo/publish.js";
import { ARTICLE_PATH_PREFIX } from "../octypo/aeo.js";
import { auditContentAgainstCorpus } from "../octypo/content-quality.js";
import { buildUniqueSlug } from "../octypo/gatekeeper/job-handlers.js";
import type { ArticleApprovalInput } from "../octypo/gatekeeper/types.js";
import { extractText, MAX_FILE_BYTES } from "../octypo/library/extract.js";
import { getLibrarySchedulerStatus, getLibraryStats } from "../octypo/library/scheduler.js";
import { generateViralIdeas, VIRAL_TOPIC_MARKER } from "../octypo/library/viral-ideas.js";
import {
  regenerateArticleImage,
  regenerateArticleMedia,
  isImageProviderConfigured,
  NoImageProviderError,
  ContentNotFoundError,
  type MediaPlanItem,
} from "../octypo/gatekeeper/regenerate-image.js";

const VALID_STATUSES: ContentStatus[] = [
  "draft",
  "in_review",
  "scheduled",
  "publishing",
  "published",
  "archived",
];

const VALID_LIBRARY_STATUSES: LibraryItemStatus[] = [
  "idea",
  "queued",
  "writing",
  "published",
  "failed",
];

// Multer: in-memory storage, capped, restricted to text/markdown/pdf/docx.
const ACCEPTED_EXTENSIONS = new Set(["txt", "md", "markdown", "pdf", "docx"]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 20 },
  fileFilter: (_req, file, cb) => {
    const dot = file.originalname.lastIndexOf(".");
    const ext = dot >= 0 ? file.originalname.slice(dot + 1).toLowerCase() : "";
    if (ACCEPTED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type ".${ext}". Accepted: .txt, .md, .pdf, .docx`));
    }
  },
});

// ============================================
// HELPERS
// ============================================

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Count words across all text-bearing block fields. */
function countWordsInBlocks(blocks: ContentBlock[]): number {
  const parts: string[] = [];
  for (const block of blocks) {
    const data = (block.data ?? {}) as Record<string, unknown>;
    if (typeof data.content === "string") parts.push(stripHtml(data.content));
    if (typeof data.text === "string") parts.push(data.text);
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        if (typeof item === "string") {
          parts.push(stripHtml(item));
        } else if (item && typeof item === "object") {
          const faq = item as { question?: string; answer?: string };
          parts.push(stripHtml(`${faq.question ?? ""} ${faq.answer ?? ""}`));
        }
      }
    }
  }
  const text = parts.join(" ").trim();
  return text ? text.split(/\s+/).length : 0;
}

function preserveStoredBodyImages(nextBlocks: ContentBlock[], storedBlocks: unknown): ContentBlock[] {
  if (!Array.isArray(storedBlocks)) return nextBlocks;
  const images = (storedBlocks as ContentBlock[]).filter(
    block => block?.type === "image" && typeof block.data?.url === "string" && block.data.url
  );
  if (images.length === 0) return nextBlocks;
  const blocks = nextBlocks.filter(block => block.type !== "image");
  const headings = () => blocks
    .map((block, index) => block.type === "heading" ? index : -1)
    .filter(index => index >= 0);
  for (let index = 0; index < images.length; index += 1) {
    const positions = headings();
    const target = positions.length === 0
      ? Math.max(1, Math.round((blocks.length * (index + 1)) / (images.length + 1)))
      : positions[Math.min(
          positions.length - 1,
          Math.max(0, Math.round(((index + 1) * positions.length) / (images.length + 1)) - 1)
        )] + 2;
    blocks.splice(target, 0, images[index]);
  }
  return blocks;
}

type StoredSchema = Record<string, unknown>[] | Record<string, unknown> | string;

function withoutLegacyRichResultSchema(input: unknown): StoredSchema {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return String(input);
    }
  }
  const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const filtered = entries.filter(entry => {
    if (!entry || typeof entry !== "object") return false;
    return !["FAQPage", "HowTo"].includes(String((entry as Record<string, unknown>)["@type"] ?? ""));
  });
  return Array.isArray(value) ? filtered : filtered[0] ?? {};
}

/**
 * Strip HTML tags from a plain-text field. Title/meta/summary are rendered as
 * text on the site, but a stored `<img onerror>` becomes XSS the moment any
 * consumer interpolates them into markup. Tags never belong here, so drop them.
 */
function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}

function isValidBlocks(value: unknown): value is ContentBlock[] {
  return (
    Array.isArray(value) &&
    value.every(
      b =>
        b &&
        typeof b === "object" &&
        typeof (b as ContentBlock).type === "string" &&
        typeof (b as ContentBlock).data === "object"
    )
  );
}

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(?:^-|-$)/g, "")
    .substring(0, 80);
}

// ============================================
// SHARED HANDLERS (also mounted on legacy paths)
// ============================================

/** POST /api/feeds + POST /api/admin/feeds — add an RSS feed. */
export async function addFeedHandler(req: Request, res: Response): Promise<void> {
  try {
    const { name, url, category, topicId, language, fetchIntervalMinutes } = req.body || {};
    if (!name || !url) {
      res.status(400).json({ error: "name and url are required" });
      return;
    }

    const [feed] = await db
      .insert(rssFeeds)
      .values({
        name: String(name),
        url: String(url),
        category: category ? String(category) : null,
        topicId: topicId ? String(topicId) : null,
        language: language ? String(language) : "en",
        fetchIntervalMinutes: Number(fetchIntervalMinutes) || 60,
        isActive: true,
      })
      .returning();

    // Fetch immediately so items are available for the next pipeline run
    rssReader.fetchFeed(feed.id).catch(err => {
      logger.warn({ feedId: feed.id, error: String(err) }, "[API] Initial feed fetch failed");
    });

    res.status(201).json({ feed });
  } catch (error) {
    logger.error({ error }, "[API] Failed to add feed");
    res.status(500).json({ error: "Failed to add feed" });
  }
}

/** POST /api/pipeline/trigger + POST /api/admin/pipeline/trigger. */
export async function triggerPipelineHandler(req: Request, res: Response): Promise<void> {
  try {
    const maxItems = Math.min(Number(req.body?.maxItems) || 10, 50);
    const result = await forceTrigger(maxItems);
    res.json({ triggered: true, ...result });
  } catch (error) {
    logger.error({ error }, "[API] Pipeline trigger failed");
    res.status(500).json({ error: "Pipeline trigger failed" });
  }
}

// ============================================
// ADMIN ROUTER
// ============================================

export const adminRouter = Router();

// ── Fleet status ──────────────────────────────────────────────────────────
// GET /api/admin/fleet-status — polled every 15 min per install by the fleet
// monitor. Cheap by contract: one select-1, one count, in-memory ceiling state.
adminRouter.get(
  "/fleet-status",
  fleetStatusHandler({
    getBuildInfo,
    probeDb: async () => {
      try {
        await client`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    ceilingState: () => spendCeiling.getState(),
    countPublishedSince: async (cutoff) => {
      const [row] = await db
        .select({ total: count() })
        .from(contents)
        .where(and(eq(contents.status, "published"), gte(contents.publishedAt, cutoff)));
      return row?.total ?? 0;
    },
    nextScheduledAt: async () => {
      const [row] = await db
        .select({ at: contents.scheduledFor })
        .from(contents)
        .where(eq(contents.status, "scheduled"))
        .orderBy(asc(contents.scheduledFor))
        .limit(1);
      return row?.at ?? null;
    },
    countOverdueScheduled: async (now) => {
      const [row] = await db
        .select({ total: count() })
        .from(contents)
        .where(and(eq(contents.status, "scheduled"), lte(contents.scheduledFor, now)));
      return row?.total ?? 0;
    },
    countHeldSince: async (cutoff) => {
      const [row] = await db
        .select({ total: count() })
        .from(contents)
        .where(and(eq(contents.status, "in_review"), isNull(contents.deletedAt), lte(contents.updatedAt, cutoff)));
      return row?.total ?? 0;
    },
    siteCheck: () => siteCheck(),
  })
);

// ── Articles ──────────────────────────────────────────────────────────────

// GET /api/admin/articles?status=&search=&limit=&offset=
/**
 * Research a topic bank from live search results.
 *
 * This is the install step that used to be a manual authoring job: give it the
 * phrases the customer's business is actually about, and it returns the topic
 * bank in the exact shape `TOPICS_JSON` takes, with the evidence behind each
 * suggestion so a human can disagree with it before it goes into an
 * environment.
 */
adminRouter.post("/research/topics", async (req: Request, res: Response) => {
  if (!entitled("search-research")) {
    res.status(403).json({ error: "Search research is not in this customer's plan" });
    return;
  }

  const client = searchClientFromEnv();
  if (!client) {
    res.status(503).json({ error: "BRAVE_API_KEY is not configured" });
    return;
  }

  const body = (req.body ?? {}) as {
    seeds?: unknown;
    keywordsPerTopic?: unknown;
    country?: unknown;
    lang?: unknown;
  };
  const seeds = Array.isArray(body.seeds)
    ? body.seeds.filter((s): s is string => typeof s === "string")
    : [];
  if (seeds.length === 0) {
    res.status(400).json({ error: "seeds must be a non-empty array of strings" });
    return;
  }
  // One search per seed against a metered API — a 200-seed request is a
  // mistake, not a plan.
  if (seeds.length > 25) {
    res.status(400).json({ error: "at most 25 seeds per request" });
    return;
  }

  try {
    const topics = await buildTopicBank(client, {
      seeds,
      keywordsPerTopic: Number(body.keywordsPerTopic) || undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      lang: typeof body.lang === "string" ? body.lang : undefined,
    });
    res.json({ topics, topicsJson: toTopicsJson(topics) });
  } catch (error) {
    logger.error({ error }, "[Admin] Topic research failed");
    res.status(500).json({ error: "Topic research failed" });
  }
});

// ── Idea bank ─────────────────────────────────────────────────────────────
//
// The bank is what turns the engine from reactive to planned: instead of
// waiting for a feed to produce something worth writing, it works through a
// deliberate map of the customer's topic space.

/**
 * Build (or top up) the bank. `persist: false` returns the plan for review
 * without writing it, which is how a customer is shown their year before a
 * single article is generated.
 */
/**
 * The one-time competitive snapshot, per cluster. Runs once at onboarding —
 * the owner's rule is that external research is paid for once per client —
 * and every article in the cluster rides on the stored brief from then on.
 */
adminRouter.post("/serp-brief/build", async (req: Request, res: Response) => {
  if (!entitled("search-research")) {
    res.status(403).json({ error: "Search research is not in this customer's plan" });
    return;
  }
  try {
    const { buildSerpBrief, bankClusters } = await import("../research/serp-brief.js");
    const body = (req.body ?? {}) as { cluster?: unknown };
    const clusters =
      typeof body.cluster === "string" && body.cluster.trim()
        ? [body.cluster.trim()]
        : await bankClusters();
    if (clusters.length === 0) {
      res.status(400).json({ error: "No clusters in the idea bank yet — build the bank first" });
      return;
    }
    const built: { cluster: string; queries: string[] }[] = [];
    for (const cluster of clusters) {
      const result = await buildSerpBrief(cluster);
      if (result) built.push({ cluster: result.cluster, queries: result.queries });
    }
    res.json({ built, requested: clusters.length });
  } catch (error) {
    logger.error({ error }, "[Admin] SERP brief build failed");
    res.status(500).json({ error: "SERP brief build failed" });
  }
});

/**
 * The zero-cost research path: the engine writes the prompt, the owner runs
 * it on their own flat-rate subscription, and pastes the answer back below.
 * No entitlement gate — this spends nothing.
 */
adminRouter.get("/serp-brief/prompt", async (req: Request, res: Response) => {
  try {
    const { serpBriefPrompt, bankClusters } = await import("../research/serp-brief.js");
    const one = typeof req.query.cluster === "string" ? req.query.cluster.trim() : "";
    const clusters = one ? [one] : await bankClusters();
    const prompts = [];
    for (const cluster of clusters) {
      const p = await serpBriefPrompt(cluster);
      if (p) prompts.push(p);
    }
    if (prompts.length === 0) {
      res.status(400).json({ error: "No clusters with queries in the bank yet" });
      return;
    }
    res.json({ prompts });
  } catch (error) {
    logger.error({ error }, "[Admin] SERP prompt build failed");
    res.status(500).json({ error: "SERP prompt build failed" });
  }
});

adminRouter.post("/serp-brief/paste", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { cluster?: unknown; brief?: unknown };
  const cluster = typeof body.cluster === "string" ? body.cluster.trim() : "";
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!cluster || brief.length < 100) {
    res.status(400).json({ error: "cluster and a substantial brief are required" });
    return;
  }
  try {
    const { storePastedBrief } = await import("../research/serp-brief.js");
    await storePastedBrief(cluster, brief);
    res.json({ stored: cluster });
  } catch (error) {
    logger.error({ error }, "[Admin] SERP brief paste failed");
    res.status(500).json({ error: "Failed to store the brief" });
  }
});

adminRouter.get("/serp-briefs", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        cluster: serpBriefs.cluster,
        queries: serpBriefs.queries,
        brief: serpBriefs.brief,
        updatedAt: serpBriefs.updatedAt,
      })
      .from(serpBriefs);
    res.json({ briefs: rows });
  } catch (error) {
    logger.error({ error }, "[Admin] SERP brief list failed");
    res.status(500).json({ error: "Failed to list SERP briefs" });
  }
});

adminRouter.post("/ideas/build", async (req: Request, res: Response) => {
  if (!entitled("search-research")) {
    res.status(403).json({ error: "Search research is not in this customer's plan" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const seeds = Array.isArray(body.seeds)
    ? body.seeds.filter((s): s is string => typeof s === "string")
    : [];
  if (seeds.length === 0) {
    res.status(400).json({ error: "seeds must be a non-empty array of strings" });
    return;
  }
  if (seeds.length > 40) {
    res.status(400).json({ error: "at most 40 seeds per build" });
    return;
  }

  const target = Number(body.target) || 300;
  if (target < 1 || target > 5000) {
    res.status(400).json({ error: "target must be between 1 and 5000" });
    return;
  }

  try {
    const result = await buildIdeaBank({
      seeds,
      target,
      articlesPerMonth: Number(body.articlesPerMonth) || undefined,
      keywordsPerCluster: Number(body.keywordsPerCluster) || undefined,
      country: typeof body.country === "string" ? body.country : undefined,
      lang: typeof body.lang === "string" ? body.lang : undefined,
      persist: body.persist !== false,
    });
    res.json({
      requested: result.requested,
      produced: result.produced,
      coverageMonths: result.coverageMonths,
      usedKeywordProvider: result.usedKeywordProvider,
      titled: result.titled,
      inserted: result.inserted,
      skipped: result.skipped,
      topics: result.topics.map((t) => ({ slug: t.slug, name: t.name, evidence: t.evidence })),
      ideas: result.ideas,
    });
  } catch (error) {
    logger.error({ error }, "[Admin] Idea bank build failed");
    res.status(500).json({ error: error instanceof Error ? error.message : "Build failed" });
  }
});

adminRouter.get("/ideas", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const filters: SQL[] = [];
  if (typeof req.query.status === "string") {
    filters.push(eq(contentIdeas.status, req.query.status as ContentIdeaStatus));
  }
  if (typeof req.query.cluster === "string") {
    filters.push(eq(contentIdeas.cluster, req.query.cluster));
  }

  const rows = await db
    .select()
    .from(contentIdeas)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(contentIdeas.isPillar), desc(contentIdeas.priority))
    .limit(limit);

  res.json({ summary: await bankSummary(), ideas: rows });
});

/** Jump one idea to the front, without waiting for the scheduler. */
// POST /api/admin/ideas/plan — a hand-made editorial plan, in order. Each item
// becomes a planned idea whose priority keeps the given order ahead of the
// keyword bank (first item writes first). Existing phrases are skipped.
adminRouter.post("/ideas/plan", async (req: Request, res: Response) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const valid = items.filter((i: Record<string, unknown>) => typeof i?.title === "string" && typeof i?.targetKeyword === "string");
  if (valid.length === 0 || valid.length > 500) {
    res.status(400).json({ error: "items must be 1-500 objects with title and targetKeyword" });
    return;
  }
  const top = 10_000_000;
  const planned = valid.map((i: Record<string, unknown>, index: number) => ({
    title: String(i.title).trim(),
    targetKeyword: String(i.targetKeyword).trim(),
    dedupeKey: `plan:${String(i.title).trim().toLowerCase()}`,
    cluster: typeof i.cluster === "string" && i.cluster ? i.cluster : "editorial-plan",
    articleType: (typeof i.articleType === "string" ? i.articleType : "guide") as never,
    isPillar: false,
    searchVolume: typeof i.searchVolume === "number" ? i.searchVolume : null,
    priority: top - index,
    evidence: { source: "editorial-plan", position: index + 1 } as never,
  }));
  const stored = await storeIdeas(planned as never);
  res.json(stored);
});

adminRouter.post("/ideas/:id/write-now", async (req: Request, res: Response) => {
  const [idea] = await db
    .select({ id: contentIdeas.id, status: contentIdeas.status })
    .from(contentIdeas)
    .where(eq(contentIdeas.id, req.params.id))
    .limit(1);
  if (!idea) {
    res.status(404).json({ error: "No such idea" });
    return;
  }
  if (idea.status === "written") {
    res.status(409).json({ error: "Already written" });
    return;
  }

  // Atomic claim: flip planned/skipped → queued and enqueue ONLY if this call
  // won the flip. Without it, two clicks — or a click racing the idea
  // scheduler's own claim — enqueue the same idea twice and write it twice.
  const [claimed] = await db
    .update(contentIdeas)
    .set({ status: "queued", updatedAt: new Date() })
    .where(and(eq(contentIdeas.id, idea.id), ne(contentIdeas.status, "queued"), ne(contentIdeas.status, "written")))
    .returning({ id: contentIdeas.id });
  if (!claimed) {
    res.status(409).json({ error: "Already queued" });
    return;
  }
  await jobQueue.addJob("idea_write", { ideaId: idea.id }, { priority: 1 });
  res.status(202).json({ queued: true, ideaId: idea.id });
});

/** Take an idea out of the plan without deleting the evidence it came from. */
adminRouter.post("/ideas/:id/skip", async (req: Request, res: Response) => {
  await markIdea(req.params.id, "skipped");
  res.json({ ok: true });
});

// ── Confirmed facts ───────────────────────────────────────────────────────
//
// The writer may only state what lives in this table. Richness comes from the
// customer confirming real facts once, not from a bigger model guessing.

adminRouter.get("/facts", async (req: Request, res: Response) => {
  const filters: SQL[] = [];
  if (typeof req.query.cluster === "string") {
    filters.push(eq(clusterFacts.cluster, req.query.cluster));
  }
  const rows = await db
    .select()
    .from(clusterFacts)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(clusterFacts.cluster, clusterFacts.createdAt);
  res.json({ facts: rows });
});

/** Add facts. Body: { cluster?: string, facts: string[], confirmed?: boolean }. */
adminRouter.post("/facts", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { cluster?: unknown; facts?: unknown; confirmed?: unknown };
  const facts = Array.isArray(body.facts)
    ? body.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (facts.length === 0) {
    res.status(400).json({ error: "facts must be a non-empty array of strings" });
    return;
  }
  const cluster = typeof body.cluster === "string" && body.cluster.trim() ? body.cluster.trim() : "*";
  const inserted = await db
    .insert(clusterFacts)
    .values(
      facts.map((fact) => ({
        cluster,
        fact: fact.trim(),
        confirmed: body.confirmed !== false,
        source: "client",
      }))
    )
    .returning({ id: clusterFacts.id });
  res.status(201).json({ inserted: inserted.length, cluster });
});

adminRouter.delete("/facts/:id", async (req: Request, res: Response) => {
  await db.delete(clusterFacts).where(eq(clusterFacts.id, req.params.id));
  res.json({ ok: true });
});

// ── Cluster locale settings ──────────────────────────────────────────────
//
// Per-cluster (or '*' site-wide) language/country for native article
// generation. Validation here is the prompt-injection boundary (T-quick-01):
// language must be an allowlisted ISO 639-1 code and country a bare ISO
// 3166-1 alpha-2 code BEFORE anything is stored — settings values never flow
// raw into a model prompt (prompts interpolate the internal language-name
// map, not these strings). Mounted on the bearer-protected adminRouter like
// /facts — no new auth surface (T-quick-03).

adminRouter.get("/cluster-settings", async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(clusterSettings)
    .orderBy(clusterSettings.cluster);
  res.json({ settings: rows, languages: LANGUAGE_NAMES });
});

/** Upsert one setting. Body: { cluster?: string, language: string, country: string }. */
adminRouter.put("/cluster-settings", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { cluster?: unknown; language?: unknown; country?: unknown };
  const cluster =
    typeof body.cluster === "string" && body.cluster.trim() ? body.cluster.trim() : "*";
  const language = typeof body.language === "string" ? body.language.trim() : "";
  const country = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";

  if (!LANGUAGE_NAMES[language]) {
    res.status(400).json({
      error: `language must be one of: ${Object.keys(LANGUAGE_NAMES).join(", ")}`,
    });
    return;
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    res.status(400).json({ error: "country must be a two-letter ISO code (e.g. IL, US, DE)" });
    return;
  }

  await db
    .insert(clusterSettings)
    .values({ cluster, language, country })
    .onConflictDoUpdate({
      target: clusterSettings.cluster,
      set: { language, country, updatedAt: new Date() },
    });
  logger.info({ cluster, language, country }, "[Admin] Cluster locale setting saved");
  res.json({ ok: true, cluster, language, country });
});

adminRouter.delete("/cluster-settings/:cluster", async (req: Request, res: Response) => {
  await db.delete(clusterSettings).where(eq(clusterSettings.cluster, req.params.cluster));
  res.json({ ok: true });
});

/**
 * The fact questionnaire — the strong model's inventions, turned into questions.
 *
 * The blind judging round showed the capable models invent exactly the facts a
 * real business owner knows: price bands, surcharges, seasonality, permits. So
 * once per cluster we ask a strong model what it WOULD need to know, and hand
 * that to the customer as a checklist. Their answers go into /facts, and from
 * then on the everyday writer never guesses.
 */
adminRouter.post("/facts/questionnaire", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { cluster?: unknown; topic?: unknown };
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) {
    res.status(400).json({ error: "topic is required" });
    return;
  }
  try {
    const questions = await generateFactQuestionnaire(topic);
    res.json({ topic, cluster: body.cluster ?? "*", questions });
  } catch (error) {
    logger.error({ error }, "[Admin] Questionnaire generation failed");
    res.status(500).json({ error: "Questionnaire generation failed" });
  }
});

adminRouter.get("/articles", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const conditions: SQL[] = [];
    if (status) {
      if (!VALID_STATUSES.includes(status as ContentStatus)) {
        res.status(400).json({ error: `Invalid status. One of: ${VALID_STATUSES.join(", ")}` });
        return;
      }
      conditions.push(eq(contents.status, status as ContentStatus));
    }
    if (search) {
      const pattern = `%${search}%`;
      const searchCond = or(ilike(contents.title, pattern), ilike(contents.slug, pattern));
      if (searchCond) conditions.push(searchCond);
    }
    // Deletion is a tombstone now (see DELETE /articles/:id) so a pull-based
    // blog can learn the row is gone; the admin list must still behave as if it
    // vanished.
    conditions.push(isNull(contents.deletedAt));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const listQuery = db
      .select({
        id: contents.id,
        title: contents.title,
        slug: contents.slug,
        status: contents.status,
        writerId: contents.writerId,
        wordCount: contents.wordCount,
        generatedByAI: contents.generatedByAI,
        cardImage: contents.cardImage,
        heroImage: contents.heroImage,
        aeoScore: contents.aeoScore,
        publishedAt: contents.publishedAt,
        scheduledFor: contents.scheduledFor,
        createdAt: contents.createdAt,
        updatedAt: contents.updatedAt,
      })
      .from(contents)
      .orderBy(desc(contents.createdAt))
      .limit(limit)
      .offset(offset);

    const countQuery = db.select({ total: count() }).from(contents);

    const [rows, totals] = await Promise.all([
      where ? listQuery.where(where) : listQuery,
      where ? countQuery.where(where) : countQuery,
    ]);

    res.json({ articles: rows, total: totals[0]?.total ?? 0, limit, offset });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to list articles");
    res.status(500).json({ error: "Failed to list articles" });
  }
});

// POST /api/admin/content-pack/articles — idempotent import of one approved
// article document. Kept one-document-per-request so large 90-day packs never
// depend on Express body limits or a database's private network address.
adminRouter.post("/content-pack/articles", async (req, res) => {
  try {
    const document = req.body?.article as Record<string, any> | undefined;
    const queueImages = req.body?.queueImages === true;
    const resetMedia = req.body?.resetMedia === true;
    const priority = Math.max(0, Math.min(1000, Number(req.body?.priority) || 0));
    if (!document || typeof document !== "object") {
      res.status(400).json({ error: "article is required" });
      return;
    }
    if (!document.title || !document.slug || !Array.isArray(document.blocks)) {
      res.status(400).json({ error: "title, slug and blocks are required" });
      return;
    }
    const slug = normalizeSlug(String(document.slug));
    if (!slug || slug !== document.slug) {
      res.status(400).json({ error: "slug must already be normalized" });
      return;
    }
    const scheduledFor = new Date(document.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      res.status(400).json({ error: "scheduledFor must be an ISO datetime" });
      return;
    }
    const mediaPlan = Array.isArray(document.imagePlan) ? document.imagePlan : [];
    if (
      queueImages &&
      (mediaPlan.length === 0 ||
        mediaPlan.some((item: any) => !item?.id || !item?.prompt || !item?.alt))
    ) {
      res.status(400).json({ error: "a complete imagePlan is required when queueImages is true" });
      return;
    }

    const [existing] = await db
      .select({ id: contents.id, status: contents.status, blocks: contents.blocks })
      .from(contents)
      .where(eq(contents.slug, slug))
      .limit(1);
    if (existing?.status === "published") {
      res.status(409).json({ error: "published articles cannot be overwritten by a pack" });
      return;
    }

    const cleanedBlocks = preserveStoredBodyImages(
      sanitizeBlocks(document.blocks as ContentBlock[]),
      resetMedia ? [] : existing?.blocks
    );
    const qualityIssues = await auditContentAgainstCorpus({
      id: existing?.id,
      title: plainText(String(document.title)),
      primaryKeyword: document.editorial?.primaryKeyword
        ? plainText(String(document.editorial.primaryKeyword))
        : null,
      answerCapsule: document.answerCapsule ? plainText(String(document.answerCapsule)) : null,
      blocks: cleanedBlocks,
    });
    if (qualityIssues.length > 0) {
      res.status(422).json({ error: "Content quality gate failed", issues: qualityIssues });
      return;
    }

    const heroPlan = mediaPlan.find((item: any) => item.placement === "hero") ?? mediaPlan[0];
    const contentValues = {
      type: "article",
      status: "scheduled" as ContentStatus,
      title: plainText(String(document.title)),
      slug,
      metaTitle: document.metaTitle ? plainText(String(document.metaTitle)) : null,
      metaDescription: document.metaDescription
        ? plainText(String(document.metaDescription))
        : null,
      primaryKeyword: document.editorial?.primaryKeyword
        ? plainText(String(document.editorial.primaryKeyword))
        : null,
      secondaryKeywords: Array.isArray(document.editorial?.supportingQueries)
        ? document.editorial.supportingQueries.map(String)
        : [],
      heroImageAlt: heroPlan?.alt ? plainText(String(heroPlan.alt)) : null,
      cardImageAlt: heroPlan?.alt ? plainText(String(heroPlan.alt)) : null,
      summary: document.summary ? plainText(String(document.summary)) : null,
      blocks: cleanedBlocks,
      seoSchema: withoutLegacyRichResultSchema(document.seoSchema ?? document.structuredData ?? {}),
      answerCapsule: document.answerCapsule ? plainText(String(document.answerCapsule)) : null,
      wordCount: countWordsInBlocks(cleanedBlocks),
      writerId:
        typeof document.author === "string" && document.author.trim()
          ? plainText(document.author)
          : document.author && typeof document.author.name === "string" && document.author.name.trim()
            ? plainText(document.author.name)
            : SITE_NAME,
      generatedByAI: false,
      publishedAt: null,
      scheduledFor,
      deletedAt: null,
      updatedAt: new Date(),
      ...(resetMedia
        ? { heroImage: null, cardImage: null }
        : {}),
    };

    let contentRecord: typeof contents.$inferSelect;
    if (existing) {
      [contentRecord] = await db
        .update(contents)
        .set(contentValues)
        .where(eq(contents.id, existing.id))
        .returning();
    } else {
      [contentRecord] = await db.insert(contents).values(contentValues).returning();
    }

    const category = plainText(String(document.editorial?.cluster || document.category || "insights"));
    const faq = Array.isArray(document.faq)
      ? document.faq
          .filter((item: any) => item?.question && item?.answer)
          .map((item: any) => ({
            question: plainText(String(item.question)),
            answer: plainText(String(item.answer)),
          }))
      : [];
    const tags = Array.isArray(document.tags) ? document.tags.map(String) : [];
    const [articleRow] = await db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.contentId, contentRecord.id))
      .limit(1);
    const articleValues = {
      category,
      excerpt: document.summary ? plainText(String(document.summary)).slice(0, 500) : null,
      publishDate: scheduledFor,
      faq,
      relatedTopicIds: tags,
      deletedAt: null,
      updatedAt: new Date(),
    };
    if (articleRow) {
      await db.update(articles).set(articleValues).where(eq(articles.id, articleRow.id));
    } else {
      await db.insert(articles).values({ contentId: contentRecord.id, ...articleValues });
    }

    let imageJobId: string | null = null;
    if (queueImages) {
      if (resetMedia) {
        await db
          .update(backgroundJobs)
          .set({ status: "cancelled", completedAt: new Date() })
          .where(
            and(
              eq(backgroundJobs.type, "regenerate_image"),
              sql`${backgroundJobs.data}->>'contentId' = ${contentRecord.id}`
            )
          );
      }
      const [pending] = await db
        .select({ id: backgroundJobs.id })
        .from(backgroundJobs)
        .where(
          and(
            eq(backgroundJobs.type, "regenerate_image"),
            or(eq(backgroundJobs.status, "pending"), eq(backgroundJobs.status, "processing")),
            sql`${backgroundJobs.data}->>'contentId' = ${contentRecord.id}`
          )
        )
        .limit(1);
      imageJobId =
        pending?.id ??
        (await jobQueue.addJob(
          "regenerate_image",
          { contentId: contentRecord.id, mediaPlan },
          { priority }
        ));
    }

    res.status(existing ? 200 : 201).json({
      id: contentRecord.id,
      slug,
      scheduledFor: scheduledFor.toISOString(),
      imageJobId,
    });
  } catch (error) {
    logger.error({ error }, "[Admin] Content-pack article import failed");
    res.status(500).json({ error: "Content-pack article import failed" });
  }
});

// GET /api/admin/articles/:id — full row incl. blocks
adminRouter.get("/articles/:id", async (req, res) => {
  try {
    const row = await db.query.contents.findFirst({ where: eq(contents.id, req.params.id) });
    if (!row) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    res.json({ article: row });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to get article");
    res.status(500).json({ error: "Failed to get article" });
  }
});

// POST /api/admin/articles — create manual draft
adminRouter.post("/articles", async (req, res) => {
  try {
    const { title, slug, summary, blocks, metaTitle, metaDescription } = req.body || {};
    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (blocks !== undefined && !isValidBlocks(blocks)) {
      res.status(400).json({ error: "blocks must be an array of {id, type, data} objects" });
      return;
    }

    let finalSlug: string;
    if (slug && typeof slug === "string" && slug.trim()) {
      finalSlug = normalizeSlug(slug);
      if (!finalSlug) {
        res.status(400).json({ error: "Invalid slug" });
        return;
      }
      const existing = await db
        .select({ id: contents.id })
        .from(contents)
        .where(eq(contents.slug, finalSlug))
        .limit(1);
      if (existing.length > 0) {
        res.status(409).json({ error: "Slug already in use" });
        return;
      }
    } else {
      finalSlug = await buildUniqueSlug(title.trim());
    }

    // Sanitise on create too — the update path already does. An operator (or a
    // compromised operator session) posting raw <script> in a block would
    // otherwise become stored XSS on the customer's live site.
    const contentBlocks: ContentBlock[] = sanitizeBlocks(blocks ?? []);

    const [contentRecord] = await db
      .insert(contents)
      .values({
        type: "article",
        status: "draft",
        title: plainText(title.trim()),
        slug: finalSlug,
        summary: summary ? plainText(String(summary)) : null,
        metaTitle: metaTitle ? plainText(String(metaTitle)) : null,
        metaDescription: metaDescription ? plainText(String(metaDescription)) : null,
        blocks: contentBlocks,
        wordCount: countWordsInBlocks(contentBlocks),
        writerId: "manual",
        generatedByAI: false,
      })
      .returning();

    await db.insert(articles).values({
      contentId: contentRecord.id,
      category: "manual",
      excerpt: summary ? String(summary).substring(0, 200) : null,
    });

    logger.info({ contentId: contentRecord.id, slug: finalSlug }, "[Admin] Manual draft created");
    res.status(201).json({ article: contentRecord });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to create article");
    res.status(500).json({ error: "Failed to create article" });
  }
});

// PUT /api/admin/articles/:id — update fields incl. blocks
adminRouter.put("/articles/:id", async (req, res) => {
  try {
    const existing = await db.query.contents.findFirst({
      where: eq(contents.id, req.params.id),
    });
    if (!existing) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    const body = req.body || {};
    const updates: Partial<typeof contents.$inferInsert> = {};

    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        res.status(400).json({ error: "title must be a non-empty string" });
        return;
      }
      updates.title = body.title.trim();
    }
    if (body.slug !== undefined) {
      const slug = normalizeSlug(String(body.slug));
      if (!slug) {
        res.status(400).json({ error: "Invalid slug" });
        return;
      }
      if (slug !== existing.slug) {
        const dup = await db
          .select({ id: contents.id })
          .from(contents)
          .where(and(eq(contents.slug, slug), ne(contents.id, existing.id)))
          .limit(1);
        if (dup.length > 0) {
          res.status(409).json({ error: "Slug already in use" });
          return;
        }
      }
      updates.slug = slug;
    }
    if (body.blocks !== undefined) {
      if (!isValidBlocks(body.blocks)) {
        res.status(400).json({ error: "blocks must be an array of {id, type, data} objects" });
        return;
      }
      // The pipeline sanitises as it builds blocks (job-handlers.ts:753) but
      // this path did not, so one editor save could store XSS that the blog
      // then renders on the customer's own domain.
      const cleaned = sanitizeBlocks(body.blocks as ContentBlock[]);
      updates.blocks = cleaned;
      updates.wordCount = countWordsInBlocks(cleaned);
    }

    // Simple nullable text fields
    for (const field of [
      "summary",
      "metaTitle",
      "metaDescription",
      "answerCapsule",
      "heroImage",
      "heroImageAlt",
      "cardImage",
      "cardImageAlt",
      "primaryKeyword",
      "writerId",
    ] as const) {
      if (body[field] !== undefined) {
        updates[field] = body[field] === null ? null : String(body[field]);
      }
    }
    if (body.seoSchema !== undefined) {
      if (!body.seoSchema || typeof body.seoSchema !== "object") {
        res.status(400).json({ error: "seoSchema must be an object or array" });
        return;
      }
      updates.seoSchema = withoutLegacyRichResultSchema(body.seoSchema);
    }
    // Key facts shown beside the article on the customer sites. Either the
    // structured QuickFacts object or an explicit list of {label, value}
    // pairs (what the site importers render verbatim); null clears them.
    if (body.quickFacts !== undefined) {
      const facts = body.quickFacts;
      const isPairList =
        Array.isArray(facts) &&
        facts.length > 0 &&
        facts.every(
          (fact: unknown) =>
            !!fact &&
            typeof fact === "object" &&
            typeof (fact as { label?: unknown }).label === "string" &&
            typeof (fact as { value?: unknown }).value === "string",
        );
      const isObject = !!facts && typeof facts === "object" && !Array.isArray(facts);
      if (facts !== null && !isPairList && !isObject) {
        res.status(400).json({ error: "quickFacts must be an object, a list of {label, value} pairs, or null" });
        return;
      }
      updates.quickFacts = facts as typeof contents.$inferInsert.quickFacts;
    }
    if (body.publishedAt !== undefined) {
      if (existing.status !== "published") {
        res.status(409).json({ error: "publishedAt can only be corrected on a published article" });
        return;
      }
      const publishedAt = body.publishedAt === null ? null : new Date(body.publishedAt);
      if (publishedAt && Number.isNaN(publishedAt.getTime())) {
        res.status(400).json({ error: "publishedAt must be an ISO datetime or null" });
        return;
      }
      updates.publishedAt = publishedAt;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updatable fields provided" });
      return;
    }

    if (
      body.title !== undefined ||
      body.primaryKeyword !== undefined ||
      body.answerCapsule !== undefined ||
      body.blocks !== undefined
    ) {
      const qualityIssues = await auditContentAgainstCorpus({
        id: existing.id,
        title: String(updates.title ?? existing.title),
        primaryKeyword: (updates.primaryKeyword ?? existing.primaryKeyword) as string | null,
        answerCapsule: (updates.answerCapsule ?? existing.answerCapsule) as string | null,
        blocks: (updates.blocks ?? existing.blocks) as ContentBlock[],
      });
      if (qualityIssues.length > 0) {
        res.status(422).json({ error: "Content quality gate failed", issues: qualityIssues });
        return;
      }
    }

    updates.updatedAt = new Date();

    const [updated] = await db
      .update(contents)
      .set(updates)
      .where(eq(contents.id, existing.id))
      .returning();

    let redelivery: { ok: boolean; retryable?: boolean } | undefined;
    if (existing.status === "published" && updated) {
      void notifyBlog("updated", {
        slug: updated.slug,
        updatedAt: updated.updatedAt ?? new Date(),
      });
      void notifySiteDeploy("updated", updated.slug);
      // Push-delivered sites (git, WordPress) only see the edit if it is
      // delivered again; awaited so the editor learns when the site did NOT
      // take the correction, instead of finding the old text still live.
      const result = await redeliverPublishedContent(updated.id);
      redelivery = result.ok
        ? { ok: true }
        : { ok: false, retryable: result.reason === "target_failed" ? result.retryable : false };
    }

    res.json({ article: updated, ...(redelivery ? { redelivery } : {}) });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to update article");
    res.status(500).json({ error: "Failed to update article" });
  }
});

// POST /api/admin/articles/regenerate-images — batch re-render heroes via the queue.
// Defined BEFORE the "/:id/..." routes so "regenerate-images" isn't read as an id.
adminRouter.post("/articles/regenerate-images", async (req, res) => {
  try {
    if (!isImageProviderConfigured()) {
      res.status(503).json({ error: "No image provider configured (OpenAI + R2 env required)" });
      return;
    }
    const statusFilter = req.body?.status === "all" ? null : (req.body?.status ?? "draft");
    const limit = Math.min(Math.max(Number(req.body?.limit) || 300, 1), 1000);

    const rows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(statusFilter ? eq(contents.status, statusFilter as ContentStatus) : undefined)
      .orderBy(desc(contents.createdAt))
      .limit(limit);

    for (const row of rows) {
      await jobQueue.addJob("regenerate_image", { contentId: row.id }, { priority: 5 });
    }

    logger.info({ count: rows.length, statusFilter }, "[Admin] Enqueued hero regeneration");
    res.json({ enqueued: rows.length });
  } catch (error) {
    logger.error({ error }, "[Admin] Batch image regeneration failed");
    res.status(500).json({ error: "Batch image regeneration failed" });
  }
});

// POST /api/admin/articles/backfill-meta — enqueue concise-slug + Quick Facts
// backfill for older drafts, one job per row, drained through the queue.
// Defined BEFORE the "/:id/..." routes so "backfill-meta" isn't read as an id.
// The handler is idempotent and skips published rows, so this is safe to re-run.
adminRouter.post("/articles/backfill-meta", async (req, res) => {
  try {
    const statusFilter = req.body?.status === "all" ? null : (req.body?.status ?? "draft");
    const limit = Math.min(Math.max(Number(req.body?.limit) || 500, 1), 2000);
    // force re-derives Quick Facts even when already present (refresh pass).
    const force = req.body?.force === true;

    const rows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(statusFilter ? eq(contents.status, statusFilter as ContentStatus) : undefined)
      .orderBy(desc(contents.createdAt))
      .limit(limit);

    for (const row of rows) {
      await jobQueue.addJob("backfill_meta", { contentId: row.id, force }, { priority: 6 });
    }

    logger.info({ count: rows.length, statusFilter, force }, "[Admin] Enqueued metadata backfill");
    res.json({ enqueued: rows.length, force });
  } catch (error) {
    logger.error({ error }, "[Admin] Batch metadata backfill failed");
    res.status(500).json({ error: "Batch metadata backfill failed" });
  }
});

// POST /api/admin/articles/:id/regenerate-image — re-render one hero inline.
adminRouter.post("/articles/:id/regenerate-image", async (req, res) => {
  try {
    const url = await regenerateArticleImage(req.params.id);
    res.json({ heroImage: url });
  } catch (error) {
    if (error instanceof NoImageProviderError) {
      res.status(503).json({ error: "No image provider configured (OpenAI + R2 env required)" });
      return;
    }
    if (error instanceof ContentNotFoundError) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    logger.error({ error, id: req.params.id }, "[Admin] Image regeneration failed");
    res.status(500).json({ error: "Image regeneration failed" });
  }
});

// POST /api/admin/articles/:id/regenerate-media — hero + explicit body-image
// plan in one call, for backfilling articles whose writer never attached
// media. Body items require a caption (see the gate in publish.ts: a generic
// caption fails just as hard as a missing one).
adminRouter.post("/articles/:id/regenerate-media", async (req, res) => {
  try {
    const plan = Array.isArray(req.body?.mediaPlan) ? (req.body.mediaPlan as MediaPlanItem[]) : [];
    if (plan.length === 0) {
      res.status(400).json({ error: "mediaPlan is required" });
      return;
    }
    const result = await regenerateArticleMedia(req.params.id, plan, { replace: req.body?.replace === true });
    res.json(result);
  } catch (error) {
    if (error instanceof NoImageProviderError) {
      res.status(503).json({ error: "No image provider configured (OpenAI + R2 env required)" });
      return;
    }
    if (error instanceof ContentNotFoundError) {
      res.status(404).json({ error: "Article not found" });
      return;
    }
    logger.error({ error, id: req.params.id }, "[Admin] Media regeneration failed");
    res.status(500).json({ error: "Media regeneration failed" });
  }
});

// POST /api/admin/articles/:id/publish — publish immediately (shared logic)
/**
 * Ask for a promo video for one article. Enqueued rather than rendered inline:
 * a render takes tens of seconds, and an admin request must not hold a
 * connection open for it.
 */
adminRouter.post("/articles/:id/video", async (req: Request, res: Response) => {
  if (!entitled("article-video")) {
    res.status(403).json({ error: "Article video is not in this customer's plan" });
    return;
  }
  const [row] = await db
    .select({ id: contents.id })
    .from(contents)
    .where(eq(contents.id, req.params.id))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "No such article" });
    return;
  }

  await jobQueue.addJob("render_article_video", { contentId: row.id }, { priority: 7 });
  res.status(202).json({ queued: true, contentId: row.id });
});

/**
 * Approve without publishing: in_review → draft. The publish scheduler's
 * auto-slot pass then gives it a randomised calendar slot, and the promote
 * pass publishes it on time. The operator's whole job is this one verb.
 */
// POST /api/admin/sources/backfill — bring existing articles up to the source
// rule: resolve aggregator links (news.google.com) to the publisher and open
// the official pages it points at, recording them in articles.source_checks.
// Articles written before 2026-09-15 all carry the raw feed link, and the
// source-primary gate would hold every one of them on the next review.
adminRouter.post("/sources/backfill", async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.body?.limit) || 200, 1), 1000);
  const force = req.body?.force === true;
  try {
    const rows = await db
      .select({ id: articles.id, contentId: articles.contentId, sourceUrl: articles.sourceUrl, sourceChecks: articles.sourceChecks })
      .from(articles)
      .where(and(isNotNull(articles.sourceUrl), isNull(articles.deletedAt)))
      .orderBy(desc(articles.createdAt))
      .limit(limit);
    const summary = { scanned: rows.length, resolved: 0, checked: 0, unresolved: [] as string[], skipped: 0 };
    for (const row of rows) {
      const url = row.sourceUrl ?? "";
      const needsResolve = isAggregatorUrl(url);
      const needsChecks = force || !row.sourceChecks || row.sourceChecks.length === 0;
      if (!needsResolve && !needsChecks) {
        summary.skipped += 1;
        continue;
      }
      const resolved = needsResolve ? await resolveSourceUrl(url) : { url, via: "as-is" as const };
      if (needsResolve && resolved.via === "unresolved") summary.unresolved.push(row.contentId);
      const checks = await discoverPrimarySources(resolved.url);
      await db
        .update(articles)
        .set({ sourceUrl: resolved.url, sourceChecks: checks, updatedAt: new Date() })
        .where(eq(articles.id, row.id));
      if (resolved.via !== "as-is" && resolved.via !== "unresolved") summary.resolved += 1;
      if (checks.length > 0) summary.checked += 1;
    }
    logger.info(summary, "[Admin] Source backfill complete");
    res.json(summary);
  } catch (error) {
    logger.error({ error }, "[Admin] Source backfill failed");
    res.status(500).json({ error: "Source backfill failed" });
  }
});

// POST /api/admin/articles/:id/re-review — put an article that is waiting in
// review back through Gate 2 from the top. For the articles a broken revision
// path stranded (see gatekeeper/revise.ts): their jobs died, nothing would ever
// pick them up again, and re-running the review is the honest restart.
adminRouter.post("/articles/:id/re-review", async (req: Request, res: Response) => {
  const [row] = await db
    .select({ id: contents.id, status: contents.status })
    .from(contents)
    .where(and(eq(contents.id, req.params.id), eq(contents.status, "in_review")))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "No article in review with that id" });
    return;
  }
  const jobId = await jobQueue.addJob(
    "gatekeeper_review",
    { contentId: row.id, revisionCount: 0 },
    { priority: 2 }
  );
  res.json({ queued: true, id: row.id, jobId });
});

adminRouter.post("/articles/:id/approve", async (req: Request, res: Response) => {
  const [row] = await db
    .update(contents)
    .set({ status: "draft", updatedAt: new Date() })
    .where(and(eq(contents.id, req.params.id), eq(contents.status, "in_review")))
    .returning({ id: contents.id });
  if (!row) {
    res.status(404).json({ error: "No article in review with that id" });
    return;
  }
  res.json({ approved: true, id: row.id });
});

adminRouter.post("/articles/:id/publish", async (req, res) => {
  try {
    const result = await publishContentById(req.params.id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ error: "Article not found" });
      } else if (result.reason === "media_not_ready") {
        res.status(409).json({ error: "Article media is not ready" });
      } else if (result.reason === "content_quality") {
        res.status(422).json({ error: "Content quality gate failed", issues: result.issues });
      } else {
        res.status(result.retryable ? 503 : 502).json({ error: "Publication target failed" });
      }
      return;
    }
    res.json({ article: result.article });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to publish article");
    res.status(500).json({ error: "Failed to publish article" });
  }
});

// POST /api/admin/articles/:id/schedule { scheduledFor } — publish at a future time.
// Sets status=scheduled; the publish-scheduler tick promotes it when due.
adminRouter.post("/articles/:id/schedule", async (req, res) => {
  try {
    const raw = req.body?.scheduledFor;
    const when = raw ? new Date(raw) : null;
    if (!when || Number.isNaN(when.getTime())) {
      res.status(400).json({ error: "Invalid scheduledFor (expected ISO datetime)" });
      return;
    }
    if (when.getTime() <= Date.now()) {
      res.status(400).json({ error: "scheduledFor must be in the future" });
      return;
    }

    const [updated] = await db
      .update(contents)
      .set({ status: "scheduled", scheduledFor: when, publishedAt: null, updatedAt: new Date() })
      .where(eq(contents.id, req.params.id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    logger.info(
      { contentId: updated.id, scheduledFor: when.toISOString() },
      "[Admin] Article scheduled"
    );
    res.json({ article: updated });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to schedule article");
    res.status(500).json({ error: "Failed to schedule article" });
  }
});

// POST /api/admin/articles/:id/unpublish — back to draft
adminRouter.post("/articles/:id/unpublish", async (req, res) => {
  try {
    // Archived, NOT draft: the publish scheduler auto-slots any unscheduled
    // draft, so unpublishing to draft made the article republish itself on the
    // next tick. Archived is terminal until an operator revives it.
    const [updated] = await db
      .update(contents)
      .set({ status: "archived", publishedAt: null, scheduledFor: null, updatedAt: new Date() })
      .where(and(eq(contents.id, req.params.id), isNull(contents.deletedAt)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    // Removal has to reach the blog too, or the page stays live on the
    // customer's domain until the next reconcile window.
    void notifyBlog("unpublished", { slug: updated.slug, updatedAt: updated.updatedAt ?? new Date() });
    void notifySiteDeploy("unpublished", updated.slug);

    logger.info({ contentId: updated.id }, "[Admin] Article unpublished");
    res.json({ article: updated });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to unpublish article");
    res.status(500).json({ error: "Failed to unpublish article" });
  }
});

// DELETE /api/admin/articles/:id — soft delete (tombstone)
//
// This used to be a hard DELETE, which is unrecoverable in a pull-based
// architecture: the consuming blog syncs by asking "what changed since X", and
// a row that no longer exists cannot appear in that answer. The page stayed
// live on the customer's domain forever. The row now stays, marked, so the
// sync endpoint can return it as `{slug, deleted:true}` and the blog can purge
// it. `updatedAt` is bumped for exactly that reason.
adminRouter.delete("/articles/:id", async (req, res) => {
  try {
    const deletedAt = new Date();
    const [deleted] = await db
      .update(contents)
      .set({ deletedAt, status: "archived", updatedAt: deletedAt })
      .where(and(eq(contents.id, req.params.id), isNull(contents.deletedAt)))
      .returning({ id: contents.id, slug: contents.slug });

    if (!deleted) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    // The sibling row is tombstoned rather than removed: src/index.ts:158 left
    // joins it, and deleting it would start returning null category/tags for a
    // row that still exists.
    await db
      .update(articles)
      .set({ deletedAt, updatedAt: deletedAt })
      .where(eq(articles.contentId, deleted.id));

    void notifyBlog("deleted", { slug: deleted.slug, updatedAt: deletedAt });
    void notifySiteDeploy("deleted", deleted.slug);

    logger.info({ contentId: deleted.id }, "[Admin] Article deleted (tombstoned)");
    res.json({ deleted: true, id: deleted.id });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to delete article");
    res.status(500).json({ error: "Failed to delete article" });
  }
});

// POST /api/admin/articles/:id/qa — run Gate2 review without changing status
adminRouter.post("/articles/:id/qa", async (req, res) => {
  try {
    const row = await db.query.contents.findFirst({ where: eq(contents.id, req.params.id) });
    if (!row) {
      res.status(404).json({ error: "Article not found" });
      return;
    }

    const input: ArticleApprovalInput = {
      contentId: row.id,
      title: row.title,
      metaTitle: row.metaTitle ?? row.title,
      metaDescription: row.metaDescription ?? "",
      summary: row.summary ?? "",
      answerCapsule: row.answerCapsule ?? undefined,
      blocks: row.blocks ?? [],
      wordCount: row.wordCount ?? 0,
      writerId: row.writerId ?? "manual",
    };

    const result = await getGate2Approver().review(input, 0);

    res.json({
      qa: {
        decision: result.decision,
        overallQuality: result.overallQuality,
        aeoScore: result.aeoScore,
        aeoChecklist: result.aeoChecklist,
        issues: result.issues,
        corrections: result.corrections,
        publicationReady: result.publicationReady,
        reasoning: result.reasoning,
        editorNotes: result.editorNotes,
        processingTimeMs: result.processingTimeMs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown";
    logger.error({ error: message, id: req.params.id }, "[Admin] QA review failed");
    if (message.includes("No available engine") || message.includes("engines failed")) {
      res.status(503).json({ error: "No LLM engine available — configure an API key to run QA" });
      return;
    }
    res.status(500).json({ error: "QA review failed" });
  }
});

// ── Feeds ─────────────────────────────────────────────────────────────────

// GET /api/admin/feeds — all feeds + per-feed item counts
adminRouter.get("/feeds", async (_req, res) => {
  try {
    const feeds = await db.select().from(rssFeeds).orderBy(desc(rssFeeds.createdAt));

    // rss_feed_items is created dynamically by the RSS reader — raw SQL
    const countMap = new Map<string, number>();
    try {
      const rows = await db.execute(sql`
        SELECT feed_id, COUNT(*)::int AS item_count
        FROM rss_feed_items
        GROUP BY feed_id
      `);
      for (const row of rows as unknown as Array<{ feed_id: string; item_count: number }>) {
        countMap.set(row.feed_id, Number(row.item_count));
      }
    } catch {
      // Table not created yet — counts stay 0
    }

    res.json({
      feeds: feeds.map(f => ({ ...f, itemCount: countMap.get(f.id) ?? 0 })),
    });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to list feeds");
    res.status(500).json({ error: "Failed to list feeds" });
  }
});

// POST /api/admin/feeds — same as legacy POST /api/feeds
adminRouter.post("/feeds", addFeedHandler);

// PATCH /api/admin/feeds/:id — { isActive?, name?, fetchIntervalMinutes? }
adminRouter.patch("/feeds/:id", async (req, res) => {
  try {
    const body = req.body || {};
    const updates: Partial<typeof rssFeeds.$inferInsert> = {};

    if (body.isActive !== undefined) updates.isActive = Boolean(body.isActive);
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        res.status(400).json({ error: "name must be a non-empty string" });
        return;
      }
      updates.name = body.name.trim();
    }
    if (body.fetchIntervalMinutes !== undefined) {
      const interval = Number(body.fetchIntervalMinutes);
      if (!Number.isFinite(interval) || interval < 1) {
        res.status(400).json({ error: "fetchIntervalMinutes must be a positive number" });
        return;
      }
      updates.fetchIntervalMinutes = Math.round(interval);
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No updatable fields provided" });
      return;
    }

    const [updated] = await db
      .update(rssFeeds)
      .set(updates)
      .where(eq(rssFeeds.id, req.params.id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Feed not found" });
      return;
    }

    res.json({ feed: updated });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to update feed");
    res.status(500).json({ error: "Failed to update feed" });
  }
});

// DELETE /api/admin/feeds/:id
adminRouter.delete("/feeds/:id", async (req, res) => {
  try {
    const [deleted] = await db
      .delete(rssFeeds)
      .where(eq(rssFeeds.id, req.params.id))
      .returning({ id: rssFeeds.id });

    if (!deleted) {
      res.status(404).json({ error: "Feed not found" });
      return;
    }

    // rss_feed_items rows cascade via FK (ON DELETE CASCADE)
    logger.info({ feedId: deleted.id }, "[Admin] Feed deleted");
    res.json({ deleted: true, id: deleted.id });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to delete feed");
    res.status(500).json({ error: "Failed to delete feed" });
  }
});

// ── Document Library ────────────────────────────────────────────────────────

// POST /api/admin/library/upload — multipart, one or more files.
// Extracts text synchronously, inserts a document row, enqueues idea mining.
adminRouter.post("/library/upload", upload.array("files", 20), async (req, res) => {
  try {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded (field name must be 'files')" });
      return;
    }

    const created: Array<Record<string, unknown>> = [];

    for (const file of files) {
      let extractedText: string | null = null;
      let status: "extracted" | "failed" = "extracted";
      let errorMessage: string | null = null;

      try {
        extractedText = await extractText(file.originalname, file.mimetype, file.buffer);
      } catch (err) {
        status = "failed";
        errorMessage = err instanceof Error ? err.message : "Extraction failed";
      }

      const [doc] = await db
        .insert(documents)
        .values({
          filename: file.originalname,
          mimeType: file.mimetype || "application/octet-stream",
          sizeBytes: file.size,
          extractedText,
          status,
          errorMessage,
        })
        .returning();

      // Only enqueue idea mining if extraction succeeded.
      if (status === "extracted") {
        await jobQueue.addJob(
          "library_extract_ideas",
          { documentId: doc.id },
          { priority: 2 }
        );
      }

      created.push({
        id: doc.id,
        filename: doc.filename,
        status: doc.status,
        sizeBytes: doc.sizeBytes,
        errorMessage: doc.errorMessage,
      });
    }

    logger.info({ count: created.length }, "[Admin] Library documents uploaded");
    res.status(201).json({ documents: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    logger.error({ error: message }, "[Admin] Library upload failed");
    res.status(400).json({ error: message });
  }
});

// GET /api/admin/library/documents — list with ideaCount + status
adminRouter.get("/library/documents", async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: documents.id,
        filename: documents.filename,
        mimeType: documents.mimeType,
        sizeBytes: documents.sizeBytes,
        status: documents.status,
        errorMessage: documents.errorMessage,
        ideaCount: documents.ideaCount,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .orderBy(desc(documents.createdAt));

    res.json({ documents: rows });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to list documents");
    res.status(500).json({ error: "Failed to list documents" });
  }
});

// GET /api/admin/library/documents/:id — document + its mined ideas
adminRouter.get("/library/documents/:id", async (req, res) => {
  try {
    const doc = await db.query.documents.findFirst({
      where: eq(documents.id, req.params.id),
    });
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    const items = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.documentId, doc.id))
      .orderBy(desc(libraryItems.createdAt));

    // Omit the (potentially large) full text from the detail payload.
    const { extractedText, ...rest } = doc;
    res.json({
      document: { ...rest, textLength: extractedText?.length ?? 0 },
      items,
    });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to get document");
    res.status(500).json({ error: "Failed to get document" });
  }
});

// DELETE /api/admin/library/documents/:id — cascades to library_items
adminRouter.delete("/library/documents/:id", async (req, res) => {
  try {
    const [deleted] = await db
      .delete(documents)
      .where(eq(documents.id, req.params.id))
      .returning({ id: documents.id });

    if (!deleted) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    logger.info({ documentId: deleted.id }, "[Admin] Document deleted");
    res.json({ deleted: true, id: deleted.id });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to delete document");
    res.status(500).json({ error: "Failed to delete document" });
  }
});

// POST /api/admin/library/viral-ideas — synthesise shareable roundup ideas
// across the WHOLE knowledge base. { count?: number (1-30, default 10), brief?: string }
adminRouter.post("/library/viral-ideas", async (req, res) => {
  try {
    const rawCount = Number(req.body?.count);
    const count = Number.isFinite(rawCount) ? Math.min(Math.max(Math.round(rawCount), 1), 30) : 10;
    const brief =
      typeof req.body?.brief === "string" && req.body.brief.trim()
        ? req.body.brief.trim().slice(0, 2000)
        : undefined;

    const { documentId, items } = await generateViralIdeas(count, brief);

    logger.info({ documentId, count: items.length }, "[Admin] Viral ideas generated");
    res.status(201).json({ documentId, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown";
    logger.error({ error: message }, "[Admin] Viral idea generation failed");
    if (message.includes("Knowledge base is empty")) {
      res.status(422).json({ error: message });
      return;
    }
    if (
      message.includes("engines failed") ||
      message.includes("No available engine") ||
      message.includes("no usable")
    ) {
      res
        .status(503)
        .json({ error: "No LLM engine available — configure an API key to brainstorm viral ideas" });
      return;
    }
    res.status(500).json({ error: "Viral idea generation failed" });
  }
});

// GET /api/admin/library/items?status=&documentId=&collection=viral
adminRouter.get("/library/items", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const documentId = typeof req.query.documentId === "string" ? req.query.documentId : "";
    const collection = typeof req.query.collection === "string" ? req.query.collection : "";

    const conditions: SQL[] = [];
    if (status) {
      if (!VALID_LIBRARY_STATUSES.includes(status as LibraryItemStatus)) {
        res
          .status(400)
          .json({ error: `Invalid status. One of: ${VALID_LIBRARY_STATUSES.join(", ")}` });
        return;
      }
      conditions.push(eq(libraryItems.status, status as LibraryItemStatus));
    }
    if (documentId) {
      conditions.push(eq(libraryItems.documentId, documentId));
    }
    // Cross-document synthesis (viral) items are tagged via suggestedTopicId.
    if (collection === "viral") {
      conditions.push(eq(libraryItems.suggestedTopicId, VIRAL_TOPIC_MARKER));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const query = db
      .select()
      .from(libraryItems)
      .orderBy(desc(libraryItems.createdAt))
      .limit(200);

    const rows = where ? await query.where(where) : await query;
    res.json({ items: rows });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to list library items");
    res.status(500).json({ error: "Failed to list library items" });
  }
});

// POST /api/admin/library/items/:id/write-now — enqueue a write job immediately
adminRouter.post("/library/items/:id/write-now", async (req, res) => {
  try {
    const item = await db.query.libraryItems.findFirst({
      where: eq(libraryItems.id, req.params.id),
    });
    if (!item) {
      res.status(404).json({ error: "Library item not found" });
      return;
    }
    if (item.status === "writing" || item.status === "queued") {
      res.status(409).json({ error: `Item already ${item.status}` });
      return;
    }

    await db
      .update(libraryItems)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(libraryItems.id, item.id));

    await jobQueue.addJob("library_write", { libraryItemId: item.id }, { priority: 2 });

    logger.info({ libraryItemId: item.id }, "[Admin] Library item queued for write");
    res.json({ queued: true, id: item.id });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to queue library item");
    res.status(500).json({ error: "Failed to queue library item" });
  }
});

// DELETE /api/admin/library/items/:id
adminRouter.delete("/library/items/:id", async (req, res) => {
  try {
    const [deleted] = await db
      .delete(libraryItems)
      .where(eq(libraryItems.id, req.params.id))
      .returning({ id: libraryItems.id });

    if (!deleted) {
      res.status(404).json({ error: "Library item not found" });
      return;
    }

    res.json({ deleted: true, id: deleted.id });
  } catch (error) {
    logger.error({ error, id: req.params.id }, "[Admin] Failed to delete library item");
    res.status(500).json({ error: "Failed to delete library item" });
  }
});

// ── Preview ───────────────────────────────────────────────────────────────

// GET /api/admin/preview-config — base URL + token the Review console uses to
// build the live design-preview iframe URL. Auth-gated (editors only).
adminRouter.get("/preview-config", (_req, res) => {
  // No hardcoded fallback. A compiled-in default was one customer's domain
  // shipped inside every other customer's admin bundle; an unconfigured preview
  // must be visibly absent, not silently pointed at someone else's site.
  res.json({
    baseUrl: process.env.PREVIEW_SITE_URL || SITE_URL || null,
    token: process.env.PREVIEW_TOKEN || null,
    articlePathPrefix: ARTICLE_PATH_PREFIX,
  });
});

// ── Pipeline ──────────────────────────────────────────────────────────────

adminRouter.post("/pipeline/trigger", triggerPipelineHandler);

// ── Stats / dashboard ─────────────────────────────────────────────────────

/**
 * Auto-schedule: hand every approved, unscheduled draft a randomised future
 * slot. One button in the Studio; the site's public rhythm comes out human —
 * varying counts per day, odd minutes, inside the configured window.
 */
adminRouter.post("/schedule/auto", async (_req: Request, res: Response) => {
  const drafts = await db
    .select({ id: contents.id })
    .from(contents)
    .where(and(eq(contents.status, "draft"), isNull(contents.scheduledFor)))
    .orderBy(contents.createdAt);

  if (drafts.length === 0) {
    res.json({ scheduled: 0 });
    return;
  }

  const config = autoScheduleConfig();
  const slots = planSlots(drafts.length, config);
  for (let i = 0; i < drafts.length; i++) {
    await db
      .update(contents)
      .set({ status: "scheduled", scheduledFor: slots[i], updatedAt: new Date() })
      .where(eq(contents.id, drafts[i].id));
  }

  logger.info({ scheduled: drafts.length, perDay: config.perDay }, "[Admin] Auto-scheduled drafts");
  res.json({ scheduled: drafts.length, firstSlot: slots[0], lastSlot: slots[slots.length - 1] });
});

// GET /api/admin/costs — what this install has spent on models and images.
// In-memory since boot: the honest label for the Studio is "since restart".
adminRouter.get("/costs", async (_req: Request, res: Response) => {
  // Live snapshot for "what is happening", ledger for "what did it cost" —
  // the ledger is the durable one and survives restarts.
  try {
    const [live, ledger] = [getCostDashboard(), await ledgerReport()];
    res.json({ ...live, ledger });
  } catch {
    res.json({ ...getCostDashboard(), ledger: null });
  }
});

// GET /api/admin/stats — dashboard payload
// GET /api/admin/ranks — this month's positions against last month's.
adminRouter.get("/ranks", async (_req, res) => {
  try {
    const [report, status] = await Promise.all([rankReport(), rankTrackerStatus()]);
    res.json({ ...report, tracker: status });
  } catch (error) {
    logger.error({ error }, "[Admin] Rank report failed");
    res.status(500).json({ error: "Could not read the rankings" });
  }
});

// POST /api/admin/ranks/measure — a reading now, outside the monthly rhythm.
// The tracker never needs this; it exists for the day a client asks "and now?"
adminRouter.post("/ranks/measure", async (_req, res) => {
  try {
    const run = await measureRankings();
    res.json({ measured: run !== null, run });
  } catch (error) {
    logger.error({ error }, "[Admin] Rank measurement failed");
    res.status(500).json({ error: "Could not measure the rankings" });
  }
});

adminRouter.get("/stats", async (_req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const scheduler = getRSSSchedulerStatus();
    const libraryScheduler = getLibrarySchedulerStatus();

    const [
      schedulerStats,
      jobStats,
      statusRows,
      todayRows,
      weekRows,
      activeFeedRows,
      libraryStats,
    ] = await Promise.all([
        getSchedulerStats(),
        jobQueue.getStats(),
        db.select({ status: contents.status, total: count() }).from(contents).groupBy(
          contents.status
        ),
        db
          .select({ total: count() })
          .from(contents)
          .where(and(eq(contents.type, "article"), gte(contents.createdAt, startOfToday))),
        db
          .select({ total: count() })
          .from(contents)
          .where(and(eq(contents.type, "article"), gte(contents.createdAt, startOfWeek))),
        db.select({ total: count() }).from(rssFeeds).where(eq(rssFeeds.isActive, true)),
        getLibraryStats(),
      ]);

    const countsByStatus: Record<string, number> = {};
    for (const row of statusRows) countsByStatus[row.status] = row.total;

    // Recent Gate1 decisions (raw table)
    let recentItems: unknown[] = [];
    try {
      const rows = await db.execute(sql`
        SELECT id, title, source, gate1_score, gate1_decision, gate1_tier,
               processed, created_at
        FROM rss_feed_items
        ORDER BY created_at DESC
        LIMIT 20
      `);
      recentItems = (rows as unknown as Array<Record<string, unknown>>).map(r => ({
        id: r.id,
        title: r.title,
        source: r.source,
        gate1Score: r.gate1_score,
        gate1Decision: r.gate1_decision,
        gate1Tier: r.gate1_tier,
        processed: r.processed,
        createdAt: r.created_at,
      }));
    } catch {
      // Table not created yet
    }

    res.json({
      pipeline: {
        scheduler,
        today: schedulerStats,
        jobs: jobStats,
      },
      counts: countsByStatus,
      articlesToday: todayRows[0]?.total ?? 0,
      articlesThisWeek: weekRows[0]?.total ?? 0,
      activeFeeds: activeFeedRows[0]?.total ?? 0,
      recentGate1: recentItems,
      library: {
        scheduler: libraryScheduler,
        documents: libraryStats.documents,
        ideasPending: libraryStats.ideasPending,
        publishedFromLibrary: libraryStats.publishedTotal,
        publishedToday: libraryStats.publishedToday,
      },
    });
  } catch (error) {
    logger.error({ error }, "[Admin] Failed to get stats");
    res.status(500).json({ error: "Failed to get stats" });
  }
});
