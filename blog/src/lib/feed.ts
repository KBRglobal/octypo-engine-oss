/**
 * RSS and robots.txt.
 *
 * Both are hand-rolled for the same reason as the sitemap: they must be built
 * from live engine data in an SSR request, not from a build-time route
 * enumeration. robots.txt in particular is written out explicitly rather than
 * left to a default, because the engine serves `Disallow: /` on its own
 * `/robots.txt` (src/index.ts:59-61) and any accidental inheritance of that
 * would remove every customer from search with no error anywhere.
 */

import { renderBlocks, blocksToPlainText, type Block } from './blocks';
import { sanitizeText } from './sanitize';
import type { ArticleSummary, TenantConfig } from './engine-client';

export interface FeedOptions {
  imageResizePrefix?: string | null;
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 50;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value: string): string {
  // The only sequence that can end a CDATA section.
  return `<![CDATA[${value.replace(/]]>/g, ']]&gt;')}]]>`;
}

function rfc822(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toUTCString();
}

function articleUrl(tenant: TenantConfig, slug: string): string {
  const base = tenant.siteUrl.replace(/\/+$/, '');
  const prefix = (tenant.articlePathPrefix || '').replace(/\/+$/, '');
  return prefix && prefix !== '/' ? `${base}${prefix}/${slug}` : `${base}/${slug}`;
}

type FeedItem = ArticleSummary & { blocks?: Block[] };

export function buildRssFeed(items: FeedItem[], tenant: TenantConfig, opts: FeedOptions = {}): string {
  const base = tenant.siteUrl.replace(/\/+$/, '');
  const prefix = (tenant.articlePathPrefix || '').replace(/\/+$/, '');
  const feedHome = prefix && prefix !== '/' ? `${base}${prefix}` : base;
  const max = opts.maxItems ?? DEFAULT_MAX_ITEMS;

  const entries = items
    .slice(0, max)
    .map(item => {
      const link = articleUrl(tenant, item.slug);
      const pubDate = rfc822(item.publishedAt ?? item.updatedAt);
      const description =
        sanitizeText(item.summary) ||
        sanitizeText(item.answerCapsule) ||
        (item.blocks ? blocksToPlainText(item.blocks).slice(0, 400) : '');

      const body = item.blocks
        ? renderBlocks(item.blocks, {
            articlePathPrefix: tenant.articlePathPrefix,
            topicPathPrefix: tenant.topicPathPrefix ?? '/topics',
            imageResizePrefix: opts.imageResizePrefix ?? null,
          })
        : '';

      return [
        '    <item>',
        `      <title>${xmlEscape(sanitizeText(item.title))}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="true">${xmlEscape(link)}</guid>`,
        pubDate ? `      <pubDate>${pubDate}</pubDate>` : '',
        description ? `      <description>${cdata(description)}</description>` : '',
        body ? `      <content:encoded>${cdata(body)}</content:encoded>` : '',
        ...(item.tags ?? []).map(tag => `      <category>${xmlEscape(tag)}</category>`),
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    <title>${xmlEscape(tenant.siteName)}</title>`,
    `    <link>${xmlEscape(feedHome)}</link>`,
    `    <description>${xmlEscape(`Latest from ${tenant.siteName}`)}</description>`,
    `    <language>${xmlEscape(tenant.locale ?? 'en')}</language>`,
    `    <atom:link href="${xmlEscape(`${feedHome}/rss.xml`)}" rel="self" type="application/rss+xml" />`,
    entries,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter(line => line !== '')
    .join('\n');
}

export function buildRobotsTxt(tenant: TenantConfig): string {
  const base = tenant.siteUrl.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
