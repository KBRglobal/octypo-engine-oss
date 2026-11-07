import type { APIRoute } from 'astro';

import { buildRssFeed } from '../lib/feed';
import { isTombstone } from '../lib/engine-client';

export const GET: APIRoute = async ({ locals }) => {
  const { tenant, engine, config } = locals;
  const page = await engine.listArticles({ limit: 50 });
  // A removed article has to leave the feed as well as the site, or readers
  // keep being pointed at a URL that now 404s.
  const items = page.items.filter(item => !isTombstone(item));

  return new Response(buildRssFeed(items as never, tenant, { imageResizePrefix: config.imageResizePrefix }), {
    headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  });
};
