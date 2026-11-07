import { describe, it, expect, vi } from 'vitest';

import { purgeCacheTags } from './cf-purge';

const env = { CLOUDFLARE_ZONE_ID: 'zone123', CLOUDFLARE_PURGE_TOKEN: 'tok' };

describe('purgeCacheTags', () => {
  it('POSTs the tags to the zone purge endpoint with a bearer token', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await purgeCacheTags(['article:acme:x'], env, spy as unknown as typeof fetch);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/zones/zone123/purge_cache');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(init.body))).toEqual({ tags: ['article:acme:x'] });
  });

  it('splits into batches of thirty, which is the API limit', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }));
    const tags = Array.from({ length: 61 }, (_, i) => `article:acme:${i}`);
    await purgeCacheTags(tags, env, spy as unknown as typeof fetch);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  // A throw here would make the engine retry a webhook it already delivered.
  // Staleness is bounded by the reconcile cron; a retry storm is not bounded.
  it('never throws when Cloudflare is unreachable', async () => {
    const spy = vi.fn(async () => {
      throw new Error('network');
    });
    await expect(purgeCacheTags(['a'], env, spy as unknown as typeof fetch)).resolves.toEqual({
      attempted: true,
      ok: false,
    });
  });

  it('reports a non-2xx as a failed purge rather than a success', async () => {
    const spy = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(purgeCacheTags(['a'], env, spy as unknown as typeof fetch)).resolves.toEqual({
      attempted: true,
      ok: false,
    });
  });

  it('does nothing when the zone or token is missing, or there is nothing to purge', async () => {
    const spy = vi.fn();
    await expect(purgeCacheTags(['a'], {}, spy as unknown as typeof fetch)).resolves.toEqual({
      attempted: false,
      ok: false,
    });
    await expect(purgeCacheTags([], env, spy as unknown as typeof fetch)).resolves.toEqual({
      attempted: false,
      ok: false,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
