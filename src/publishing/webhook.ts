/**
 * Generic outbound webhook target — how a bespoke CMS integrates.
 *
 * This adapter exists for two reasons. The obvious one: plenty of customers run
 * something we will never write an adapter for, and a signed POST of the whole
 * normalised article is enough for them to build their side in an afternoon.
 *
 * The less obvious one, and the reason it was built second: an interface proven
 * by exactly one implementation is not an interface, it is that implementation
 * with extra indirection. WordPress has posts, a media library, term ids and a
 * two-phase image upload. A webhook has none of that — it has one endpoint, one
 * body, one status code. Anything in the contract that quietly assumed
 * WordPress breaks here, which is the point.
 *
 * What it deliberately does NOT do: fetch the hero image. A receiver gets the
 * image URL and pulls the bytes itself if it wants them, which is why
 * `hostsMedia` is false. That is a real difference in capability, not a loss —
 * the URL is in the payload either way.
 *
 * The signature is the same scheme the Octypo blog already verifies
 * (src/lib/site-webhook.ts): `t=<unix>,v1=hmac(t.body)`. Sharing it means a
 * customer who has implemented one endpoint has implemented both, and the
 * timestamp inside the signed material is what stops a captured delivery being
 * replayed forever.
 */

import { createHmac } from "node:crypto";

import { describeDegradation } from "./capabilities.js";
import { request, type FetchLike } from "./http.js";
import { SIGNATURE_HEADER } from "../lib/site-webhook.js";
import type {
  NormalisedArticle,
  PublishOutcome,
  PublishingTarget,
  RemoteRef,
  TargetCapabilities,
  TargetCheck,
} from "./types.js";
import { capabilities, failed, RETRYABLE } from "./types.js";
import type { RemoteRefStore } from "./remote-ref-store.js";

export interface WebhookConfig {
  /** The receiver's endpoint. One URL takes every event. */
  url: string;
  /** Shared secret for the HMAC. Required — an unsigned publish webhook is an open write endpoint. */
  secret: string;
  timeoutMs?: number;
  /** Optional label, so two webhooks on the same host stay distinguishable. */
  name?: string;
}

export type ArticleEvent = "published" | "unpublished";

/**
 * Canonical JSON. Key order is part of the signed material, so it is written
 * out by hand rather than left to whatever order the object happens to have.
 */
export function serialiseArticleEvent(event: ArticleEvent, article: NormalisedArticle): string {
  return JSON.stringify({
    event,
    article: {
      id: article.id,
      title: article.title,
      slug: article.slug,
      excerpt: article.excerpt,
      html: article.html,
      blocks: article.blocks,
      category: article.category,
      tags: article.tags,
      heroImage: article.heroImage,
      structuredData: article.structuredData,
      publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
      state: article.state,
      contentHash: article.contentHash,
    },
  });
}

function serialiseWithdrawal(event: ArticleEvent, id: string, slug: string): string {
  return JSON.stringify({ event, article: { id, slug } });
}

function sign(body: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "unconfigured";
  }
}

export class WebhookTarget implements PublishingTarget {
  readonly kind = "webhook";
  readonly id: string;
  readonly capabilities: TargetCapabilities = capabilities({
    // The receiver pulls the image from the URL we send; we never push bytes.
    hostsMedia: false,
    // Everything else travels in the payload, so nothing is lost — including
    // both renderings of the body, which is why a bespoke CMS can pick either.
    bodyFormat: "both",
  });

  private readonly configured: boolean;

  constructor(
    private readonly config: WebhookConfig,
    private readonly store: RemoteRefStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.configured = Boolean(config.url?.trim() && config.secret?.trim());
    this.id = `webhook:${config.name?.trim() || hostOf(config.url ?? "")}`;
  }

  async check(): Promise<TargetCheck> {
    if (!this.configured) {
      return {
        ok: false,
        code: "config",
        retryable: false,
        message: "webhook target needs a URL and a secret",
      };
    }
    // There is no read endpoint to probe, so a signed no-op event is the only
    // honest check: it exercises the URL, the TLS chain and the shared secret.
    const result = await this.deliver(JSON.stringify({ event: "ping" }));
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
      // Never fall back to sending unsigned: a publish webhook without a
      // signature is an unauthenticated write endpoint on a customer's CMS.
      return failed("config", "webhook target needs a URL and a secret");
    }
    try {
      const degraded = describeDegradation(this.capabilities, article);
      const existing = await this.store.get(this.id, article.id);

      if (existing?.remoteId && existing.contentHash === article.contentHash) {
        return { status: "unchanged", remote: existing, degraded };
      }

      const result = await this.deliver(serialiseArticleEvent("published", article));
      if (!result.ok) return failed(result.code, result.message, degraded);

      // Most receivers answer 204. When one does return an id we keep it, so a
      // customer's own identifier survives into our records; otherwise the
      // article id is the shared key and the receiver upserts on it.
      const acknowledged = (result.body ?? {}) as { id?: unknown; url?: unknown };
      const saved: RemoteRef = {
        targetId: this.id,
        articleId: article.id,
        remoteId:
          typeof acknowledged.id === "string" || typeof acknowledged.id === "number"
            ? String(acknowledged.id)
            : article.id,
        remoteUrl: typeof acknowledged.url === "string" ? acknowledged.url : null,
        mediaId: null,
        contentHash: article.contentHash,
        updatedAt: new Date(),
      };
      await this.store.put(saved);

      return {
        status: "written",
        action: existing?.remoteId ? "updated" : "created",
        remote: saved,
        degraded,
      };
    } catch (error) {
      return failed("unknown", error instanceof Error ? error.message : String(error));
    }
  }

  async unpublish(article: Pick<NormalisedArticle, "id" | "slug">): Promise<PublishOutcome> {
    if (!this.configured) return failed("config", "webhook target needs a URL and a secret");
    try {
      const existing = await this.store.get(this.id, article.id);
      if (!existing?.remoteId) return { status: "unchanged", remote: existing ?? null, degraded: [] };

      const result = await this.deliver(
        serialiseWithdrawal("unpublished", article.id, article.slug)
      );
      if (!result.ok) return failed(result.code, result.message);

      const saved: RemoteRef = { ...existing, contentHash: null, updatedAt: new Date() };
      await this.store.put(saved);
      return { status: "written", action: "updated", remote: saved, degraded: [] };
    } catch (error) {
      return failed("unknown", error instanceof Error ? error.message : String(error));
    }
  }

  private deliver(body: string) {
    const signature = sign(body, this.config.secret, Math.floor(Date.now() / 1000));
    return request(this.config.url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
      body,
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}
