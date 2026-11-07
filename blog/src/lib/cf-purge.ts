/**
 * Cache-tag purge against the Cloudflare API.
 *
 * Deliberately best-effort and never throwing: a failed purge means an article
 * is stale for up to the reconcile interval, while a thrown error inside the
 * webhook handler would make the engine retry a delivery that has already
 * succeeded. Staleness is bounded; a retry storm is not.
 */

export interface PurgeEnv {
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_PURGE_TOKEN?: string;
  [key: string]: unknown;
}

const CF_MAX_TAGS_PER_CALL = 30;

export interface PurgeOutcome {
  attempted: boolean;
  ok: boolean;
}

export async function purgeCacheTags(
  tags: string[],
  env: PurgeEnv,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<PurgeOutcome> {
  const zone = (env.CLOUDFLARE_ZONE_ID ?? '').toString().trim();
  const token = (env.CLOUDFLARE_PURGE_TOKEN ?? '').toString().trim();
  if (!zone || !token || tags.length === 0) return { attempted: false, ok: false };

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += CF_MAX_TAGS_PER_CALL) {
    batches.push(tags.slice(i, i + CF_MAX_TAGS_PER_CALL));
  }

  let ok = true;
  for (const batch of batches) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tags: batch }),
      });
      if (!response.ok) ok = false;
    } catch {
      ok = false;
    }
  }
  return { attempted: true, ok };
}
