/**
 * The reconcile cron — the floor under blog freshness.
 *
 * A publish webhook that never arrives is silent: the article is live in the
 * engine, the blog's edge cache still holds the old listing, and no error is
 * raised anywhere. Every five minutes this asks the engine what changed since
 * the stored watermark and purges those tags, so the worst case for a dropped
 * webhook is minutes of staleness rather than an article that never appears.
 *
 * State is one KV key per tenant. It is a watermark, not a cursor: cursors are
 * per-page and do not survive a redeploy.
 */

import { EngineClient } from '../src/lib/engine-client';
import { reconcile } from '../src/lib/reconcile';
import { purgeCacheTags } from '../src/lib/cf-purge';
import { readRuntimeConfig, type RuntimeEnv } from '../src/lib/runtime';

export interface ReconcileEnv extends RuntimeEnv {
  OCTYPO_STATE: KVNamespace;
  /** Comma-separated hosts to reconcile in hosted mode; empty means self-host. */
  OCTYPO_TENANT_HOSTS?: string;
}

const WATERMARK_KEY = (tenantSlug: string) => `watermark:${tenantSlug}`;

export async function reconcileTenant(env: ReconcileEnv, host?: string): Promise<number> {
  const config = readRuntimeConfig(env);
  const client = new EngineClient({
    baseUrl: config.engineUrl,
    siteKey: config.siteKey,
    tenantHost: config.hosted ? host : undefined,
  });

  const tenant = await client.getConfig();
  const previous = await env.OCTYPO_STATE.get(WATERMARK_KEY(tenant.slug));

  const items = await client.listAllArticles({ updatedSince: previous ?? undefined, limit: 200 });
  const result = reconcile(items, tenant.slug, previous);

  if (result.tags.length > 0) {
    await purgeCacheTags(result.tags, env);
  }
  // The watermark advances only after the purge is attempted; a crash in
  // between re-does the window rather than skipping it.
  if (result.watermark) {
    await env.OCTYPO_STATE.put(WATERMARK_KEY(tenant.slug), result.watermark);
  }

  return result.tags.length;
}

export default {
  async scheduled(_event: ScheduledEvent, env: ReconcileEnv, ctx: ExecutionContext): Promise<void> {
    const hosts = (env.OCTYPO_TENANT_HOSTS ?? '')
      .split(',')
      .map(host => host.trim())
      .filter(Boolean);

    const work = hosts.length > 0
      ? Promise.allSettled(hosts.map(host => reconcileTenant(env, host)))
      : reconcileTenant(env).catch(() => 0);

    ctx.waitUntil(work);
  },
};
