/**
 * WordPress publishing target.
 *
 * Constraints that shaped this file:
 *
 *  - **No plugin.** The customer's site already runs, already has articles,
 *    and nobody is installing anything for us. So: core REST API
 *    only, authenticated with an Application Password over HTTP Basic. Anything
 *    that would need `register_meta` or a companion plugin is out.
 *  - **Never a duplicate.** A duplicate article on a live site is a failure the
 *    customer's readers see. Idempotency therefore has two independent layers:
 *    the stored remote id, and — when that is missing or stale — a lookup by
 *    slug. Losing the database must not cost the customer a second copy of
 *    every article.
 *  - **Never a half-publish.** If the hero image cannot be delivered, the post
 *    is not written at all. A post that is live but wrong is harder to notice,
 *    and harder to fix, than a job that failed loudly and will be retried.
 *  - **Never a lie.** The reference (and its content hash) is only written after
 *    WordPress has confirmed the write. Everything else returns a failure with
 *    the retryability the queue needs.
 *
 * The one thing core WordPress genuinely cannot promise is JSON-LD: post
 * content is stripped of `<script>` for any author without `unfiltered_html`.
 * We inject it, then read the stored content back and report a `structuredData`
 * degradation when it did not survive — visible, rather than silently missing
 * schema on every article.
 */

import { describeDegradation } from "./capabilities.js";
import { request, requestBytes, type FetchLike, type HttpResult } from "./http.js";
import type {
  Degradation,
  NormalisedArticle,
  PublishErrorCode,
  PublishOutcome,
  PublishingTarget,
  RemoteRef,
  TargetCapabilities,
  TargetCheck,
} from "./types.js";
import { capabilities, failed, RETRYABLE } from "./types.js";
import type { RemoteRefStore } from "./remote-ref-store.js";

export interface WordPressConfig {
  /** Site root, e.g. https://example.com — not the /wp-json path. */
  baseUrl: string;
  username: string;
  /** An Application Password. Spaces in the displayed form are ignored. */
  applicationPassword: string;
  timeoutMs?: number;
  /**
   * Absolute origin for the engine's root-relative links. Passed to
   * `normaliseArticle`, not used here; kept in the config so one place
   * describes one target.
   */
  internalLinkBase?: string | null;
}

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** WordPress wants a local-time-shaped string for `date_gmt`, without the "Z". */
function toWpGmt(date: Date): string {
  return date.toISOString().replace(/Z$/, "");
}

function jsonLdHtml(objects: Record<string, unknown>[]): string {
  if (objects.length === 0) return "";
  const scripts = objects.map(
    // Escaping "<" keeps a headline containing "</script>" from closing the block.
    object =>
      `<script type="application/ld+json">${JSON.stringify(object).replace(/</g, "\\u003c")}</script>`
  );
  return `\n${scripts.join("\n")}`;
}

interface WpPost {
  id: number;
  link?: string;
  content?: { raw?: string; rendered?: string };
}

interface WpTerm {
  id: number;
  slug: string;
}

export class WordPressTarget implements PublishingTarget {
  readonly kind = "wordpress";
  readonly id: string;
  readonly capabilities: TargetCapabilities = capabilities({
    // Core WordPress can do all of it — the honest caveat is structuredData,
    // which is reported per publish rather than declared impossible, because it
    // depends on the connected user's capabilities and not on WordPress itself.
    bodyFormat: "html",
  });

  /** Origin the engine's root-relative links resolve against. Read by the registry. */
  readonly linkBase: string | null;

  private readonly api: string;
  private readonly authorization: string;
  private readonly configured: boolean;

  constructor(
    private readonly config: WordPressConfig,
    private readonly store: RemoteRefStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    const base = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.configured = Boolean(base && config.username?.trim() && config.applicationPassword?.trim());
    this.api = `${base}/wp-json/wp/v2`;
    this.id = `wordpress:${hostOf(base)}`;
    this.linkBase = config.internalLinkBase?.trim() || null;
    // WordPress displays application passwords in groups of four; the spaces are
    // presentation only, and a pasted password that keeps them must still work.
    const password = (config.applicationPassword ?? "").replace(/\s+/g, "");
    this.authorization =
      "Basic " + Buffer.from(`${config.username ?? ""}:${password}`).toString("base64");
  }

  // ==========================================================================
  // PUBLIC SURFACE
  // ==========================================================================

  async check(): Promise<TargetCheck> {
    if (!this.configured) {
      return { ok: false, code: "config", retryable: false, message: "WordPress target incomplete" };
    }
    const result = await this.call("users/me?context=edit");
    if (result.ok) return { ok: true };
    return {
      ok: false,
      code: result.code,
      retryable: RETRYABLE[result.code],
      message: result.message,
    };
  }

  async publish(article: NormalisedArticle): Promise<PublishOutcome> {
    if (!this.configured) {
      return failed("config", "WordPress target is missing a URL, user or application password");
    }
    try {
      return await this.doPublish(article);
    } catch (error) {
      // Nothing may escape: an uncaught throw here is a publish whose result
      // nobody classified, which is how "published" ends up meaning nothing.
      return failed("unknown", error instanceof Error ? error.message : String(error));
    }
  }

  async unpublish(article: Pick<NormalisedArticle, "id" | "slug">): Promise<PublishOutcome> {
    if (!this.configured) return failed("config", "WordPress target is not configured");
    try {
      const ref = await this.store.get(this.id, article.id);
      if (!ref?.remoteId) return { status: "unchanged", remote: ref ?? null, degraded: [] };

      // Draft, never DELETE. The post is the customer's content, and an engine
      // that can permanently destroy it is an engine nobody should connect.
      const result = await this.call(`posts/${ref.remoteId}`, {
        method: "POST",
        json: { status: "draft" },
      });
      if (!result.ok) {
        if (result.code === "not_found") {
          await this.store.forget(this.id, article.id);
          return { status: "unchanged", remote: null, degraded: [] };
        }
        return failed(result.code, result.message);
      }

      // Clearing the hash means the next publish rewrites the post in full
      // rather than deciding nothing changed while it sits there as a draft.
      const updated: RemoteRef = { ...ref, contentHash: null, updatedAt: new Date() };
      await this.store.put(updated);
      return { status: "written", action: "updated", remote: updated, degraded: [] };
    } catch (error) {
      return failed("unknown", error instanceof Error ? error.message : String(error));
    }
  }

  // ==========================================================================
  // THE PUBLISH FLOW
  // ==========================================================================

  private async doPublish(article: NormalisedArticle): Promise<PublishOutcome> {
    const degraded = describeDegradation(this.capabilities, article);
    let ref: RemoteRef = (await this.store.get(this.id, article.id)) ?? {
      targetId: this.id,
      articleId: article.id,
      remoteId: null,
      remoteUrl: null,
      mediaId: null,
      contentHash: null,
      updatedAt: new Date(),
    };

    // 1. Where does this article already live? Stored id first, slug second.
    const located = await this.locate(article, ref);
    if ("error" in located) return failed(located.error.code, located.error.message, degraded);
    const existing = located.post;

    // 2. Nothing to do — but only if the post is genuinely still there. A stored
    //    hash matching a post the customer deleted would otherwise report
    //    success for content that no longer exists.
    if (existing && ref.remoteId === String(existing.id) && ref.contentHash === article.contentHash) {
      return { status: "unchanged", remote: ref, degraded };
    }

    // 3. Hero image. Uploaded before the post so the post can reference it, and
    //    remembered immediately so a failure at step 5 does not orphan it.
    let mediaId = ref.mediaId;
    if (article.heroImage) {
      const media = await this.resolveMedia(article, ref);
      if (!media.ok) return failed("media_failed", media.message, degraded);
      if (media.mediaId !== ref.mediaId) {
        mediaId = media.mediaId;
        // Written now, before the post, so that a failure at step 5 leaves the
        // uploaded image findable instead of orphaned in the customer's media
        // library. The content hash stays untouched: nothing is live yet.
        ref = {
          ...ref,
          mediaId,
          remoteId: existing ? String(existing.id) : ref.remoteId,
          updatedAt: new Date(),
        };
        await this.store.put(ref);
      }
    }

    // 4. Taxonomy. Missing terms are created; a site that forbids that degrades
    //    explicitly rather than publishing a silently uncategorised article.
    const categories = await this.resolveTerms(
      "categories",
      article.category ? [article.category] : [],
      degraded
    );
    if ("error" in categories) return failed(categories.error.code, categories.error.message, degraded);
    const tags = await this.resolveTerms("tags", article.tags, degraded);
    if ("error" in tags) return failed(tags.error.code, tags.error.message, degraded);

    // 5. The write itself.
    const jsonLd = jsonLdHtml(article.structuredData);
    const payload: Record<string, unknown> = {
      title: article.title,
      slug: article.slug,
      content: article.html + jsonLd,
      status: this.statusFor(article),
      categories: categories.ids,
      tags: tags.ids,
    };
    if (article.excerpt) payload.excerpt = article.excerpt;
    if (mediaId) payload.featured_media = Number(mediaId);
    if (article.publishedAt) payload.date_gmt = toWpGmt(article.publishedAt);

    const path = existing ? `posts/${existing.id}` : "posts";
    const result = await this.call(path, { method: "POST", json: payload });
    if (!result.ok) return failed(result.code, result.message, degraded);

    const written = result.body as WpPost | undefined;
    if (!written || typeof written.id !== "number") {
      return failed("unknown", "WordPress returned no post id", degraded);
    }

    // 6. Did the JSON-LD survive? Only an author with `unfiltered_html` keeps
    //    <script> in post content, and the customer must be told when it went.
    const stored = written.content?.raw ?? written.content?.rendered;
    if (jsonLd && typeof stored === "string" && !stored.includes("application/ld+json")) {
      degraded.push({
        feature: "structuredData",
        detail:
          "WordPress stripped the JSON-LD from the post content — the connected user lacks the unfiltered_html capability",
      });
    }

    // 7. Only now is it true.
    const saved: RemoteRef = {
      ...ref,
      remoteId: String(written.id),
      remoteUrl: written.link ?? null,
      mediaId,
      contentHash: article.contentHash,
      updatedAt: new Date(),
    };
    await this.store.put(saved);

    return {
      status: "written",
      action: existing ? "updated" : "created",
      remote: saved,
      degraded,
    };
  }

  private statusFor(article: NormalisedArticle): string {
    if (article.state !== "published") return "draft";
    // WordPress schedules through the "future" status; sending "publish" with a
    // future date_gmt publishes it immediately instead.
    if (article.publishedAt && article.publishedAt.getTime() > Date.now()) return "future";
    return "publish";
  }

  // ==========================================================================
  // STEPS
  // ==========================================================================

  private async locate(
    article: NormalisedArticle,
    ref: RemoteRef
  ): Promise<{ post: WpPost | null } | { error: { code: PublishErrorCode; message: string } }> {
    if (ref.remoteId) {
      const byId = await this.call(`posts/${ref.remoteId}?context=edit`);
      if (byId.ok) {
        const post = byId.body as WpPost | undefined;
        if (post && typeof post.id === "number") return { post };
      } else if (byId.code !== "not_found") {
        return { error: { code: byId.code, message: byId.message } };
      }
      // 404: the customer deleted it. Fall through — the slug lookup below may
      // still find a replacement, and otherwise we create a fresh one.
    }

    const bySlug = await this.call(
      `posts?slug=${encodeURIComponent(article.slug)}&status=any&per_page=1&context=edit`
    );
    if (!bySlug.ok) return { error: { code: bySlug.code, message: bySlug.message } };
    if (!Array.isArray(bySlug.body)) {
      return { error: { code: "unknown", message: "WordPress returned a non-list of posts" } };
    }
    const first = bySlug.body[0] as WpPost | undefined;
    return { post: first && typeof first.id === "number" ? first : null };
  }

  private async resolveMedia(
    article: NormalisedArticle,
    ref: RemoteRef
  ): Promise<{ ok: true; mediaId: string } | { ok: false; message: string }> {
    const hero = article.heroImage!;

    if (ref.mediaId) {
      const existing = await this.call(`media/${ref.mediaId}`);
      if (existing.ok) return { ok: true, mediaId: ref.mediaId };
      if (existing.code !== "not_found") return { ok: false, message: existing.message };
      // Deleted from the media library — fall through and upload it again.
    }

    const bytes = await requestBytes(hero.url, {
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!bytes.ok) return { ok: false, message: `hero image: ${bytes.message}` };

    const extension = hero.filename.split(".").pop()?.toLowerCase() ?? "";
    const contentType = bytes.contentType.startsWith("image/")
      ? bytes.contentType
      : (EXTENSION_MIME[extension] ?? "image/png");

    const upload = await this.call("media", {
      method: "POST",
      body: bytes.bytes,
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${hero.filename}"`,
      },
    });
    if (!upload.ok) return { ok: false, message: upload.message };
    const created = upload.body as { id?: number } | undefined;
    if (!created || typeof created.id !== "number") {
      return { ok: false, message: "WordPress returned no media id" };
    }

    // Alt text is a second call and a nice-to-have: a failure here must not
    // cost the customer the image itself.
    if (hero.alt) {
      await this.call(`media/${created.id}`, { method: "POST", json: { alt_text: hero.alt } });
    }

    return { ok: true, mediaId: String(created.id) };
  }

  private async resolveTerms(
    taxonomy: "categories" | "tags",
    terms: { slug: string; name: string }[],
    degraded: Degradation[]
  ): Promise<{ ids: number[] } | { error: { code: PublishErrorCode; message: string } }> {
    const ids: number[] = [];
    for (const term of terms) {
      const found = await this.call(`${taxonomy}?slug=${encodeURIComponent(term.slug)}&per_page=1`);
      if (!found.ok) return { error: { code: found.code, message: found.message } };
      const match = Array.isArray(found.body) ? (found.body[0] as WpTerm | undefined) : undefined;
      if (match && typeof match.id === "number") {
        ids.push(match.id);
        continue;
      }

      const created = await this.call(taxonomy, {
        method: "POST",
        json: { name: term.name, slug: term.slug },
      });
      if (!created.ok) {
        // Many installs let an editor write posts but not create terms. That is
        // a real loss of data, so it is reported — not a reason to fail the
        // whole publish and leave the article unpublished.
        if (created.code === "unauthorized" || created.code === "rejected") {
          degraded.push({
            feature: taxonomy === "categories" ? "categories" : "tags",
            detail: `could not create ${taxonomy.slice(0, -1)} "${term.slug}": ${created.message}`,
          });
          continue;
        }
        return { error: { code: created.code, message: created.message } };
      }
      const term_ = created.body as WpTerm | undefined;
      if (term_ && typeof term_.id === "number") ids.push(term_.id);
    }
    return { ids };
  }

  // ==========================================================================
  // TRANSPORT
  // ==========================================================================

  private call(
    path: string,
    options: {
      method?: string;
      json?: unknown;
      body?: Uint8Array;
      headers?: Record<string, string>;
    } = {}
  ): Promise<HttpResult> {
    const headers: Record<string, string> = {
      authorization: this.authorization,
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    let body: string | Uint8Array | undefined = options.body;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    return request(`${this.api}/${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}

function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base || "unconfigured";
  }
}
