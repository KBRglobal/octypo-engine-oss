/**
 * Edge caching policy.
 *
 * The commercial argument for SSR-plus-purge over a static build is here: an
 * article is immutable at the edge until a publish purges its tag, so serving
 * article 3,601 costs the same as serving article 1. There is no build whose
 * duration grows with the corpus and no build that can silently fail and freeze
 * a paying customer's site.
 *
 * Every cache tag carries the tenant slug. A tag without it would let one
 * customer's publish flush every other customer's cache.
 */

export type RouteClass = 'article' | 'listing' | 'feed' | 'private';

const YEAR_SECONDS = 31_536_000;

export function routeClassFor(pathname: string, articlePathPrefix: string): RouteClass {
  const prefix = (articlePathPrefix || '').replace(/\/+$/, '');
  const scopedPath = prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))
    ? pathname.slice(prefix.length) || '/'
    : pathname;

  if (scopedPath.startsWith('/api/')) return 'private';
  if (/^\/(rss\.xml|sitemap[^/]*\.xml|robots\.txt)$/.test(scopedPath)) return 'feed';

  if (prefix && pathname === prefix) return 'listing';
  if (prefix && pathname.startsWith(`${prefix}/`)) {
    return pathname.slice(prefix.length + 1).includes('/') ? 'listing' : 'article';
  }
  if (!prefix && pathname !== '/' && !pathname.startsWith('/topics')) {
    return pathname.slice(1).includes('/') ? 'listing' : 'article';
  }
  return 'listing';
}

export function cacheControlFor(routeClass: RouteClass): string {
  switch (routeClass) {
    case 'article':
      // max-age=0 keeps the browser honest; s-maxage keeps the edge copy.
      return `public, max-age=0, s-maxage=${YEAR_SECONDS}, stale-while-revalidate=86400`;
    case 'listing':
      return 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
    case 'feed':
      return 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600';
    case 'private':
      return 'no-store';
  }
}

export function cacheTagsFor(tenantSlug: string, routeClass: RouteClass, slug?: string): string[] {
  if (routeClass === 'private') return [];
  const tags = [`tenant:${tenantSlug}`];
  if (routeClass === 'article' && slug) tags.push(`article:${tenantSlug}:${slug}`);
  else tags.push(`listing:${tenantSlug}`);
  return tags;
}

export interface EdgeHeaderOptions {
  tenantSlug: string;
  routeClass: RouteClass;
  slug?: string;
}

export function applyEdgeHeaders(headers: Headers, options: EdgeHeaderOptions): void {
  // Unconditional, not "if present": the point is that no future code path can
  // let the engine's noindex reach a browser.
  headers.delete('x-robots-tag');

  headers.set('cache-control', cacheControlFor(options.routeClass));

  const tags = cacheTagsFor(options.tenantSlug, options.routeClass, options.slug);
  if (tags.length > 0) headers.set('cache-tag', tags.join(','));
  else headers.delete('cache-tag');

  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('strict-transport-security', 'max-age=31536000');
  headers.set('x-frame-options', 'SAMEORIGIN');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}
