import { describe, it, expect } from 'vitest';

import { cacheControlFor, cacheTagsFor, applyEdgeHeaders, routeClassFor } from './cache';

describe('routeClassFor', () => {
  it('classifies article, listing, feed and asset routes', () => {
    expect(routeClassFor('/blog/deposit-rules', '/blog')).toBe('article');
    expect(routeClassFor('/blog', '/blog')).toBe('listing');
    expect(routeClassFor('/', '/blog')).toBe('listing');
    expect(routeClassFor('/topics/deposits', '/blog')).toBe('listing');
    expect(routeClassFor('/rss.xml', '/blog')).toBe('feed');
    expect(routeClassFor('/sitemap.xml', '/blog')).toBe('feed');
    expect(routeClassFor('/blog/sitemap.xml', '/blog')).toBe('feed');
    expect(routeClassFor('/blog/sitemap-1.xml', '/blog')).toBe('feed');
    expect(routeClassFor('/blog/rss.xml', '/blog')).toBe('feed');
    expect(routeClassFor('/robots.txt', '/blog')).toBe('feed');
    expect(routeClassFor('/api/purge', '/blog')).toBe('private');
    expect(routeClassFor('/blog/api/purge', '/blog')).toBe('private');
  });
});

describe('cacheControlFor', () => {
  // Articles are immutable until a publish purges them by tag; the corpus size
  // is then irrelevant, which is the whole reason for SSR-plus-purge over SSG.
  it('caches an article at the edge for a year with stale-while-revalidate', () => {
    const value = cacheControlFor('article');
    expect(value).toContain('max-age=0');
    expect(value).toContain('s-maxage=31536000');
    expect(value).toContain('stale-while-revalidate=86400');
    expect(value).toContain('public');
  });

  it('caches listings only briefly, because a publish reorders them', () => {
    expect(cacheControlFor('listing')).toContain('s-maxage=60');
  });

  it('never caches a private route', () => {
    expect(cacheControlFor('private')).toContain('no-store');
  });
});

describe('cacheTagsFor', () => {
  it('tags an article with both its slug and its tenant, so either can be purged', () => {
    const tags = cacheTagsFor('acme', 'article', 'deposit-rules');
    expect(tags).toContain('tenant:acme');
    expect(tags).toContain('article:acme:deposit-rules');
  });

  it('tags listings so any publish can invalidate them wholesale', () => {
    expect(cacheTagsFor('acme', 'listing')).toContain('listing:acme');
  });

  it('never emits a tag without the tenant in it — a shared tag purges every customer', () => {
    for (const tag of cacheTagsFor('acme', 'article', 'x')) {
      expect(tag).toContain('acme');
    }
  });
});

describe('applyEdgeHeaders', () => {
  // src/index.ts:55-58 stamps noindex on every engine response. If the blog ever
  // copies engine headers, every customer silently drops out of Google.
  it('strips X-Robots-Tag no matter how it got onto the response', () => {
    const headers = new Headers({ 'x-robots-tag': 'noindex, nofollow, noarchive' });
    applyEdgeHeaders(headers, { tenantSlug: 'acme', routeClass: 'article', slug: 'x' });
    expect(headers.get('x-robots-tag')).toBeNull();
  });

  it('sets cache-control and cache-tag together', () => {
    const headers = new Headers();
    applyEdgeHeaders(headers, { tenantSlug: 'acme', routeClass: 'article', slug: 'x' });
    expect(headers.get('cache-control')).toContain('s-maxage=31536000');
    expect(headers.get('cache-tag')).toContain('article:acme:x');
  });

  it('adds baseline security headers', () => {
    const headers = new Headers();
    applyEdgeHeaders(headers, { tenantSlug: 'acme', routeClass: 'article', slug: 'x' });
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('does not attach a cache tag to a private route', () => {
    const headers = new Headers();
    applyEdgeHeaders(headers, { tenantSlug: 'acme', routeClass: 'private' });
    expect(headers.get('cache-tag')).toBeNull();
    expect(headers.get('cache-control')).toContain('no-store');
  });
});
