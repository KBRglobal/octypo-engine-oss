/**
 * Per-request tenant identity and edge headers.
 *
 * This is the highest-risk file in the blog: one Worker serves every customer,
 * so a mistake here puts one customer's articles on another's domain. Two
 * invariants, both enforced by tests rather than by review:
 *
 *   1. The tenant comes from the request Host on every request. Nothing about a
 *      tenant is stored outside `context.locals`, which is per-request.
 *   2. `X-Robots-Tag` is deleted from every outgoing response, unconditionally.
 *      The engine sets `noindex` on everything it serves (src/index.ts:55-58),
 *      so any future code path that forwards an engine header would silently
 *      de-index every customer at once.
 */

import type { MiddlewareHandler } from 'astro';

import { readRuntimeConfig, createEngineClient, getTenantResolver, MissingConfigError } from './lib/runtime';
import { UnknownTenantError, normaliseHost } from './lib/tenant';
import { workerEnv } from './lib/worker-env';
import { applyEdgeHeaders, routeClassFor } from './lib/cache';

export const onRequest: MiddlewareHandler = async (context, next) => {
  const env = await workerEnv();

  let config;
  try {
    config = readRuntimeConfig(env);
  } catch (error) {
    if (error instanceof MissingConfigError) {
      // A blog with no engine cannot render anything. Say so, loudly, instead of
      // serving an indexable blank page with a 200.
      return new Response(`Octypo blog is not configured: ${error.message}`, {
        status: 503,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
      });
    }
    throw error;
  }

  const host = normaliseHost(context.request.headers.get('host'));
  let tenant;
  try {
    tenant = await getTenantResolver(config).resolve(host);
  } catch (error) {
    if (error instanceof UnknownTenantError) {
      return new Response('No Octypo blog is configured for this domain.', {
        status: 404,
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain' },
      });
    }
    throw error;
  }

  const locals = context.locals as Record<string, unknown>;
  locals.tenant = tenant;
  locals.config = config;
  locals.engine = createEngineClient(config, host ?? undefined);

  const response = await next();

  const pathname = new URL(context.request.url).pathname;
  const routeClass = routeClassFor(pathname, tenant.articlePathPrefix);
  const prefix = (tenant.articlePathPrefix || '').replace(/\/+$/, '');
  const slug = routeClass === 'article' ? pathname.slice((prefix ? prefix.length : 0) + 1) : undefined;

  // A 404 must never inherit the article cache policy. A transient engine blip
  // returned "not found", and a year-long s-maxage then pinned that at the edge
  // on a tag only a working purge could clear — so a real article could stay
  // invisible long after it existed.
  if (response.status >= 400) {
    // Error responses carry no cache tags. Private API failures must never be
    // shared at the edge; public 404s get only a short negative cache.
    applyEdgeHeaders(response.headers, { tenantSlug: tenant.slug, routeClass: 'private' });
    if (routeClass !== 'private') {
      response.headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
    }
    return response;
  }

  applyEdgeHeaders(response.headers, { tenantSlug: tenant.slug, routeClass, slug });
  return response;
};
