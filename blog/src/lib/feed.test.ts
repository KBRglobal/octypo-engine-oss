import { describe, it, expect } from 'vitest';

import { buildRssFeed, buildRobotsTxt } from './feed';
import type { TenantConfig } from './engine-client';

const tenant = {
  slug: 'acme',
  siteName: 'Acme & Co',
  siteUrl: 'https://acme.com',
  articlePathPrefix: '/blog',
  topicPathPrefix: '/topics',
  locale: 'en',
  brand: {},
} as TenantConfig;

const items = [
  {
    slug: 'a',
    title: 'First & best',
    summary: 'A summary.',
    publishedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    tags: [],
  },
];

describe('buildRssFeed', () => {
  it('is well-formed RSS 2.0 with a self link', () => {
    const xml = buildRssFeed(items as never, tenant);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<atom:link href="https://acme.com/blog/rss.xml" rel="self"');
  });

  it('links each item at the tenant article path', () => {
    expect(buildRssFeed(items as never, tenant)).toContain('<link>https://acme.com/blog/a</link>');
  });

  it('escapes ampersands in the channel title and item titles', () => {
    const xml = buildRssFeed(items as never, tenant);
    expect(xml).toContain('Acme &amp; Co');
    expect(xml).toContain('First &amp; best');
  });

  it('emits an RFC-822 pubDate, not an ISO string', () => {
    expect(buildRssFeed(items as never, tenant)).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
  });

  it('emits content:encoded from rendered blocks when they are available', () => {
    const withBlocks = [
      { ...items[0], blocks: [{ id: '1', type: 'text', data: { content: '<p>Body text.</p>' } }] },
    ];
    const xml = buildRssFeed(withBlocks as never, tenant, { imageResizePrefix: null });
    expect(xml).toContain('content:encoded');
    expect(xml).toContain('Body text.');
  });

  it('omits an item with an unparseable date rather than emitting invalid RSS', () => {
    const xml = buildRssFeed([{ ...items[0], publishedAt: 'nope' }] as never, tenant);
    expect(xml).not.toContain('<pubDate>Invalid');
  });

  it('produces a valid empty feed when the tenant has published nothing yet', () => {
    const xml = buildRssFeed([], tenant);
    expect(xml).toContain('<channel>');
    expect(xml).not.toContain('<item>');
  });
});

describe('buildRobotsTxt', () => {
  // The engine serves "User-agent: * / Disallow: /" (src/index.ts:59-61).
  // Inheriting that would de-index every customer and nothing would report it.
  it('allows everything and never inherits the engine Disallow', () => {
    const txt = buildRobotsTxt(tenant);
    expect(txt).toContain('Allow: /');
    expect(txt).not.toContain('Disallow: /\n');
  });

  it('points at the tenant sitemap', () => {
    expect(buildRobotsTxt(tenant)).toContain('Sitemap: https://acme.com/sitemap.xml');
  });
});
