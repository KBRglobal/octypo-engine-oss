/**
 * Sitemaps, hand-rolled.
 *
 * @astrojs/sitemap enumerates prerendered routes at build time; in SSR mode
 * there are none, so it emits an empty file. That failure is invisible — the
 * URL exists, the XML is well-formed, and it lists nothing. The blog builds
 * sitemaps from `/api/site/manifest` instead, which is the same source of truth
 * the reconcile cron uses.
 */

/** Protocol limit is 50,000; the margin absorbs pages added between requests. */
export const URLS_PER_SITEMAP = 45_000;

export interface SitemapEntry {
  slug: string;
  updatedAt?: string;
  /** An explicit tenant-relative path for indexes and topic hubs. */
  path?: string;
}

export interface SitemapSite {
  siteUrl: string;
  articlePathPrefix: string;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function absolute(site: SitemapSite, entry: SitemapEntry): string {
  const base = site.siteUrl.replace(/\/+$/, '');
  if (entry.path) {
    const path = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
    return `${base}${path}`;
  }
  const prefix = (site.articlePathPrefix || '').replace(/\/+$/, '');
  const path = prefix && prefix !== '/' ? `${prefix}/${entry.slug}` : `/${entry.slug}`;
  return `${base}${path}`;
}

function isoOrNull(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface SitemapArticle {
  slug: string;
  updatedAt: string;
  category?: string | null;
  tags?: string[];
  deleted?: true;
}

function joinPath(prefix: string, segment?: string): string {
  const cleanPrefix = `/${prefix}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (!segment) return cleanPrefix;
  return `${cleanPrefix === '/' ? '' : cleanPrefix}/${encodeURIComponent(segment)}`;
}

/**
 * The listing, every live topic hub and every published article share one
 * source of truth. Drafts never reach this client, and deleted sync records are
 * filtered defensively so publishing or unpublishing changes the sitemap on
 * the next cache refresh without a deploy.
 */
export function collectSitemapEntries(
  items: SitemapArticle[],
  articlePathPrefix: string,
  topicPathPrefix: string
): SitemapEntry[] {
  const live = items.filter(item => !item.deleted);
  const newest = live.reduce<string | undefined>(
    (latest, item) => (!latest || item.updatedAt > latest ? item.updatedAt : latest),
    undefined
  );
  const topics = new Map<string, string>();

  for (const item of live) {
    for (const raw of [item.category, ...(item.tags ?? [])]) {
      const topic = typeof raw === 'string' ? raw.trim() : '';
      if (!topic) continue;
      const previous = topics.get(topic);
      if (!previous || item.updatedAt > previous) topics.set(topic, item.updatedAt);
    }
  }

  return [
    { slug: '', path: joinPath(articlePathPrefix), updatedAt: newest },
    ...[...topics.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([topic, updatedAt]) => ({
        slug: topic,
        path: joinPath(topicPathPrefix, topic),
        updatedAt,
      })),
    ...live.map(item => ({ slug: item.slug, updatedAt: item.updatedAt })),
  ];
}

export function sitemapPageCount(totalUrls: number): number {
  return Math.max(1, Math.ceil(totalUrls / URLS_PER_SITEMAP));
}

export function buildSitemapPage(entries: SitemapEntry[], site: SitemapSite): string {
  const urls = entries
    .map(entry => {
      const lastmod = isoOrNull(entry.updatedAt);
      return (
        '  <url>\n' +
        `    <loc>${xmlEscape(absolute(site, entry))}</loc>\n` +
        (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '') +
        '  </url>'
      );
    })
    .join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls}\n` +
    '</urlset>\n'
  );
}

export function buildSitemapIndex(
  pageCount: number,
  siteUrl: string,
  lastmod: string | null,
  articlePathPrefix = ''
): string {
  const base = siteUrl.replace(/\/+$/, '');
  const prefix = articlePathPrefix && articlePathPrefix !== '/'
    ? `/${articlePathPrefix.replace(/^\/+|\/+$/g, '')}`
    : '';
  const iso = lastmod ? isoOrNull(lastmod) : null;
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, i) =>
    '  <sitemap>\n' +
    `    <loc>${xmlEscape(`${base}${prefix}/sitemap-${i + 1}.xml`)}</loc>\n` +
    (iso ? `    <lastmod>${iso}</lastmod>\n` : '') +
    '  </sitemap>'
  ).join('\n');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${pages}\n` +
    '</sitemapindex>\n'
  );
}
