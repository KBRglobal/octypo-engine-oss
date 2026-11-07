import type { APIRoute } from 'astro';

import { buildSitemapPage, collectSitemapEntries, URLS_PER_SITEMAP } from '../lib/sitemap';

export const GET: APIRoute = async ({ locals, params }) => {
  const { tenant, engine } = locals;
  const page = Number(params.page);
  if (!Number.isInteger(page) || page < 1) {
    return new Response('Not found', { status: 404 });
  }

  const articles = await engine.listAllArticles({});
  const collected = collectSitemapEntries(
    articles,
    tenant.articlePathPrefix,
    tenant.topicPathPrefix
  );

  const slice = collected.slice((page - 1) * URLS_PER_SITEMAP, page * URLS_PER_SITEMAP);
  if (slice.length === 0 && page > 1) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(
    buildSitemapPage(slice, {
      siteUrl: tenant.siteUrl,
      articlePathPrefix: tenant.articlePathPrefix,
    }),
    { headers: { 'content-type': 'application/xml; charset=utf-8' } }
  );
};
