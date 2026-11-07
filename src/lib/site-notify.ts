/**
 * Fire-and-forget delivery of a purge webhook to a tenant's blog.
 *
 * Every rule here exists because this runs inside a publish. A publish that
 * fails because a customer's blog is down is worse than a blog that is stale
 * for five minutes, and the reconcile cron already covers the stale case. So:
 * never throw, never block, always time out.
 */

import { logger } from "./logger.js";
import {
  SIGNATURE_HEADER,
  serialisePurgePayload,
  signPurgePayload,
  type PurgeEvent,
  type PurgePayload,
} from "./site-webhook.js";

const TIMEOUT_MS = 3_000;

export interface NotifyTarget {
  /** The blog's purge endpoint, e.g. https://acme.octypo.blog/api/purge */
  url: string;
  secret: string;
}

/**
 * Resolve the single-tenant target from env. Per-tenant targets arrive with the
 * tenants table; until then a deployment either has one blog or has none, and
 * having none must be silent rather than noisy on every publish.
 */
export function defaultNotifyTarget(): NotifyTarget | null {
  const url = process.env.BLOG_PURGE_URL?.trim();
  const secret = process.env.BLOG_PURGE_SECRET?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}

/**
 * Tell the static-site build to run. A customer site that is built and
 * uploaded (Astro → the client's own host) has no purge endpoint; it has a
 * build to trigger. Configured per install:
 *   SITE_DEPLOY_HOOK_URL    e.g. https://api.github.com/repos/<org>/<repo>/dispatches
 *   SITE_DEPLOY_HOOK_TOKEN  bearer for that URL
 *   SITE_DEPLOY_HOOK_BODY   JSON body template; "{event}" and "{slug}" are filled in
 *                           (default: GitHub repository_dispatch with event_type "octypo-{event}")
 * Same rules as the purge: never throw, never block, always time out.
 */
export async function notifySiteDeploy(event: PurgeEvent, slug: string): Promise<boolean> {
  const url = process.env.SITE_DEPLOY_HOOK_URL?.trim();
  if (!url) return false;
  const token = process.env.SITE_DEPLOY_HOOK_TOKEN?.trim();
  const template =
    process.env.SITE_DEPLOY_HOOK_BODY?.trim() ||
    '{"event_type":"octypo-{event}","client_payload":{"slug":"{slug}","event":"{event}"}}';
  const body = template.replace(/\{event\}/g, event).replace(/\{slug\}/g, slug.replace(/["\\]/g, ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/vnd.github+json, application/json",
        "user-agent": "octypo-engine",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn({ slug, status: response.status }, "[SiteNotify] Deploy hook rejected");
      return false;
    }
    logger.info({ slug, event }, "[SiteNotify] Site build triggered");
    return true;
  } catch (error) {
    logger.warn({ slug, error }, "[SiteNotify] Deploy hook failed (non-fatal)");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function notifyBlog(
  event: PurgeEvent,
  article: { slug: string; updatedAt: Date },
  tenantId = "default",
  target: NotifyTarget | null = defaultNotifyTarget()
): Promise<boolean> {
  if (!target) return false;

  const payload: PurgePayload = {
    tenantId,
    event,
    slug: article.slug,
    updatedAt: article.updatedAt.toISOString(),
  };
  const body = serialisePurgePayload(payload);
  const signature = signPurgePayload(body, target.secret, Math.floor(Date.now() / 1000));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn({ slug: article.slug, status: response.status }, "[SiteNotify] Purge rejected");
      return false;
    }
    return true;
  } catch (error) {
    // The 5-minute reconcile cron is the safety net; this is only the fast path.
    logger.warn({ slug: article.slug, error }, "[SiteNotify] Purge delivery failed (non-fatal)");
    return false;
  } finally {
    clearTimeout(timer);
  }
}
