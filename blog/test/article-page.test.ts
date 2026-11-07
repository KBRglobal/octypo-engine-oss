import { describe, it, expect } from 'vitest';

import { renderBlocks, blocksToPlainText } from '../src/lib/blocks';
import { buildArticleSeo, renderMetaTags } from '../src/lib/seo';
import { collectSchemaUrls, parseSchema } from '../src/lib/schema-url';
import { renderThemeStyle } from '../src/lib/theme';
import { applyEdgeHeaders, routeClassFor } from '../src/lib/cache';
import type { Article, TenantConfig } from '../src/lib/engine-client';
import { ENGINE_BLOCK_FIXTURE, LEGACY_UNSANITISED_BLOCKS, OLD_HOST_SEO_SCHEMA } from './fixtures/blocks';

/**
 * Composes the whole article page the way the .astro route does, so the
 * page-level invariants are asserted somewhere a test can see them. Astro
 * components are deliberately thin wrappers over these functions for exactly
 * this reason.
 */

const tenant: TenantConfig = {
  slug: 'acme',
  siteName: 'Acme',
  siteUrl: 'https://acme.com',
  articlePathPrefix: '/blog',
  topicPathPrefix: '/topics',
  locale: 'en',
  brand: { accent: '#ff0055', customCss: '.octypo-hero { border-radius: 0 }' },
} as TenantConfig;

const article: Article = {
  slug: 'deposit-rules-explained',
  title: 'Deposit rules explained',
  metaTitle: 'Deposit rules explained | Acme',
  metaDescription: 'What tenants can claim back.',
  summary: 'A summary.',
  answerCapsule: 'The landlord holds five percent of the annual rent for the duration of the tenancy.',
  heroImage: 'https://pub-abc.r2.dev/hero.png',
  heroImageAlt: 'Keys on a table',
  tags: ['deposits'],
  wordCount: 1200,
  publishedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  blocks: ENGINE_BLOCK_FIXTURE,
  seoSchema: OLD_HOST_SEO_SCHEMA,
} as unknown as Article;

const opts = { imageResizePrefix: '/cdn-cgi/image' };
const ctx = {
  articlePathPrefix: tenant.articlePathPrefix,
  topicPathPrefix: tenant.topicPathPrefix,
  imageResizePrefix: opts.imageResizePrefix,
};

function renderPage(input: Article = article): string {
  const seo = buildArticleSeo(input, tenant, opts);
  return [
    '<head>',
    renderMetaTags(seo),
    seo.jsonLd ? `<script type="application/ld+json">${seo.jsonLd}</script>` : '',
    renderThemeStyle(tenant.brand),
    '</head><body>',
    renderBlocks(input.blocks, ctx),
    '</body>',
  ].join('\n');
}

describe('a rendered article page', () => {
  it('contains no client JavaScript beyond the JSON-LD data block', () => {
    const scripts = renderPage().match(/<script(?![^>]*application\/ld\+json)/g) ?? [];
    expect(scripts).toHaveLength(0);
  });

  it('loses no words from any block type', () => {
    const rendered = renderPage()
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ');
    for (const word of blocksToPlainText(ENGINE_BLOCK_FIXTURE).split(' ')) {
      expect(rendered, `dropped "${word}"`).toContain(word);
    }
  });

  // The single highest-value assertion in the suite: the engine's stored schema
  // still claims old-host.example, and served verbatim on acme.com that hands Google a
  // canonical claim for a domain the customer does not own.
  it('has no URL in its JSON-LD pointing anywhere but the tenant host', () => {
    const seo = buildArticleSeo(article, tenant, opts);
    for (const url of collectSchemaUrls(parseSchema(JSON.parse(seo.jsonLd!)))) {
      expect(url, `stale URL survived: ${url}`).toMatch(/^https:\/\/acme\.com/);
    }
  });

  // aeo.ts:117 writes "<SITE_NAME> Editorial" as the byline whenever there is
  // no named writer, so a row published under the old identity carries another
  // customer's brand as its author on this customer's page.
  it('does not print another tenant brand as the article byline', () => {
    const seo = buildArticleSeo(article, tenant, opts);
    expect(seo.jsonLd).not.toContain('Old Host');
    expect(seo.jsonLd).toContain('Acme Editorial');
  });

  it('has a self-referential canonical matching the served URL', () => {
    expect(renderPage()).toContain('href="https://acme.com/blog/deposit-rules-explained"');
  });

  it('routes every image through the resizing prefix, never a bare R2 PNG', () => {
    const page = renderPage();
    const srcs = [...page.matchAll(/(?:src|content)="([^"]+)"/g)].map(m => m[1]);
    const images = srcs.filter(src => /\.(png|jpe?g|webp|avif)/i.test(src));
    expect(images.length).toBeGreaterThan(0);
    for (const src of images) {
      expect(src, `unresized image: ${src}`).toContain('/cdn-cgi/image/');
    }
  });

  it('gives every image an explicit width and height', () => {
    for (const tag of renderPage().match(/<img\b[^>]*>/g) ?? []) {
      expect(tag).toMatch(/\bwidth="\d+"/);
      expect(tag).toMatch(/\bheight="\d+"/);
    }
  });

  it('sanitises a pre-778fc89 row that the engine never cleaned', () => {
    const page = renderPage({ ...article, blocks: LEGACY_UNSANITISED_BLOCKS } as Article);
    const executable = page.match(/<script(?![^>]*application\/ld\+json)/g) ?? [];
    expect(executable).toHaveLength(0);
    expect(page).not.toContain('javascript:');
    expect(page).toContain('deposit rules');
  });

  it('applies the tenant brand as custom properties without a rebuild', () => {
    expect(renderPage()).toContain('--octypo-accent: #ff0055');
  });

  it('never carries the engine noindex header', () => {
    const headers = new Headers({ 'x-robots-tag': 'noindex, nofollow, noarchive' });
    applyEdgeHeaders(headers, {
      tenantSlug: tenant.slug,
      routeClass: routeClassFor('/blog/deposit-rules-explained', tenant.articlePathPrefix),
      slug: article.slug,
    });
    expect(headers.get('x-robots-tag')).toBeNull();
    expect(renderPage()).not.toContain('noindex');
  });

  it('is cacheable for a year at the edge and purgeable by its own tag', () => {
    const headers = new Headers();
    applyEdgeHeaders(headers, {
      tenantSlug: tenant.slug,
      routeClass: routeClassFor('/blog/deposit-rules-explained', tenant.articlePathPrefix),
      slug: article.slug,
    });
    expect(headers.get('cache-control')).toContain('s-maxage=31536000');
    expect(headers.get('cache-tag')).toContain('article:acme:deposit-rules-explained');
  });

  it('renders at all for a minimal article with almost nothing set', () => {
    const bare = {
      slug: 'x',
      title: 'X',
      tags: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
      blocks: [],
    } as unknown as Article;
    expect(() => renderPage(bare)).not.toThrow();
    expect(renderPage(bare)).toContain('<title>X</title>');
  });
});
