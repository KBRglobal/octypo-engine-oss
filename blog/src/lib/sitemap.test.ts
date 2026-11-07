import { describe, it, expect } from 'vitest';

import {
  URLS_PER_SITEMAP,
  buildSitemapPage,
  buildSitemapIndex,
  collectSitemapEntries,
  sitemapPageCount,
} from './sitemap';

const site = { siteUrl: 'https://acme.com', articlePathPrefix: '/blog' };

const entries = [
  { slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z' },
  { slug: 'b', updatedAt: '2026-08-02T12:30:00.000Z' },
];

describe('buildSitemapPage', () => {
  // @astrojs/sitemap only enumerates prerendered routes and emits nothing at all
  // in SSR mode. Silently having no sitemap is indistinguishable from having one.
  it('emits one absolute <loc> per entry on the tenant host and prefix', () => {
    const xml = buildSitemapPage(entries, site);
    expect(xml).toContain('<loc>https://acme.com/blog/a</loc>');
    expect(xml).toContain('<loc>https://acme.com/blog/b</loc>');
  });

  it('emits <lastmod> from updatedAt so an edit is visible to crawlers', () => {
    expect(buildSitemapPage(entries, site)).toContain('<lastmod>2026-08-02T12:30:00.000Z</lastmod>');
  });

  it('emits exactly as many url elements as it was given', () => {
    const xml = buildSitemapPage(entries, site);
    expect(xml.match(/<url>/g)).toHaveLength(2);
  });

  it('xml-escapes a slug containing ampersands rather than emitting invalid XML', () => {
    const xml = buildSitemapPage([{ slug: 'a&b', updatedAt: '2026-08-01T00:00:00.000Z' }], site);
    expect(xml).toContain('a&amp;b');
    expect(xml).not.toMatch(/[^&]&[^a#]/);
  });

  it('skips an entry with an unparseable date rather than emitting a broken lastmod', () => {
    const xml = buildSitemapPage([{ slug: 'a', updatedAt: 'not-a-date' }], site);
    expect(xml).toContain('<loc>https://acme.com/blog/a</loc>');
    expect(xml).not.toContain('<lastmod>');
  });

  it('handles a root-mounted blog', () => {
    expect(buildSitemapPage(entries, { siteUrl: 'https://acme.com', articlePathPrefix: '/' })).toContain(
      '<loc>https://acme.com/a</loc>'
    );
  });

  it('honours an explicit path for index and topic URLs', () => {
    const xml = buildSitemapPage([
      { slug: '', path: '/blog', updatedAt: '2026-08-01T00:00:00.000Z' },
      { slug: 'seo', path: '/blog/topics/seo', updatedAt: '2026-08-02T00:00:00.000Z' },
    ], site);
    expect(xml).toContain('<loc>https://acme.com/blog</loc>');
    expect(xml).toContain('<loc>https://acme.com/blog/topics/seo</loc>');
  });
});

describe('collectSitemapEntries', () => {
  it('always includes the blog index, even before the first article publishes', () => {
    expect(collectSitemapEntries([], '/blog', '/blog/topics')).toEqual([
      { slug: '', path: '/blog', updatedAt: undefined },
    ]);
  });

  it('adds published articles and only non-empty topic hubs once', () => {
    const result = collectSitemapEntries([
      { slug: 'a', updatedAt: '2026-08-01T00:00:00.000Z', category: 'seo', tags: ['aeo', 'seo'] },
      { slug: 'b', updatedAt: '2026-08-03T00:00:00.000Z', category: 'web', tags: ['seo'] },
      { slug: 'gone', updatedAt: '2026-08-04T00:00:00.000Z', category: 'video', deleted: true },
    ], '/blog', '/blog/topics');

    expect(result.map(entry => entry.path ?? `/blog/${entry.slug}`)).toEqual([
      '/blog',
      '/blog/topics/aeo',
      '/blog/topics/seo',
      '/blog/topics/web',
      '/blog/a',
      '/blog/b',
    ]);
    expect(result.filter(entry => entry.path === '/blog/topics/seo')).toHaveLength(1);
  });
});

describe('sitemap paging', () => {
  it('stays under the 50k protocol limit', () => {
    expect(URLS_PER_SITEMAP).toBeLessThanOrEqual(45_000);
  });

  // A Scale tenant publishes 300 a month; year three is 10,800 and year twelve
  // crosses the limit. The failure is a sitemap crawlers silently reject.
  it('computes the page count from the published total', () => {
    expect(sitemapPageCount(0)).toBe(1);
    expect(sitemapPageCount(10)).toBe(1);
    expect(sitemapPageCount(URLS_PER_SITEMAP)).toBe(1);
    expect(sitemapPageCount(URLS_PER_SITEMAP + 1)).toBe(2);
  });

  it('builds an index pointing at every page', () => {
    const xml = buildSitemapIndex(3, site.siteUrl, '2026-08-02T12:30:00.000Z');
    expect(xml).toContain('<loc>https://acme.com/sitemap-1.xml</loc>');
    expect(xml).toContain('<loc>https://acme.com/sitemap-3.xml</loc>');
    expect(xml.match(/<sitemap>/g)).toHaveLength(3);
  });

  it('never emits an index with zero pages', () => {
    expect(buildSitemapIndex(0, site.siteUrl, null).match(/<sitemap>/g)).toHaveLength(1);
  });
});
