/**
 * The <head> of an article page.
 *
 * Division of labour, per API.md:89-93: the engine supplies the data
 * (metaTitle, metaDescription, answerCapsule, heroImage, JSON-LD) and the site
 * owns indexing. "Owns indexing" is doing a lot of work in that sentence — it
 * is why the canonical is computed here from the request, why every JSON-LD URL
 * is rewritten here, and why nothing in this file can emit a noindex.
 */

import { sanitizeText, escapeHtml } from './sanitize';
import { resizedImageUrl } from './images';
import { retargetSchema, serialiseSchema } from './schema-url';
import type { Article, TenantConfig } from './engine-client';

export interface SeoOptions {
  imageResizePrefix: string | null;
}

export interface SeoModel {
  title: string;
  description: string;
  canonical: string;
  siteName: string;
  locale: string;
  ogType: string;
  ogImage: string | null;
  ogImageAlt: string | null;
  publishedTime: string | null;
  modifiedTime: string | null;
  jsonLd: string | null;
  robots: string;
}

const OG_IMAGE_WIDTH = 1200;

export function canonicalUrl(tenant: TenantConfig, pathname: string): string {
  const base = tenant.siteUrl.replace(/\/+$/, '');
  const path = (pathname.split('?')[0] ?? '').split('#')[0] ?? '';
  const clean = path.replace(/\/+$/, '');
  return clean && clean !== '/' ? `${base}${clean.startsWith('/') ? clean : `/${clean}`}` : base;
}

function articlePath(tenant: TenantConfig, slug: string): string {
  const prefix = (tenant.articlePathPrefix || '').replace(/\/+$/, '');
  return prefix && prefix !== '/' ? `${prefix}/${slug}` : `/${slug}`;
}

export function buildArticleSeo(article: Article, tenant: TenantConfig, opts: SeoOptions): SeoModel {
  const title = sanitizeText(article.metaTitle) || sanitizeText(article.title) || tenant.siteName;
  const description =
    sanitizeText(article.metaDescription) ||
    sanitizeText(article.summary) ||
    sanitizeText(article.answerCapsule) ||
    '';

  const canonical = canonicalUrl(tenant, articlePath(tenant, article.slug));
  const ogImage = article.heroImage
    ? resizedImageUrl(article.heroImage, { width: OG_IMAGE_WIDTH, prefix: opts.imageResizePrefix })
    : null;

  const schemas = retargetSchema(article.seoSchema, {
    siteUrl: tenant.siteUrl,
    siteName: tenant.siteName,
    articlePathPrefix: tenant.articlePathPrefix,
    slug: article.slug,
    imageUrl: article.heroImage,
    imageAlt: sanitizeText(article.heroImageAlt) || null,
    publisherLogoUrl:
      typeof tenant.brand?.logoUrl === 'string' ? tenant.brand.logoUrl : null,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
  });

  return {
    title,
    description,
    canonical,
    siteName: tenant.siteName,
    locale: tenant.locale ?? 'en',
    ogType: 'article',
    ogImage: ogImage || null,
    ogImageAlt: sanitizeText(article.heroImageAlt) || null,
    publishedTime: article.publishedAt ?? null,
    modifiedTime: article.updatedAt ?? null,
    jsonLd: schemas.length > 0 ? serialiseSchema(schemas) : null,
    // The blog exists to be indexed. There is deliberately no code path that
    // can put "noindex" here, however the engine answered.
    robots: 'index, follow, max-image-preview:large, max-snippet:-1',
  };
}

export function buildPageSeo(
  input: { title: string; description?: string; pathname: string; ogImage?: string | null; ogImageAlt?: string | null },
  tenant: TenantConfig,
  opts: SeoOptions
): SeoModel {
  const title = sanitizeText(input.title) || tenant.siteName;
  const description = sanitizeText(input.description) || '';
  const canonical = canonicalUrl(tenant, input.pathname);
  const sourceImage = input.ogImage || tenant.brand?.logoUrl || null;
  return {
    title,
    description,
    canonical,
    siteName: tenant.siteName,
    locale: tenant.locale ?? 'en',
    ogType: 'website',
    ogImage: sourceImage
      ? resizedImageUrl(sourceImage, { width: OG_IMAGE_WIDTH, prefix: opts.imageResizePrefix }) || null
      : null,
    ogImageAlt: sanitizeText(input.ogImageAlt) || title,
    publishedTime: null,
    modifiedTime: null,
    jsonLd: serialiseSchema([{
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      '@id': `${canonical}#page`,
      name: title,
      description,
      url: canonical,
      isPartOf: { '@type': 'WebSite', '@id': `${tenant.siteUrl.replace(/\/+$/, '')}/#website` },
      publisher: {
        '@type': 'Organization',
        '@id': `${tenant.siteUrl.replace(/\/+$/, '')}/#organization`,
        name: tenant.siteName,
        url: tenant.siteUrl.replace(/\/+$/, ''),
      },
    }]),
    robots: 'index, follow, max-image-preview:large, max-snippet:-1',
  };
}

function meta(attr: 'name' | 'property', key: string, value: string | null): string {
  if (!value) return '';
  return `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
}

export function renderMetaTags(seo: SeoModel): string {
  return [
    `<title>${escapeHtml(seo.title)}</title>`,
    meta('name', 'description', seo.description),
    `<link rel="canonical" href="${escapeHtml(seo.canonical)}">`,
    meta('name', 'robots', seo.robots),
    meta('property', 'og:type', seo.ogType),
    meta('property', 'og:title', seo.title),
    meta('property', 'og:description', seo.description),
    meta('property', 'og:url', seo.canonical),
    meta('property', 'og:site_name', seo.siteName),
    meta('property', 'og:locale', seo.locale),
    meta('property', 'og:image', seo.ogImage),
    meta('property', 'og:image:alt', seo.ogImageAlt),
    meta('property', 'article:published_time', seo.publishedTime),
    meta('property', 'article:modified_time', seo.modifiedTime),
    meta('name', 'twitter:card', seo.ogImage ? 'summary_large_image' : 'summary'),
    meta('name', 'twitter:title', seo.title),
    meta('name', 'twitter:description', seo.description),
    meta('name', 'twitter:image', seo.ogImage),
    meta('name', 'twitter:image:alt', seo.ogImageAlt),
  ]
    .filter(Boolean)
    .join('\n');
}
