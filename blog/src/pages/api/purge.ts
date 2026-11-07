import type { APIRoute } from 'astro';

import { verifyPurgeSignature, parsePurgePayload, purgeTagsFor, SIGNATURE_HEADER } from '../../lib/purge';
import { purgeCacheTags } from '../../lib/cf-purge';
import { workerEnv } from '../../lib/worker-env';

/**
 * The webhook receiver that makes "publish an article and it is live in
 * seconds" true without a rebuild.
 *
 * Everything is verified before anything is done: an unauthenticated purge
 * endpoint is a free cache-flush denial of service, because every purge forces
 * a cold render of the affected pages against the engine.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const { tenant, config } = locals;

  if (!config.purgeSecret) {
    // Unconfigured means "refuse", never "accept anything". The reconcile cron
    // keeps the blog correct in the meantime.
    return new Response('Purge is not configured', { status: 503 });
  }

  const body = await request.text();
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!(await verifyPurgeSignature(body, signature, config.purgeSecret))) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = parsePurgePayload(body);
  if (!payload) return new Response('Malformed payload', { status: 400 });

  const tags = purgeTagsFor(payload, tenant.slug);
  await purgeCacheTags(tags, await workerEnv());

  return new Response(JSON.stringify({ purged: tags }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
