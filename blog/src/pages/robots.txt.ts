import type { APIRoute } from 'astro';

import { buildRobotsTxt } from '../lib/feed';

/**
 * Written explicitly rather than left to a default. The engine serves
 * `User-agent: * / Disallow: /` on its own /robots.txt (src/index.ts:59-61),
 * and any inheritance of that would remove every customer's blog from search
 * with no error anywhere.
 */
export const GET: APIRoute = ({ locals }) =>
  new Response(buildRobotsTxt(locals.tenant), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
