/**
 * The public `/api/site/*` surface — the contract between the engine and a
 * customer's blog.
 *
 * The helper modules for this surface (site-auth, site-cursor) already existed
 * but the routes were never mounted, so the blog could not load at all: every
 * page died on `GET /api/site/config` returning 404.
 *
 * Scoping model: Octypo is installed per customer, one deployment per site, so
 * *this deployment is the tenant*. Config comes from the environment and every
 * query is naturally scoped because the database holds one customer's content.
 * When volume justifies shared multi-tenancy, the only change here is resolving
 * the tenant from the site key instead of the environment — which is why
 * `siteConfigFromEnv` and the query helpers take the config as an argument
 * rather than reaching for `process.env` inline.
 *
 * Everything served here is published-only and read-only. A draft must never
 * escape through this surface.
 */

import { Router, type Request, type Response } from "express";
import { and, count, eq, desc, isNotNull, lt, or } from "drizzle-orm";

import { db } from "../db.js";
import { contents, articles } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import {
  constantTimeEquals,
  createRequireSiteKey,
  hashSiteKey,
  type SiteKeyLookup,
} from "./site-auth.js";

export interface SiteConfig {
  slug: string;
  siteName: string;
  siteUrl: string;
  articlePathPrefix: string;
  topicPathPrefix: string;
  locale: string;
  brand: Record<string, unknown>;
  plan?: string;
}

/** Reads the single-install identity. Kept separate so tests need no env. */
export function siteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SiteConfig {
  let brand: Record<string, unknown> = {};
  if (env.OCTYPO_BRAND) {
    try {
      const parsed: unknown = JSON.parse(env.OCTYPO_BRAND);
      // A malformed brand must not take the whole site down — the customer
      // simply gets the default theme until it is fixed.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        brand = parsed as Record<string, unknown>;
      }
    } catch {
      logger.warn("[site] OCTYPO_BRAND is not valid JSON — falling back to the default theme");
    }
  }

  return {
    slug: env.OCTYPO_SITE_SLUG?.trim() || "default",
    siteName: env.SITE_NAME?.trim() || "Octypo",
    siteUrl: (env.SITE_URL || "").replace(/\/+$/, "") || "https://example.com",
    articlePathPrefix: env.ARTICLE_PATH_PREFIX?.trim() || "/guides",
    topicPathPrefix: env.TOPIC_PATH_PREFIX?.trim() || "/topics",
    locale: env.OCTYPO_LOCALE?.trim() || "en",
    brand,
    ...(env.BILLING_PLAN ? { plan: env.BILLING_PLAN } : {}),
  };
}

/**
 * A single install has no tenant table, so the one valid key is the one in the
 * environment — this deployment *is* the tenant. Only the hash is compared, and
 * only in constant time, so the check behaves like the multi-tenant lookup it
 * will one day be replaced by.
 *
 * Returns null when no key is configured. Enforcing unconditionally would take
 * every already-deployed blog offline the moment this shipped; an install
 * without a key keeps its previous open behaviour and says so in the log.
 */
export function envSiteKeyLookup(
  config: SiteConfig,
  env: NodeJS.ProcessEnv = process.env
): SiteKeyLookup | null {
  const configured = (env.OCTYPO_SITE_KEY ?? "").trim();
  if (!configured) return null;

  const expected = hashSiteKey(configured);
  return (keyHash: string) =>
    Promise.resolve(
      constantTimeEquals(keyHash, expected)
        ? { tenantId: config.slug, tenantSlug: config.slug, revokedAt: null }
        : null
    );
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function readLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function readOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 100_000);
}

/**
 * Keyset cursor over (updatedAt, id). Offset paging would silently skip or
 * repeat rows while the engine keeps publishing during a sync.
 */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): { updatedAt: Date; id: string } | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const updatedAt = new Date(iso ?? "");
    if (Number.isNaN(updatedAt.getTime()) || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

function toSummary(row: Record<string, any>) {
  return {
    slug: row.slug,
    title: row.title,
    metaTitle: row.metaTitle ?? null,
    metaDescription: row.metaDescription ?? null,
    summary: row.summary ?? null,
    answerCapsule: row.answerCapsule ?? null,
    heroImage: row.heroImage ?? null,
    heroImageAlt: row.heroImageAlt ?? null,
    cardImage: row.cardImage ?? row.heroImage ?? null,
    cardImageAlt: row.cardImageAlt ?? row.heroImageAlt ?? null,
    category: row.category ?? null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    wordCount: row.wordCount ?? null,
    publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
    updatedAt: new Date(row.updatedAt ?? row.publishedAt ?? Date.now()).toISOString(),
  };
}

export function createSiteRouter(config: SiteConfig = siteConfigFromEnv()): Router {
  const router = Router();

  const lookup = envSiteKeyLookup(config);
  if (lookup) {
    router.use(createRequireSiteKey(lookup));
  } else {
    logger.warn(
      "[site] OCTYPO_SITE_KEY is not set — /api/site/* is answering unauthenticated callers"
    );
  }

  router.get("/config", (_req: Request, res: Response) => {
    res.json({ tenant: config });
  });

  router.get("/articles", async (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const where = cursor
      ? and(
          eq(contents.status, "published"),
          or(
            lt(contents.updatedAt, cursor.updatedAt),
            and(eq(contents.updatedAt, cursor.updatedAt), lt(contents.id, cursor.id))
          )
        )
      : eq(contents.status, "published");

    const rows = await db
      .select({
        content: contents,
        category: articles.category,
        tags: articles.relatedTopicIds,
      })
      .from(contents)
      .leftJoin(articles, eq(articles.contentId, contents.id))
      .where(where)
      .orderBy(desc(contents.updatedAt), desc(contents.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor(new Date(last.content.updatedAt as any), last.content.id)
        : null;

    res.json({
      items: page.map((row) =>
        toSummary({ ...row.content, category: row.category, tags: row.tags })
      ),
      nextCursor,
    });
  });

  router.get("/publications", async (req: Request, res: Response) => {
    const limit = readLimit(req.query.limit);
    const offset = readOffset(req.query.offset);
    const where = and(eq(contents.status, "published"), isNotNull(contents.publishedAt));

    const [rows, totals] = await Promise.all([
      db
        .select({
          content: contents,
          category: articles.category,
          tags: articles.relatedTopicIds,
        })
        .from(contents)
        .leftJoin(articles, eq(articles.contentId, contents.id))
        .where(where)
        .orderBy(desc(contents.publishedAt), desc(contents.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(contents).where(where),
    ]);

    res.json({
      items: rows.map((row) =>
        toSummary({ ...row.content, category: row.category, tags: row.tags })
      ),
      total: Number(totals[0]?.total ?? 0),
      limit,
      offset,
    });
  });

  router.get("/articles/:slug", async (req: Request, res: Response) => {
    const slug = String(req.params.slug || "");
    const [row] = await db
      .select()
      .from(contents)
      .where(and(eq(contents.slug, slug), eq(contents.status, "published")))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const [extra] = await db
      .select({
        faq: articles.faq,
        category: articles.category,
        tags: articles.relatedTopicIds,
      })
      .from(articles)
      .where(eq(articles.contentId, row.id))
      .limit(1);

    let seoSchema: unknown = null;
    if (row.seoSchema) {
      try {
        seoSchema = typeof row.seoSchema === "string" ? JSON.parse(row.seoSchema) : row.seoSchema;
      } catch {
        // Malformed JSON-LD must not break the page; the blog omits the block.
        logger.warn({ slug }, "[site] stored seoSchema is not valid JSON");
      }
    }

    res.json({
      article: {
        ...toSummary({ ...row, category: extra?.category, tags: extra?.tags }),
        blocks: Array.isArray(row.blocks) ? row.blocks : [],
        quickFacts: (row as any).quickFacts ?? null,
        seoSchema,
        faq: extra?.faq ?? null,
      },
    });
  });

  /** Slug + updatedAt only — what the reconcile cron needs to spot drift cheaply. */
  router.get("/manifest", async (req: Request, res: Response) => {
    const cursor = decodeCursor(req.query.cursor);
    const limit = MAX_LIMIT;

    const where = cursor
      ? and(
          eq(contents.status, "published"),
          or(
            lt(contents.updatedAt, cursor.updatedAt),
            and(eq(contents.updatedAt, cursor.updatedAt), lt(contents.id, cursor.id))
          )
        )
      : eq(contents.status, "published");

    const rows = await db
      .select({ id: contents.id, slug: contents.slug, updatedAt: contents.updatedAt })
      .from(contents)
      .where(where)
      .orderBy(desc(contents.updatedAt), desc(contents.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];

    res.json({
      count: page.length,
      entries: page.map((r) => ({
        slug: r.slug,
        updatedAt: new Date(r.updatedAt as any).toISOString(),
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor(new Date(last.updatedAt as any), last.id) : null,
    });
  });

  router.get("/topics/:slug", async (req: Request, res: Response) => {
    const slug = String(req.params.slug || "");
    const limit = readLimit(req.query.limit);

    const rows = await db
      .select({
        content: contents,
        category: articles.category,
        tags: articles.relatedTopicIds,
      })
      .from(contents)
      .leftJoin(articles, eq(articles.contentId, contents.id))
      .where(eq(contents.status, "published"))
      .orderBy(desc(contents.updatedAt))
      .limit(500);

    const matching = rows.filter((r) => {
      const tags = Array.isArray(r.tags) ? r.tags : [];
      return tags.includes(slug) || r.category === slug;
    });

    res.json({
      topic: { slug, name: slug },
      items: matching
        .slice(0, limit)
        .map((row) => toSummary({ ...row.content, category: row.category, tags: row.tags })),
      nextCursor: null,
    });
  });

  return router;
}

export { encodeCursor, decodeCursor, toSummary, readLimit, readOffset };
