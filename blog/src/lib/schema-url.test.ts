import { describe, it, expect } from 'vitest';

import { retargetSchema, collectSchemaUrls } from './schema-url';
import { OLD_HOST_SEO_SCHEMA } from '../../test/fixtures/blocks';

const site = {
  siteUrl: 'https://acme.com',
  siteName: 'Acme',
  articlePathPrefix: '/blog',
};

const slug = 'deposit-rules-explained';

describe('retargetSchema', () => {
  // src/octypo/aeo.ts:46-48 bakes SITE_URL + ARTICLE_PATH_PREFIX into `url`,
  // `mainEntityOfPage` (:106) and every BreadcrumbList item (:146-153) at
  // publish time. API.md:74-79 tells the site to inject that verbatim. For a
  // tenant on another domain that hands Google canonical signals pointing at
  // someone else's host — nothing errors, the rankings simply never arrive.
  it('rewrites every absolute URL from a old-host payload onto the tenant host', () => {
    const out = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug });
    for (const url of collectSchemaUrls(out)) {
      expect(url, `stale URL survived: ${url}`).toMatch(/^https:\/\/acme\.com/);
    }
  });

  it('points the Article url and mainEntityOfPage at the tenant article path', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug }) as Record<string, any>[];
    expect(article.url).toBe('https://acme.com/blog/deposit-rules-explained');
    expect(article.mainEntityOfPage['@id']).toBe('https://acme.com/blog/deposit-rules-explained');
  });

  it('rewrites all three breadcrumb items, including the section landing page', () => {
    const out = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug }) as Record<string, any>[];
    const crumbs = out.find(s => s['@type'] === 'BreadcrumbList')!.itemListElement;
    expect(crumbs[0].item).toBe('https://acme.com');
    expect(crumbs[1].item).toBe('https://acme.com/blog');
    expect(crumbs[2].item).toBeUndefined(); // the current page carries no item
  });

  it('replaces the publisher name and url with the tenant brand', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug }) as Record<string, any>[];
    expect(article.publisher.name).toBe('Acme');
    expect(article.publisher.url).toBe('https://acme.com');
  });

  it('rewrites an engine-generated editorial byline to the tenant brand', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug }) as Record<string, any>[];
    expect(article.author.name).toBe('Acme Editorial');
    expect(article.author['@type']).toBe('Organization');
  });

  it('repairs an invalid object-string byline', () => {
    const [article] = retargetSchema(
      [{ '@type': 'Article', author: { '@type': 'Person', name: '[object Object]' } }],
      { ...site, slug }
    ) as Record<string, any>[];
    expect(article.author).toEqual({
      '@type': 'Organization',
      name: 'Acme Editorial',
      url: 'https://acme.com',
    });
  });

  it('leaves a real writer name alone', () => {
    const out = retargetSchema(
      [{ '@type': 'Article', author: { '@type': 'Person', name: 'Dana Levi' } }],
      { ...site, slug }
    ) as Record<string, any>[];
    expect(out[0].author.name).toBe('Dana Levi');
  });

  it('drops legacy FAQPage markup while visible answers remain in the page', () => {
    const out = retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug }) as Record<string, any>[];
    expect(out.find(s => s['@type'] === 'FAQPage')).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(OLD_HOST_SEO_SCHEMA);
    retargetSchema(OLD_HOST_SEO_SCHEMA, { ...site, slug });
    expect(JSON.stringify(OLD_HOST_SEO_SCHEMA)).toBe(before);
  });

  it('accepts a single object as well as an array', () => {
    const out = retargetSchema({ '@type': 'Article', url: 'https://old-host.example/guides/x' }, { ...site, slug });
    expect(out).toHaveLength(2);
    expect((out[0] as Record<string, unknown>).url).toBe('https://acme.com/blog/deposit-rules-explained');
  });

  it('emits exactly one site-owned breadcrumb schema', () => {
    const out = retargetSchema(
      [
        { '@type': 'Article', headline: 'Deposit rules explained' },
        { '@type': 'BreadcrumbList', itemListElement: [] },
        { '@type': 'BreadcrumbList', itemListElement: [] },
      ],
      { ...site, slug }
    ) as Record<string, any>[];
    const breadcrumbs = out.filter(schema => schema['@type'] === 'BreadcrumbList');
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0].itemListElement[1]).toMatchObject({
      name: 'Blog',
      item: 'https://acme.com/blog',
    });
  });

  it('accepts a JSON string (the engine column is typed to allow one)', () => {
    const out = retargetSchema(JSON.stringify(OLD_HOST_SEO_SCHEMA), { ...site, slug });
    expect(out.length).toBe(2);
  });

  it('returns an empty array for null, undefined and unparseable input', () => {
    expect(retargetSchema(null, { ...site, slug })).toEqual([]);
    expect(retargetSchema(undefined, { ...site, slug })).toEqual([]);
    expect(retargetSchema('{not json', { ...site, slug })).toEqual([]);
  });

  it('describes the article image while keeping it pointed at R2', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, {
      ...site,
      slug,
      imageUrl: 'https://pub-abc.r2.dev/hero.png',
      imageAlt: 'A detailed view of the deposit process',
    }) as Record<string, any>[];
    expect(article.image[0]).toEqual({
      '@type': 'ImageObject',
      url: 'https://pub-abc.r2.dev/hero.png',
      contentUrl: 'https://pub-abc.r2.dev/hero.png',
      description: 'A detailed view of the deposit process',
    });
  });

  it('keeps schema dates aligned with the published article row', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, {
      ...site,
      slug,
      publishedAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-02T09:00:00.000Z',
    }) as Record<string, any>[];
    expect(article.datePublished).toBe('2026-09-01T08:00:00.000Z');
    expect(article.dateModified).toBe('2026-09-02T09:00:00.000Z');
  });

  it('handles a root-mounted blog with no article prefix', () => {
    const [article] = retargetSchema(OLD_HOST_SEO_SCHEMA, {
      ...site,
      articlePathPrefix: '/',
      slug,
    }) as Record<string, any>[];
    expect(article.url).toBe('https://acme.com/deposit-rules-explained');
  });
});
