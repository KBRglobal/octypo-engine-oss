/**
 * The only thing that talks to the engine.
 *
 * The blog stores nothing: no database, no build-time content, no CMS. Every
 * page is a projection of one `/api/site/*` response. That makes this file the
 * entire trust and failure boundary, so it does three jobs and no others:
 *
 *  1. Authenticate as exactly one tenant, via a bearer site key that never
 *     appears in a URL (query strings reach access logs, Referer headers and
 *     the Cloudflare cache key).
 *  2. Parse every response with zod, so a shape change in the engine fails
 *     loudly here instead of rendering a blank page on a customer's domain.
 *  3. Return plain data — never a Response, never engine headers. The engine
 *     stamps `X-Robots-Tag: noindex` on everything it serves (src/index.ts:55-58)
 *     and any header pass-through would de-index every customer at once.
 *
 * The same client backs the SSR routes and the Astro Content Layer loader, so
 * hosted and self-hosted builds cannot drift in what they consider valid.
 */

import { z } from 'zod';

// ── Contract ───────────────────────────────────────────────────────────────

export const brandSchema = z
  .object({
    accent: z.string().optional(),
    accentContrast: z.string().optional(),
    background: z.string().optional(),
    surface: z.string().optional(),
    text: z.string().optional(),
    muted: z.string().optional(),
    fontBody: z.string().optional(),
    fontHeading: z.string().optional(),
    radius: z.string().optional(),
    logoUrl: z.string().optional(),
    customCss: z.string().optional(),
  })
  .passthrough();

export const tenantConfigSchema = z
  .object({
    slug: z.string().min(1),
    siteName: z.string().min(1),
    siteUrl: z.string().min(1),
    articlePathPrefix: z.string(),
    topicPathPrefix: z.string().default('/topics'),
    locale: z.string().default('en'),
    brand: brandSchema.default({}),
    plan: z.string().optional(),
  })
  .passthrough();

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

// Blocks are intentionally unvalidated beyond {id,type,data}: the renderer's
// contract is that an unknown type degrades, so rejecting one here would turn a
// graceful degradation into a hard 500.
export const blockSchema = z
  .object({
    id: z.string().default(''),
    type: z.string(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

const summaryShape = {
  slug: z.string().min(1),
  title: z.string(),
  metaTitle: z.string().nullish(),
  metaDescription: z.string().nullish(),
  summary: z.string().nullish(),
  answerCapsule: z.string().nullish(),
  heroImage: z.string().nullish(),
  heroImageAlt: z.string().nullish(),
  cardImage: z.string().nullish(),
  cardImageAlt: z.string().nullish(),
  category: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  wordCount: z.number().nullish(),
  publishedAt: z.string().nullish(),
  updatedAt: z.string(),
};

export const articleSummarySchema = z.object(summaryShape).passthrough();
export type ArticleSummary = z.infer<typeof articleSummarySchema>;

export const articleSchema = z
  .object({
    ...summaryShape,
    blocks: z.array(blockSchema).default([]),
    quickFacts: z.record(z.string(), z.unknown()).nullish(),
    seoSchema: z.unknown().nullish(),
    faq: z.array(z.object({ question: z.string(), answer: z.string() }).passthrough()).nullish(),
  })
  .passthrough();

export type Article = z.infer<typeof articleSchema>;

export const tombstoneSchema = z
  .object({
    slug: z.string().min(1),
    deleted: z.literal(true),
    updatedAt: z.string(),
  })
  .passthrough();

export type Tombstone = z.infer<typeof tombstoneSchema>;

export const syncItemSchema = z.union([tombstoneSchema, articleSummarySchema]);
export type SyncItem = z.infer<typeof syncItemSchema>;

export const syncPageSchema = z.object({
  items: z.array(syncItemSchema),
  nextCursor: z.string().nullish(),
});
export type SyncPage = z.infer<typeof syncPageSchema>;

export const publicationPageSchema = z.object({
  items: z.array(articleSummarySchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type PublicationPage = z.infer<typeof publicationPageSchema>;

export const manifestSchema = z.object({
  count: z.number(),
  entries: z.array(z.object({ slug: z.string(), updatedAt: z.string() }).passthrough()),
  nextCursor: z.string().nullish(),
});
export type Manifest = z.infer<typeof manifestSchema>;

export const topicPageSchema = z.object({
  topic: z.object({ slug: z.string(), name: z.string().nullish() }).passthrough(),
  items: z.array(articleSummarySchema),
  nextCursor: z.string().nullish(),
});
export type TopicPage = z.infer<typeof topicPageSchema>;

export function isTombstone(item: SyncItem): item is Tombstone {
  return (item as Tombstone).deleted === true;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export class EngineHttpError extends Error {
  constructor(readonly status: number, readonly path: string, message?: string) {
    super(message ?? `Engine responded ${status} for ${path}`);
    this.name = 'EngineHttpError';
  }
}

export class EngineResponseError extends Error {
  constructor(readonly path: string, readonly issues: unknown) {
    super(`Engine response for ${path} did not match the expected shape`);
    this.name = 'EngineResponseError';
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

export interface EngineClientOptions {
  baseUrl: string;
  siteKey: string;
  fetch?: typeof fetch;
  /**
   * Hosted mode only. The Worker holds one platform credential for every
   * customer, so the tenant is named by the host it was reached on. Sent as a
   * header rather than a path segment: a tenant id in a URL is enumerable, and
   * enumerating it is the whole attack. In self-host mode the site key is
   * already tenant-scoped and this stays unset.
   */
  tenantHost?: string;
}

export interface ListParams {
  updatedSince?: string;
  cursor?: string;
  limit?: number;
}

export interface PublicationListParams {
  limit: number;
  offset: number;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_SYNC_PAGES = 200;

export class EngineClient {
  private readonly baseUrl: string;
  private readonly siteKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tenantHost: string | undefined;

  constructor(options: EngineClientOptions) {
    if (!options.siteKey) {
      throw new Error('EngineClient requires a site key (OCTYPO_SITE_KEY)');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.siteKey = options.siteKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tenantHost = options.tenantHost;
  }

  private url(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  // The input type is `unknown` deliberately: schemas here carry `.default()`,
  // so the parsed output is not the same shape as the wire payload.
  private async request<T>(
    path: string,
    schema: z.ZodType<T, unknown>,
    params?: Record<string, string | number | undefined>,
    allow404 = false
  ): Promise<T | null> {
    const url = this.url(path, params);
    // Detached deliberately. Calling it as `this.fetchImpl(...)` invokes fetch
    // with this client as the receiver, which on workerd throws "Illegal
    // invocation" and 500s every page. Node tolerates it, which is why a suite
    // that injects a plain function never caught this.
    const doFetch = this.fetchImpl;
    const response = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.siteKey}`,
        Accept: 'application/json',
        ...(this.tenantHost ? { 'X-Octypo-Tenant-Host': this.tenantHost } : {}),
      },
      credentials: 'omit',
      // workerd only accepts "follow" or "manual"; "error" throws before the
      // request is made. "manual" keeps the original intent — we do not want the
      // engine silently redirecting us somewhere else — without the crash.
      redirect: 'manual',
    });

    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new EngineHttpError(response.status, path);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new EngineResponseError(path, error);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new EngineResponseError(path, parsed.error.issues);
    return parsed.data;
  }

  async getConfig(): Promise<TenantConfig> {
    const body = await this.request('/api/site/config', z.object({ tenant: tenantConfigSchema }));
    return body!.tenant;
  }

  async getArticle(slug: string): Promise<Article | null> {
    const body = await this.request(
      `/api/site/articles/${encodeURIComponent(slug)}`,
      z.object({ article: articleSchema }),
      undefined,
      true
    );
    return body ? body.article : null;
  }

  async listArticles(params: ListParams): Promise<SyncPage> {
    const body = await this.request('/api/site/articles', syncPageSchema, {
      updatedSince: params.updatedSince,
      cursor: params.cursor,
      limit: params.limit ?? DEFAULT_PAGE_SIZE,
    });
    return body!;
  }

  async listPublications(params: PublicationListParams): Promise<PublicationPage> {
    const body = await this.request('/api/site/publications', publicationPageSchema, {
      limit: params.limit,
      offset: params.offset,
    });
    return body!;
  }

  /**
   * Walk every page. The engine's cursor is keyset on `(updatedAt, id)`, so
   * repeated cursors mean a bug on the other side; bounding the walk keeps that
   * bug from turning into an infinite loop inside a Worker request.
   */
  async listAllArticles(params: ListParams & { maxPages?: number }): Promise<SyncItem[]> {
    const limit = params.maxPages ?? MAX_SYNC_PAGES;
    const seen = new Set<string>();
    const out: SyncItem[] = [];
    let cursor = params.cursor;

    for (let page = 0; page < limit; page++) {
      const result = await this.listArticles({ ...params, cursor });
      out.push(...result.items);
      const next = result.nextCursor ?? undefined;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return out;
  }

  async getManifest(cursor?: string): Promise<Manifest> {
    const body = await this.request('/api/site/manifest', manifestSchema, { cursor });
    return body!;
  }

  async getTopic(slug: string, cursor?: string): Promise<TopicPage | null> {
    return this.request(
      `/api/site/topics/${encodeURIComponent(slug)}`,
      topicPageSchema,
      { cursor },
      true
    );
  }
}
