# Octypo Blog

The customer-facing half of Octypo: a zero-JavaScript Astro front end that renders
articles pulled from the engine over HTTP.

It stores nothing. No database, no build-time content, no CMS. Every page is a
projection of one `/api/site/*` response, cached at the Cloudflare edge and purged
by tag when the engine publishes.

## Why SSR plus an edge cache, not a static build

A busy site publishes 300 articles a month — 3,600 in year one, roughly ten
publishes a day. With a static build every publish triggers a rebuild whose duration
grows with the corpus, and a failed build silently freezes the customer's site at
exactly the moment they are paying the most. With SSR plus cache-tag purging, a
publish costs one purge and one ~50 ms cold render, the corpus size is irrelevant,
and there is no build to fail.

Steady-state Core Web Vitals are identical: a Worker response served from the
Cloudflare cache and a static file from a bucket are indistinguishable to a browser.
Astro's advantage comes from emitting zero JS, not from when the HTML was produced.

Cache policy lives in `src/lib/cache.ts`:

| Route class | `Cache-Control` |
|---|---|
| article | `public, max-age=0, s-maxage=31536000, stale-while-revalidate=86400` |
| listing / topic hub | `public, max-age=0, s-maxage=60, stale-while-revalidate=600` |
| sitemap / rss / robots | `public, max-age=0, s-maxage=300, stale-while-revalidate=3600` |
| `/api/*` | `no-store` |

Every cache tag carries the tenant slug (`article:<tenant>:<slug>`,
`listing:<tenant>`). A tag without it would let one customer's publish flush every
other customer's cache.

## Layout

```
src/lib/          all logic, plain TypeScript, depends only on zod — unit tested
src/components/   thin .astro wrappers over src/lib
src/pages/        routes
src/middleware.ts host → tenant, plus the edge headers on every response
workers/          the 5-minute reconcile cron (a separate Worker)
```

Logic lives in `src/lib` rather than inside `.astro` files on purpose: the guarantees
that matter here (an unknown block type degrades rather than disappearing; no JSON-LD
URL points at another host; no secret reaches the client) are only worth anything if
they are unit tests, and a test cannot reach a switch statement written in template
markup. Run them from the repo root with `npm test`.

## Engine contract

All endpoints require `Authorization: Bearer octy_site_…`. The tenant is never named
in a URL — a tenant id in a path is enumerable, and enumerating it is the whole
attack. In hosted mode the Worker presents one platform key plus
`X-Octypo-Tenant-Host: <host>`; in self-host mode the key is already tenant-scoped.

| Endpoint | Returns |
|---|---|
| `GET /api/site/config` | `{ tenant: { slug, siteName, siteUrl, articlePathPrefix, topicPathPrefix, locale, brand, plan } }` |
| `GET /api/site/articles?updatedSince=&cursor=&limit=` | `{ items: (ArticleSummary \| Tombstone)[], nextCursor }` |
| `GET /api/site/articles/:slug` | `{ article }` — published only; 404 otherwise |
| `GET /api/site/manifest?cursor=` | `{ count, entries: [{slug, updatedAt}], nextCursor }` |
| `GET /api/site/topics/:slug?cursor=` | `{ topic, items, nextCursor }` |

A `Tombstone` is `{ slug, deleted: true, updatedAt }`. Unpublished and deleted rows
must surface this way rather than simply vanishing: a pull-based blog cannot learn
about a row that no longer appears in any answer, so the page would stay live on the
customer's domain forever. The engine side of that is the soft delete in
`src/api/admin.ts`.

Cursors are keyset on `(updatedAt, id)` and carry the tenant — see
`src/api/site-cursor.ts` in the engine. Paging on `updatedAt >` alone drops every row
that shares a timestamp with the last row of a page, and `>=` loops forever.

The exact shapes are enforced by zod in `src/lib/engine-client.ts`. A change in the
engine fails there, loudly, instead of rendering a blank page on a customer's domain.

## Configuration

Set as Worker vars (`wrangler.toml`) or a `.env` for self-hosting:

| Variable | Meaning |
|---|---|
| `OCTYPO_ENGINE_URL` | Engine base URL. Required — the blog refuses to boot without it. |
| `OCTYPO_SITE_KEY` | **Secret.** `wrangler secret put`. Required. |
| `OCTYPO_PURGE_SECRET` | **Secret.** HMAC key for the publish webhook. Without it `/api/purge` returns 503 and freshness falls back to the cron. |
| `OCTYPO_IMAGE_RESIZE_PREFIX` | e.g. `/cdn-cgi/image`. Unset means self-host: original R2 URLs are served. |
| `OCTYPO_TENANT_TTL_SECONDS` | Tenant config cache TTL. Default 300. |
| `OCTYPO_HOSTED` | `true` for the shared multi-tenant Worker. |
| `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_PURGE_TOKEN` | **Secret.** Cache-tag purging. |

Nothing here may ever be named `PUBLIC_*`: Astro compiles anything under that prefix
into the browser bundle. `test/no-client-secrets.test.ts` enforces that, because this
exact mistake already shipped once in this repo — a hardcoded customer domain
compiled into `admin/src/pages/Review.tsx:71`.

## Freshness

Two independent paths, on purpose.

1. **Webhook (seconds).** On publish, unpublish and delete the engine POSTs a signed
   event to `/api/purge` (`src/lib/site-notify.ts` in the engine). The signature is
   `t=<unix>,v1=<hmac(t.body)>` — the timestamp is inside the signed material, so a
   captured request cannot be replayed forever. An unverified purge endpoint is a free
   cache-flush denial of service.
2. **Reconcile cron (5 minutes).** `workers/reconcile.ts` asks the engine what changed
   since a stored watermark and purges those tags. A dropped webhook is otherwise
   completely silent.

Delivery of the webhook never blocks or fails a publish. A customer's blog being down
must not stop the engine writing articles.

## Images

`OpenAIImageProvider` uploads raw 1536×1024 PNGs to R2 — typically 1.5–3 MB
(`src/lib/image-provider.ts:151`). Served bare that is a 4–8 s mobile LCP, which
would make the entire Core Web Vitals argument for this product untrue. Every image
goes through Cloudflare Image Resizing with `format=auto`, carries explicit
`width`/`height` so CLS stays at zero, and the hero gets `fetchpriority="high"`
while body images get `loading="lazy"`.

Fixing the source PNGs engine-side is still worth doing; resizing masks the cost but
we still store and egress multi-megabyte originals.

## Theming

`tenant.brand` is a JSONB column rendered into `--octypo-*` custom properties in
`<head>` on every request. `src/styles/theme.css` references only those variables, so
changing a customer's accent colour is an admin field edit that is live on the next
purge — no rebuild, no deploy, no per-customer fork of the theme. `customCss` is
sanitised (`src/lib/theme.ts`): `@import`, `expression()`, `javascript:` and remote
`url()` are stripped, because it lands inside a `<style>` element on the customer's
own domain.

## Self-hosting

The blog contains no engine code — it is a consumer of a documented HTTP API — so the
same source runs anywhere. Set `OCTYPO_ENGINE_URL` and `OCTYPO_SITE_KEY`, leave
`OCTYPO_HOSTED` unset, and deploy. `src/lib/engine-client.ts` is shared by the SSR
routes and by an Astro Content Layer loader, so a fully static build
(`prerender: true`) uses the same types and the same validation.
