import { describe, it, expect } from 'vitest';

import { buildArticleSeo, buildPageSeo, canonicalUrl, renderMetaTags } from './seo';
import { OLD_HOST_SEO_SCHEMA } from '../../test/fixtures/blocks';
import type { Article, TenantConfig } from './engine-client';

const tenant = {
  slug: 'acme',
  siteName: 'Acme',
  siteUrl: 'https://acme.com',
  articlePathPrefix: '/blog',
  topicPathPrefix: '/topics',
  locale: 'en',
  brand: {},
} as TenantConfig;

const article = {
  slug: 'deposit-rules-explained',
  title: 'Deposit rules explained',
  metaTitle: 'Deposit rules explained | Acme',
  metaDescription: 'Everything a tenant can claim back.',
  summary: 'A summary.',
  answerCapsule: 'A capsule.',
  heroImage: 'https://pub-abc.r2.dev/hero.png',
  heroImageAlt: 'Keys on a table',
  tags: ['deposits'],
  publishedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  blocks: [],
  seoSchema: OLD_HOST_SEO_SCHEMA,
} as unknown as Article;

const opts = { imageResizePrefix: '/cdn-cgi/image' };

describe('canonicalUrl', () => {
  it('is self-referential and absolute on the tenant host', () => {
    expect(canonicalUrl(tenant, '/blog/deposit-rules-explained')).toBe(
      'https://acme.com/blog/deposit-rules-explained'
    );
  });

  // A canonical that disagrees with the served URL by one trailing slash is a
  // duplicate-content signal that costs the customer their ranking.
  it('normalises a trailing slash so canonical and request URL cannot disagree', () => {
    expect(canonicalUrl(tenant, '/blog/x/')).toBe('https://acme.com/blog/x');
    expect(canonicalUrl(tenant, '/blog/x')).toBe('https://acme.com/blog/x');
  });

  it('drops the query string, which is never part of the canonical', () => {
    expect(canonicalUrl(tenant, '/blog/x?utm_source=news')).toBe('https://acme.com/blog/x');
  });

  it('keeps the root path as a bare host', () => {
    expect(canonicalUrl(tenant, '/')).toBe('https://acme.com');
  });
});

describe('buildArticleSeo', () => {
  it('prefers metaTitle over title', () => {
    expect(buildArticleSeo(article, tenant, opts).title).toBe('Deposit rules explained | Acme');
  });

  it('falls back through title when metaTitle is absent', () => {
    const seo = buildArticleSeo({ ...article, metaTitle: null } as Article, tenant, opts);
    expect(seo.title).toBe('Deposit rules explained');
  });

  it('falls back description through summary and then the answer capsule', () => {
    expect(
      buildArticleSeo({ ...article, metaDescription: null } as Article, tenant, opts).description
    ).toBe('A summary.');
    expect(
      buildArticleSeo({ ...article, metaDescription: null, summary: null } as Article, tenant, opts)
        .description
    ).toBe('A capsule.');
  });

  it('strips markup from meta values so a poisoned title cannot break the head', () => {
    const seo = buildArticleSeo(
      { ...article, metaTitle: 'X</title><script>alert(1)</script>' } as Article,
      tenant,
      opts
    );
    expect(seo.title).not.toContain('<');
  });

  it('routes the og:image through the resizing prefix rather than a bare R2 PNG', () => {
    const seo = buildArticleSeo(article, tenant, opts);
    expect(seo.ogImage).toContain('/cdn-cgi/image/');
    expect(seo.ogImage).not.toMatch(/^https:\/\/pub-/);
  });

  // The engine's stored schema still says old-host.example; served verbatim on
  // acme.com it hands Google a canonical claim for another host.
  it('retargets every JSON-LD URL onto the tenant host', () => {
    const seo = buildArticleSeo(article, tenant, opts);
    expect(seo.jsonLd).toContain('https://acme.com/blog/deposit-rules-explained');
    expect(seo.jsonLd).not.toContain('old-host.example');
  });

  it('escapes < inside the serialised JSON-LD so it cannot close the script element', () => {
    const seo = buildArticleSeo(
      { ...article, seoSchema: [{ '@type': 'Article', headline: '</script><script>x' }] } as unknown as Article,
      tenant,
      opts
    );
    expect(seo.jsonLd).not.toContain('</script>');
  });

  it('never emits a noindex directive for a published article', () => {
    expect(buildArticleSeo(article, tenant, opts).robots).not.toContain('noindex');
  });

  it('survives an article with no hero image and no schema', () => {
    const seo = buildArticleSeo(
      { ...article, heroImage: null, seoSchema: null } as Article,
      tenant,
      opts
    );
    expect(seo.ogImage).toBeNull();
    expect(seo.jsonLd).toBeNull();
  });
});

describe('renderMetaTags', () => {
  it('emits canonical, description, OpenGraph and Twitter tags', () => {
    const html = renderMetaTags(buildArticleSeo(article, tenant, opts));
    expect(html).toContain('rel="canonical"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('name="twitter:image:alt"');
    expect(html).toContain('name="twitter:card"');
  });

  // src/index.ts:55-58 sets this on every engine response; it must never
  // survive into a page the blog serves.
  it('never emits a robots meta containing noindex', () => {
    expect(renderMetaTags(buildArticleSeo(article, tenant, opts))).not.toContain('noindex');
  });

  it('escapes attribute values', () => {
    const seo = buildArticleSeo({ ...article, metaDescription: 'a "quoted" & <b>bold</b>' } as Article, tenant, opts);
    const html = renderMetaTags(seo);
    expect(html).not.toContain('content="a "quoted"');
    expect(html).toContain('&quot;');
  });
});

describe('buildPageSeo', () => {
  it('gives listing pages social images and CollectionPage structured data', () => {
    const seo = buildPageSeo(
      {
        title: 'Acme insights',
        description: 'Practical answers and implementation guidance from Acme.',
        pathname: '/blog',
        ogImage: article.heroImage,
        ogImageAlt: article.heroImageAlt,
      },
      tenant,
      opts
    );
    expect(seo.ogImage).toContain('/cdn-cgi/image/');
    expect(seo.ogImageAlt).toBe('Keys on a table');
    expect(seo.jsonLd).toContain('CollectionPage');
    expect(seo.jsonLd).toContain('https://acme.com/blog');
  });
});
