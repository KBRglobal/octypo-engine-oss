import type { APIRoute } from 'astro';

import { buildSitemapIndex, collectSitemapEntries, sitemapPageCount } from '../lib/sitemap';

/**
 * An index rather than a single file, even for a small tenant: the live article
 * feed drives every page count, so publishing, unpublishing and topic changes
 * are reflected without a build or deployment.
 */
export const GET: APIRoute = async ({ locals }) => {
  const { tenant, engine } = locals;
  const articles = await engine.listAllArticles({});
  const entries = collectSitemapEntries(
    articles,
    tenant.articlePathPrefix,
    tenant.topicPathPrefix
  );
  const newest = entries.reduce<string | null>(
    (latest, entry) => entry.updatedAt && (!latest || entry.updatedAt > latest) ? entry.updatedAt : latest,
    null
  );

  return new Response(buildSitemapIndex(
    sitemapPageCount(entries.length),
    tenant.siteUrl,
    newest,
    tenant.articlePathPrefix
  ), {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
};
