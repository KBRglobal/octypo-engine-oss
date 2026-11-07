/**
 * The publishing-target contract.
 *
 * "Publish this article" must not know where the article lands. Today that is a
 * customer's WordPress; tomorrow it is Shopify, Ghost, Webflow, a git-committed
 * static site or a bespoke CMS behind a webhook. Adapting to whatever the
 * customer already runs *is* the product, so the pipeline is only ever allowed
 * to speak this vocabulary — never a CMS's own.
 *
 * Three ideas carry the whole design:
 *
 * 1. `NormalisedArticle` — one payload derived from `blocks[]`, with no CMS
 *    concepts in it. Every adapter receives exactly this.
 * 2. `TargetCapabilities` — what a target can actually accept. A target that
 *    has no media library or no tags must SAY so, so the loss is reported as a
 *    `Degradation` rather than a hero image that quietly never arrives.
 * 3. `PublishOutcome` — four distinguishable results: written, already up to
 *    date, failed-and-worth-retrying, failed-and-pointless-to-retry. The job
 *    queue retries; retrying a wrong password forever is just noise, and
 *    treating a network blip as permanent silently loses the article.
 *
 * Adapters never throw. A thrown error inside a publish is a result nobody
 * classified, and an unclassified result is how an engine ends up claiming
 * success for a write that never happened.
 */

import type { ContentBlock } from "../schema/index.js";

// ============================================================================
// THE PAYLOAD
// ============================================================================

/** A category or tag, as a slug the target can look up plus a name it can create. */
export interface TaxonomyTerm {
  slug: string;
  name: string;
}

/** The hero image, as a URL a target can fetch and a filename it can store under. */
export interface MediaRef {
  url: string;
  alt: string | null;
  /** Safe basename, e.g. "deposit-rules-9f2a.png" — targets with a media library need one. */
  filename: string;
}

/**
 * The article, in target-agnostic form. Produced once per publish by
 * `normaliseArticle()` and handed to every configured target unchanged.
 */
export interface NormalisedArticle {
  /** The engine's content id. This — not the slug — is the idempotency key. */
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  /** Body as HTML. Already sanitised on write; adapters must not re-sanitise it. */
  html: string;
  /** The same body as structure, for targets that model content as blocks. */
  blocks: ContentBlock[];
  category: TaxonomyTerm | null;
  tags: TaxonomyTerm[];
  heroImage: MediaRef | null;
  /** The writer's direct 2–4 sentence answer, for targets that render it above the fold. */
  answerCapsule: string | null;
  /** Where the article was written from — a target can cite it as a real link. */
  source: { url: string; name: string | null } | null;
  /** JSON-LD objects, to be injected verbatim wherever the target allows. */
  structuredData: Record<string, unknown>[];
  publishedAt: Date | null;
  /** The engine's intent. Targets map it onto their own vocabulary. */
  state: "published" | "draft";
  /**
   * Hash of everything above. A target that already holds this hash can answer
   * "unchanged" instead of rewriting a customer's post for no reason.
   */
  contentHash: string;
}

// ============================================================================
// CAPABILITIES
// ============================================================================

/** The parts of an article a target may or may not be able to carry. */
export type TargetFeature =
  | "update"
  | "delete"
  | "hostsMedia"
  | "categories"
  | "tags"
  | "excerpt"
  | "structuredData"
  | "scheduling"
  /** A slug rename could not leave a 301 behind (no redirect rules file in the repo). */
  | "redirects";

export interface TargetCapabilities {
  /** Can an existing item be rewritten in place? If false, a republish is a hard failure — never a duplicate. */
  update: boolean;
  /** Can an item be withdrawn (unpublished or deleted)? */
  delete: boolean;
  /**
   * Does the target take the image *bytes* into its own library? False does not
   * mean the hero is lost — the URL still travels in the payload — it means the
   * image stays hosted by us.
   */
  hostsMedia: boolean;
  categories: boolean;
  tags: boolean;
  excerpt: boolean;
  /** Can JSON-LD reach the rendered page? */
  structuredData: boolean;
  /** Does the target honour a publication date, including a future one? */
  scheduling: boolean;
  /** What the target wants the body as. */
  bodyFormat: "html" | "blocks" | "both";
}

/**
 * Something the article carries that this target cannot take. Reported on every
 * outcome and logged by the caller: losing a customer's hero image is
 * acceptable only if somebody is told about it.
 */
export interface Degradation {
  feature: TargetFeature;
  detail: string;
}

// ============================================================================
// REMOTE STATE
// ============================================================================

/**
 * What we know about an article's copy on one target. Persisted, because
 * without `remoteId` a retry creates a second post on a customer's live site —
 * the single most visible way this system can fail.
 *
 * `remoteId` is nullable on purpose: after a media upload succeeds but the post
 * write fails we still want the `mediaId` remembered, so the retry does not
 * upload the same image again.
 */
export interface RemoteRef {
  targetId: string;
  articleId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  mediaId: string | null;
  contentHash: string | null;
  updatedAt: Date;
}

// ============================================================================
// OUTCOMES
// ============================================================================

export type PublishErrorCode =
  /** The adapter itself is misconfigured (missing URL, missing secret). */
  | "config"
  /** Credentials rejected — an application password revoked or mistyped. */
  | "unauthorized"
  /** DNS, TCP, TLS, timeout, or a 5xx. The site, not the request, is the problem. */
  | "unreachable"
  /** The target understood the request and refused it (validation, 4xx). */
  | "rejected"
  /** The remote object is gone and could not be recreated. */
  | "not_found"
  /** The hero image could not be delivered, so the post was deliberately not written. */
  | "media_failed"
  /** The target cannot do what was asked (e.g. update on an append-only target). */
  | "unsupported"
  | "unknown";

/**
 * Whether the job queue should try again. Wrong credentials and rejected
 * payloads do not fix themselves; unreachable hosts and half-finished writes do.
 */
export const RETRYABLE: Record<PublishErrorCode, boolean> = {
  config: false,
  unauthorized: false,
  unreachable: true,
  rejected: false,
  not_found: false,
  media_failed: true,
  unsupported: false,
  // Unclassified means "we do not know it is safe to give up".
  unknown: true,
};

export type PublishOutcome =
  | {
      status: "written";
      action: "created" | "updated";
      remote: RemoteRef;
      degraded: Degradation[];
    }
  | {
      status: "unchanged";
      remote: RemoteRef | null;
      degraded: Degradation[];
    }
  | {
      status: "failed";
      code: PublishErrorCode;
      retryable: boolean;
      message: string;
      degraded: Degradation[];
    };

/** Result of a cheap credential / reachability probe. */
export type TargetCheck =
  | { ok: true }
  | { ok: false; code: PublishErrorCode; retryable: boolean; message: string };

// ============================================================================
// THE INTERFACE
// ============================================================================

export interface PublishingTarget {
  /** Stable across restarts — it namespaces this target's rows in the ref store. */
  readonly id: string;
  /** Adapter family: "wordpress", "webhook", … */
  readonly kind: string;
  readonly capabilities: TargetCapabilities;
  /** Probe credentials and reachability without writing anything. Never throws. */
  check(): Promise<TargetCheck>;
  /** Create or update. Idempotent on `article.id`. Never throws. */
  publish(article: NormalisedArticle): Promise<PublishOutcome>;
  /** Withdraw a previously published article. Never throws. */
  unpublish(article: Pick<NormalisedArticle, "id" | "slug">): Promise<PublishOutcome>;
}

// ============================================================================
// HELPERS
// ============================================================================

export function failed(
  code: PublishErrorCode,
  message: string,
  degraded: Degradation[] = []
): Extract<PublishOutcome, { status: "failed" }> {
  return { status: "failed", code, retryable: RETRYABLE[code], message, degraded };
}

/** A target that can carry everything. Adapters override the parts they cannot. */
export const FULL_CAPABILITIES: TargetCapabilities = {
  update: true,
  delete: true,
  hostsMedia: true,
  categories: true,
  tags: true,
  excerpt: true,
  structuredData: true,
  scheduling: true,
  bodyFormat: "html",
};

export function capabilities(overrides: Partial<TargetCapabilities>): TargetCapabilities {
  return { ...FULL_CAPABILITIES, ...overrides };
}
