/**
 * Shared publish logic — used by the manual admin route
 * (POST /api/admin/articles/:id/publish) and by the scheduler tick that
 * promotes `scheduled` articles when their time arrives. Single source of
 * truth so manual and timed publishing behave identically (JSON-LD rebuilt
 * with the real publication date, AEO re-scored, IndexNow pinged).
 */

import { and, eq, ne } from "drizzle-orm";

import { db } from "../db.js";
import { contents, articles } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { submitToIndexNow } from "../lib/indexing.js";
import { notifyBlog, notifySiteDeploy } from "../lib/site-notify.js";
import { notifyFieldSource } from "./field/telegram.js";
import { deliverArticle, resolveTargets, type DeliveryReport } from "../publishing/index.js";
import { schemaGenerator, aeoValidator, ARTICLE_PATH_PREFIX } from "./aeo.js";
import { verifyArticleLiveness } from "./liveness.js";
import { auditContentAgainstCorpus, type ContentQualityIssue } from "./content-quality.js";

export type PublishResult =
  | { ok: true; article: typeof contents.$inferSelect; delivery?: DeliveryReport }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "media_not_ready" }
  | { ok: false; reason: "content_quality"; issues: ContentQualityIssue[] }
  | { ok: false; reason: "target_failed"; retryable: boolean; delivery: DeliveryReport };

const GENERIC_MEDIA_TEXT = /^(?:image|photo|illustration|visual|editorial visualization)(?:\s+\d+)?$/i;

function isValidMediaUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".webp");
  } catch {
    return false;
  }
}

function isDescriptiveAlt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const alt = value.trim();
  return alt.length >= 20 && alt.length <= 180 && !GENERIC_MEDIA_TEXT.test(alt);
}

function requireArticleMedia(): boolean {
  return ["true", "1", "yes", "on"].includes((process.env.REQUIRE_ARTICLE_MEDIA ?? "false").toLowerCase());
}

type MediaFields = { heroImage: string | null; heroImageAlt: string | null; blocks: unknown };

/** The publish media rule: a WebP hero and exactly two described body images. */
function mediaReady(row: MediaFields): boolean {
  if (!requireArticleMedia()) return true;
  const blocks = (Array.isArray(row.blocks) ? row.blocks : []) as { type?: string; data?: unknown }[];
  const bodyImages = blocks.filter((block) => block.type === "image");
  const bodyImagesReady =
    bodyImages.length === 2 &&
    bodyImages.every((block) => {
      const data = (block.data ?? {}) as { url?: string; alt?: string; caption?: string };
      return isValidMediaUrl(data.url) && isDescriptiveAlt(data.alt) && !GENERIC_MEDIA_TEXT.test(data.caption?.trim() ?? "");
    });
  return isValidMediaUrl(row.heroImage) && isDescriptiveAlt(row.heroImageAlt) && bodyImagesReady;
}

export type PublishBlocker =
  | { reason: "content_quality"; issues: ContentQualityIssue[] }
  | { reason: "media_not_ready" };

/**
 * The same checks publishContentById runs, without touching the row. Used to
 * clear an approved article before it takes a calendar slot, so a scheduled
 * article is one that will actually go out on its day.
 */
export async function publishBlocker(id: string): Promise<PublishBlocker | null> {
  const [row] = await db
    .select({
      title: contents.title,
      heroImage: contents.heroImage,
      heroImageAlt: contents.heroImageAlt,
      blocks: contents.blocks,
      answerCapsule: contents.answerCapsule,
      primaryKeyword: contents.primaryKeyword,
    })
    .from(contents)
    .where(eq(contents.id, id));
  if (!row) return null;
  const issues = await auditContentAgainstCorpus({
    id,
    title: row.title,
    primaryKeyword: row.primaryKeyword,
    answerCapsule: row.answerCapsule,
    blocks: row.blocks,
  });
  if (issues.length > 0) return { reason: "content_quality", issues };
  if (!mediaReady(row)) return { reason: "media_not_ready" };
  return null;
}

/** Publish a single content row by id. Idempotent-safe to call on any status. */
export async function publishContentById(id: string): Promise<PublishResult> {
  const publishedAt = new Date();

  // Claim the row atomically: transition an unpublished row to a transient
  // 'publishing' state, and proceed only if THIS call won the flip. Two
  // scheduler ticks, or a tick racing a manual publish, cannot both deliver
  // the same article. On any failure below, status is restored to 'scheduled'
  // so the next tick retries.
  const [claimed] = await db
    .update(contents)
    .set({ status: "publishing", updatedAt: publishedAt })
    .where(and(eq(contents.id, id), ne(contents.status, "published"), ne(contents.status, "publishing")))
    .returning({ id: contents.id });
  if (!claimed) {
    const [existing] = await db
      .select({ id: contents.id, status: contents.status })
      .from(contents)
      .where(eq(contents.id, id));
    if (!existing) return { ok: false, reason: "not_found" };
    // Someone else already has it (publishing) or finished it (published).
    return { ok: true, article: existing as typeof contents.$inferSelect };
  }

  const restore = async () => {
    await db
      .update(contents)
      .set({ status: "scheduled", updatedAt: new Date() })
      .where(and(eq(contents.id, id), eq(contents.status, "publishing")));
  };

  const [row] = await db
    .select({
      title: contents.title,
      slug: contents.slug,
      metaDescription: contents.metaDescription,
      summary: contents.summary,
      heroImage: contents.heroImage,
      heroImageAlt: contents.heroImageAlt,
      blocks: contents.blocks,
      writerId: contents.writerId,
      answerCapsule: contents.answerCapsule,
      primaryKeyword: contents.primaryKeyword,
      faq: articles.faq,
      category: articles.category,
      excerpt: articles.excerpt,
      tags: articles.relatedTopicIds,
      sourceUrl: articles.sourceUrl,
    })
    .from(contents)
    .leftJoin(articles, eq(articles.contentId, contents.id))
    .where(eq(contents.id, id));

  if (!row) return { ok: false, reason: "not_found" };

  const contentQualityIssues = await auditContentAgainstCorpus({
    id,
    title: row.title,
    primaryKeyword: row.primaryKeyword,
    answerCapsule: row.answerCapsule,
    blocks: row.blocks,
  });
  if (contentQualityIssues.length > 0) {
    // Permanent, not transient: the audit is deterministic against the corpus,
    // so the same article fails the same way on every tick. Restoring it to
    // `scheduled` made the publisher claim, audit and release it every 60s
    // forever, left it overdue for good (the fleet monitor then reported the
    // publisher as not running while it was running the whole time), and
    // showed nobody that anything needed fixing. Park it for a person, the
    // same way a permanent delivery failure is parked below. The slot is
    // cleared so a later Approve lets the auto-slotter pick it up again.
    await db
      .update(contents)
      .set({ status: "in_review", scheduledFor: null, updatedAt: new Date() })
      .where(and(eq(contents.id, id), eq(contents.status, "publishing")));
    logger.warn(
      { contentId: id, slug: row.slug, issues: contentQualityIssues },
      "[Publish] Editorial quality gate blocked publication — article parked in review"
    );
    return { ok: false, reason: "content_quality", issues: contentQualityIssues };
  }

  if (!mediaReady(row)) {
    // Same permanent-failure shape as the editorial quality gate above:
    // missing/invalid media doesn't fix itself between ticks, so restoring
    // to `scheduled` just re-fails forever and keeps the article overdue
    // (the fleet monitor then reports the publisher as down while it is
    // running fine). Park it for a person instead; the slot is cleared so
    // a later Approve with real media lets the auto-slotter pick it up.
    await db
      .update(contents)
      .set({ status: "in_review", scheduledFor: null, updatedAt: new Date() })
      .where(and(eq(contents.id, id), eq(contents.status, "publishing")));
    logger.warn(
      { contentId: id, slug: row.slug },
      "[Publish] Media gate blocked publication — article parked in review"
    );
    return { ok: false, reason: "media_not_ready" };
  }

  // A how-to with a real numbered list earns HowTo schema; steps must mirror
  // the visible list exactly, so they come straight from the blocks.
  const howIntent = /\bhow\b/i.test(row.title);
  const orderedList = howIntent
    ? (row.blocks ?? []).find(
        (b) =>
          b.type === "list" &&
          (b.data as { ordered?: boolean; items?: string[] }).ordered === true &&
          ((b.data as { items?: string[] }).items?.length ?? 0) >= 3
      )
    : undefined;

  const jsonLd = schemaGenerator.generateFullSchema({
    title: row.title,
    description: row.metaDescription || row.summary || "",
    slug: row.slug,
    heroImage: row.heroImage,
    faqs: row.faq || [],
    steps: orderedList ? ((orderedList.data as { items?: string[] }).items ?? []) : undefined,
    authorName:
      typeof row.writerId === "string" && row.writerId.trim() && row.writerId !== "[object Object]"
        ? row.writerId
        : undefined,
    publishedAt,
  });
  const aeo = aeoValidator.validate({
    answerCapsule: row.answerCapsule,
    faqs: row.faq || [],
    schemas: jsonLd,
  });

  // Remote targets go FIRST, before the engine's own status is flipped.
  //
  // The engine must never hold a row that says "published" while the customer's
  // WordPress does not have the article. Writing the status first and delivering
  // afterwards makes every delivery failure a silent lie that only a human
  // reading the customer's site would ever catch. This way a failure leaves the
  // row exactly as it was — `scheduled` articles are retried by the next
  // scheduler tick, and a manual publish reports the failure to the operator.
  //
  // With no targets configured this is a no-op, which is every deployment that
  // publishes only to our own read API.
  const targets = resolveTargets();
  let delivery: DeliveryReport | undefined;
  if (targets.length > 0) {
    delivery = await deliverArticle(
      {
        id,
        title: row.title,
        slug: row.slug,
        excerpt: row.excerpt,
        summary: row.summary,
        metaDescription: row.metaDescription,
        blocks: row.blocks,
        category: row.category,
        tags: row.tags,
        heroImage: row.heroImage,
        heroImageAlt: row.heroImageAlt,
        seoSchema: jsonLd,
        publishedAt,
        state: "published",
        answerCapsule: row.answerCapsule,
        sourceUrl: row.sourceUrl,
      },
      targets
    );
    if (!delivery.ok) {
      logger.error(
        { contentId: id, slug: row.slug, retryable: delivery.retryable },
        "[Publish] Remote target delivery failed — article NOT marked published"
      );
      if (delivery.retryable) {
        // Transient — back to scheduled, the next tick tries again.
        await restore();
      } else {
        // Permanent (bad credentials, a 4xx): retrying every 60s forever is
        // just noise. Park it as in_review so an operator sees and fixes the
        // target, rather than the scheduler hammering a doomed delivery.
        await db
          .update(contents)
          .set({ status: "in_review", updatedAt: new Date() })
          .where(and(eq(contents.id, id), eq(contents.status, "publishing")));
      }
      return { ok: false, reason: "target_failed", retryable: delivery.retryable, delivery };
    }
  }

  const [updated] = await db
    .update(contents)
    .set({
      status: "published",
      publishedAt,
      scheduledFor: null,
      updatedAt: publishedAt,
      seoSchema: jsonLd,
      aeoScore: aeo.overallScore,
    })
    .where(eq(contents.id, id))
    .returning();

  if (!updated) return { ok: false, reason: "not_found" };

  submitToIndexNow([`${ARTICLE_PATH_PREFIX}/${updated.slug}`]).catch((err: unknown) => {
    logger.warn(
      { contentId: updated.id, error: err },
      "[Publish] IndexNow notification failed (non-fatal)"
    );
  });

  // Liveness check (SEO-F): GET the public URL and record what came up.
  // Fire-and-forget like IndexNow — the article is already published, and a
  // verification failure is a Studio flag, never a publish failure.
  verifyArticleLiveness({ id: updated.id, slug: updated.slug }).catch((err: unknown) => {
    logger.warn(
      { contentId: updated.id, error: err },
      "[Publish] Liveness verification failed (non-fatal)"
    );
  });

  // Tell the tenant's blog to drop this article's cache tag so the new article
  // is live in seconds rather than at the next 5-minute reconcile. Deliberately
  // not awaited: the reconcile cron is the safety net, and a customer's blog
  // being down must never fail a publish.
  void notifyBlog("published", { slug: updated.slug, updatedAt: publishedAt });
  void notifySiteDeploy("published", updated.slug);
  // Material that came from the field desk: the group that sent it hears
  // first, with the link. Best-effort, never in the way of the publish.
  void notifyFieldSource(updated.id, updated.slug, ARTICLE_PATH_PREFIX);

  logger.info(
    { contentId: updated.id, slug: updated.slug, targets: delivery?.results.length ?? 0 },
    "[Publish] Article published"
  );
  return { ok: true, article: updated, delivery };
}

export type RedeliverResult =
  | { ok: true; delivery?: DeliveryReport }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_published" }
  | { ok: false; reason: "target_failed"; retryable: boolean; delivery: DeliveryReport };

/**
 * Push a LIVE article through the remote targets again, after an editor
 * changed it. Same payload as a publish, same targets, but the original
 * publication date is kept and the engine's status never moves.
 *
 * Without this, a correction made in Studio to a published article updated
 * only the engine row: POST /publish short-circuits on "already published",
 * and a git-delivered site kept serving the text the editor had just fixed.
 */
export async function redeliverPublishedContent(id: string): Promise<RedeliverResult> {
  const targets = resolveTargets();
  if (targets.length === 0) return { ok: true };

  const [row] = await db
    .select({
      id: contents.id,
      status: contents.status,
      publishedAt: contents.publishedAt,
      title: contents.title,
      slug: contents.slug,
      metaDescription: contents.metaDescription,
      summary: contents.summary,
      heroImage: contents.heroImage,
      heroImageAlt: contents.heroImageAlt,
      blocks: contents.blocks,
      answerCapsule: contents.answerCapsule,
      seoSchema: contents.seoSchema,
      category: articles.category,
      excerpt: articles.excerpt,
      tags: articles.relatedTopicIds,
      sourceUrl: articles.sourceUrl,
    })
    .from(contents)
    .leftJoin(articles, eq(articles.contentId, contents.id))
    .where(eq(contents.id, id));

  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "published") return { ok: false, reason: "not_published" };

  const delivery = await deliverArticle(
    {
      id,
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      summary: row.summary,
      metaDescription: row.metaDescription,
      blocks: row.blocks,
      category: row.category,
      tags: row.tags,
      heroImage: row.heroImage,
      heroImageAlt: row.heroImageAlt,
      seoSchema: row.seoSchema,
      publishedAt: row.publishedAt ?? new Date(),
      state: "published",
      answerCapsule: row.answerCapsule,
      sourceUrl: row.sourceUrl,
    },
    targets
  );

  if (!delivery.ok) {
    logger.error(
      { contentId: id, slug: row.slug, retryable: delivery.retryable },
      "[Publish] Re-delivery of an edited live article failed — the site still has the old version"
    );
    return { ok: false, reason: "target_failed", retryable: delivery.retryable, delivery };
  }

  logger.info({ contentId: id, slug: row.slug, targets: delivery.results.length }, "[Publish] Edited article re-delivered");
  return { ok: true, delivery };
}
