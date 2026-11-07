/**
 * Which targets a deployment publishes to, and what happens when one of them
 * is having a bad day.
 *
 * The pipeline asks for one thing — "deliver this article" — and gets back one
 * verdict it can act on. Two rules decide that verdict, and both exist because
 * of how the job queue behaves:
 *
 *  - Every target is attempted, even after one fails. A customer mirroring to
 *    WordPress and to their own app should not lose both because one is down.
 *  - The report is retryable if ANY failure is retryable. A permanent failure
 *    on one target must not strand a recoverable one on another; the adapters
 *    are individually idempotent, so re-running a successful target costs a
 *    hash comparison and nothing else.
 *
 * Targets are resolved from the environment rather than registered in code, so
 * connecting a customer's CMS is configuration, not a deploy.
 */

import { formatDegradation } from "./capabilities.js";
import { logger } from "../lib/logger.js";
import { normaliseArticle, type ArticleSource, type NormaliseOptions } from "./normalise.js";
import { PostgresRemoteRefStore, type RemoteRefStore } from "./remote-ref-store.js";
import type { Degradation, NormalisedArticle, PublishOutcome, PublishingTarget } from "./types.js";
import { failed } from "./types.js";
import { WebhookTarget } from "./webhook.js";
import { WordPressTarget } from "./wordpress.js";
import { AstroGitTarget, type AstroGitArea, type AstroGitCopy } from "./astro-git.js";

export interface DeliveryOptions {
  /**
   * Treat "written, but the target could not carry everything" as a failure.
   * Off by default: most customers would rather have the article live without
   * its tags than not live at all. On for the ones who would not.
   */
  strictDegradation?: boolean;
}

export interface DeliveryResult {
  targetId: string;
  kind: string;
  outcome: PublishOutcome;
}

export interface DeliveryReport {
  /** False if any target failed. The caller must not record a publish as done. */
  ok: boolean;
  /** True if retrying could help. Drives the job queue's decision, not ours. */
  retryable: boolean;
  results: DeliveryResult[];
  degraded: Degradation[];
}

// ============================================================================
// RESOLUTION
// ============================================================================

const DEFAULT_STORE: RemoteRefStore = new PostgresRemoteRefStore();

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** A JSON object from the environment. Bad JSON is logged and ignored, never fatal. */
function jsonObject<T extends object>(name: string, value: string | undefined): T | undefined {
  const raw = trimmed(value);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {
    // reported below
  }
  logger.warn({ name }, "[Publishing] Ignoring an environment value that is not a JSON object");
  return undefined;
}

export function resolveTargets(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  store: RemoteRefStore = DEFAULT_STORE
): PublishingTarget[] {
  const targets: PublishingTarget[] = [];

  const wpUrl = trimmed(env.WORDPRESS_URL);
  const wpUser = trimmed(env.WORDPRESS_USER);
  const wpPassword = trimmed(env.WORDPRESS_APP_PASSWORD);
  // All three or none. A half-configured target looks connected and silently
  // publishes nothing, which is the worst of both outcomes.
  if (wpUrl && wpUser && wpPassword) {
    targets.push(
      new WordPressTarget(
        {
          baseUrl: wpUrl,
          username: wpUser,
          applicationPassword: wpPassword,
          internalLinkBase: trimmed(env.WORDPRESS_LINK_BASE) || null,
          timeoutMs: Number(env.WORDPRESS_TIMEOUT_MS) || undefined,
        },
        store
      )
    );
  }

  const ghOwner = trimmed(env.GITHUB_REPO_OWNER);
  const ghRepo = trimmed(env.GITHUB_REPO_NAME);
  const ghToken = trimmed(env.GITHUB_TOKEN);
  // All or none — a half-configured git target looks connected and silently
  // delivers nothing, same failure shape as a half-configured WordPress target.
  if (ghOwner && ghRepo && ghToken) {
    targets.push(
      new AstroGitTarget(
        {
          owner: ghOwner,
          repo: ghRepo,
          branch: trimmed(env.GITHUB_REPO_BRANCH) || "main",
          token: ghToken,
          contentDir: trimmed(env.GITHUB_CONTENT_DIR) || "src/content/articles",
          siteOrigin: trimmed(env.SITE_ORIGIN) || "",
          language: trimmed(env.SITE_LANGUAGE) || undefined,
          copy: jsonObject<Partial<AstroGitCopy>>("GITHUB_SITE_COPY", env.GITHUB_SITE_COPY),
          areas: jsonObject<Record<string, AstroGitArea>>("GITHUB_SITE_AREAS", env.GITHUB_SITE_AREAS),
          defaultCategory: trimmed(env.GITHUB_DEFAULT_CATEGORY) || undefined,
          timeoutMs: Number(env.GITHUB_TIMEOUT_MS) || undefined,
        },
        store
      )
    );
  }

  const hookUrl = trimmed(env.PUBLISH_WEBHOOK_URL);
  const hookSecret = trimmed(env.PUBLISH_WEBHOOK_SECRET);
  if (hookUrl && hookSecret) {
    targets.push(
      new WebhookTarget(
        {
          url: hookUrl,
          secret: hookSecret,
          name: trimmed(env.PUBLISH_WEBHOOK_NAME) || undefined,
          timeoutMs: Number(env.PUBLISH_WEBHOOK_TIMEOUT_MS) || undefined,
        },
        store
      )
    );
  }

  return targets;
}

export function defaultDeliveryOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): DeliveryOptions {
  return { strictDegradation: trimmed(env.PUBLISH_STRICT_DEGRADATION).toLowerCase() === "true" };
}

/** Per-target normalisation options — only WordPress currently sets any. */
function normaliseOptionsFor(target: PublishingTarget): NormaliseOptions {
  if (target instanceof WordPressTarget) {
    return { internalLinkBase: target.linkBase };
  }
  return {};
}

// ============================================================================
// DELIVERY
// ============================================================================

export async function deliver(
  article: NormalisedArticle,
  targets: PublishingTarget[],
  options: DeliveryOptions = {}
): Promise<DeliveryReport> {
  const results: DeliveryResult[] = [];
  const degraded: Degradation[] = [];
  let ok = true;
  let retryable = false;

  for (const target of targets) {
    let outcome: PublishOutcome;
    try {
      outcome = await target.publish(article);
    } catch (error) {
      // The contract says adapters never throw. This is here because a contract
      // is not an enforcement mechanism, and one rogue adapter must not take
      // the other targets down with it.
      outcome = failed("unknown", error instanceof Error ? error.message : String(error));
    }

    if (outcome.status === "failed") {
      ok = false;
      retryable = retryable || outcome.retryable;
      logger.error(
        { targetId: target.id, code: outcome.code, retryable: outcome.retryable },
        `[Publishing] ${target.kind} delivery failed: ${outcome.message}`
      );
    } else if (outcome.degraded.length > 0) {
      degraded.push(...outcome.degraded);
      logger.warn(
        { targetId: target.id },
        `[Publishing] ${target.kind} could not carry everything — ${formatDegradation(outcome.degraded)}`
      );
      if (options.strictDegradation) {
        ok = false;
        // A target that cannot take tags will not learn to on the third attempt.
        retryable = retryable || false;
      }
    } else {
      logger.info(
        { targetId: target.id, articleId: article.id, status: outcome.status },
        `[Publishing] ${target.kind} ${outcome.status}`
      );
    }

    results.push({ targetId: target.id, kind: target.kind, outcome });
  }

  return { ok, retryable, results, degraded };
}

/**
 * The one call the pipeline makes. Normalises once per target (targets may want
 * different link handling) and delivers.
 */
export async function deliverArticle(
  source: ArticleSource,
  targets: PublishingTarget[] = resolveTargets(),
  options: DeliveryOptions = defaultDeliveryOptions()
): Promise<DeliveryReport> {
  if (targets.length === 0) {
    return { ok: true, retryable: false, results: [], degraded: [] };
  }

  const reports: DeliveryReport[] = [];
  for (const target of targets) {
    const article = normaliseArticle(source, normaliseOptionsFor(target));
    reports.push(await deliver(article, [target], options));
  }

  return {
    ok: reports.every(report => report.ok),
    retryable: reports.some(report => report.retryable),
    results: reports.flatMap(report => report.results),
    degraded: reports.flatMap(report => report.degraded),
  };
}
