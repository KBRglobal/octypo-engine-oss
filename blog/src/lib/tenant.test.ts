import { describe, it, expect, vi } from 'vitest';

import { normaliseHost, TenantResolver, UnknownTenantError } from './tenant';
import type { TenantConfig } from './engine-client';

function config(slug: string): TenantConfig {
  return {
    slug,
    siteName: slug.toUpperCase(),
    siteUrl: `https://${slug}.com`,
    articlePathPrefix: '/blog',
    topicPathPrefix: '/topics',
    locale: 'en',
    brand: {},
  } as TenantConfig;
}

describe('normaliseHost', () => {
  it('lowercases, strips the port and strips a trailing dot', () => {
    expect(normaliseHost('ACME.Octypo.Blog:8787')).toBe('acme.octypo.blog');
    expect(normaliseHost('acme.octypo.blog.')).toBe('acme.octypo.blog');
  });

  it('returns null for a missing or malformed host', () => {
    expect(normaliseHost(null)).toBeNull();
    expect(normaliseHost('')).toBeNull();
    expect(normaliseHost('   ')).toBeNull();
  });

  // A Host header is attacker-controlled. Anything that is not a plain hostname
  // must not be allowed to become a cache key or reach the engine.
  it('rejects a host carrying a path, scheme, credentials or whitespace', () => {
    expect(normaliseHost('acme.octypo.blog/evil')).toBeNull();
    expect(normaliseHost('https://acme.octypo.blog')).toBeNull();
    expect(normaliseHost('user@acme.octypo.blog')).toBeNull();
    expect(normaliseHost('acme.octypo.blog other.octypo.blog')).toBeNull();
  });
});

describe('TenantResolver', () => {
  it('resolves a known host to its tenant config', async () => {
    const load = vi.fn(async (host: string) => config(host.split('.')[0]));
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });
    await expect(resolver.resolve('acme.octypo.blog')).resolves.toMatchObject({ slug: 'acme' });
  });

  it('throws UnknownTenantError when the loader has no tenant for the host', async () => {
    const resolver = new TenantResolver({ load: async () => null, ttlMs: 60_000 });
    await expect(resolver.resolve('nobody.octypo.blog')).rejects.toBeInstanceOf(UnknownTenantError);
  });

  it('throws UnknownTenantError for a malformed host without calling the loader', async () => {
    const load = vi.fn(async () => config('acme'));
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });
    await expect(resolver.resolve('https://acme.com/evil')).rejects.toBeInstanceOf(UnknownTenantError);
    expect(load).not.toHaveBeenCalled();
  });

  it('caches per host so a warm isolate does not re-fetch', async () => {
    const load = vi.fn(async (host: string) => config(host.split('.')[0]));
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });
    await resolver.resolve('acme.octypo.blog');
    await resolver.resolve('acme.octypo.blog');
    expect(load).toHaveBeenCalledTimes(1);
  });

  // THE failure mode of a single Worker serving every customer: module-scope
  // state written on request N and read on request N+1. A single-request test
  // cannot see it; back-to-back requests on the same warm instance can.
  it('does not bleed tenant A into tenant B on a warm instance', async () => {
    const load = vi.fn(async (host: string) => config(host.split('.')[0]));
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });

    const a1 = await resolver.resolve('acme.octypo.blog');
    const b1 = await resolver.resolve('other.octypo.blog');
    const a2 = await resolver.resolve('acme.octypo.blog');
    const b2 = await resolver.resolve('other.octypo.blog');

    expect(a1.slug).toBe('acme');
    expect(b1.slug).toBe('other');
    expect(a2.slug).toBe('acme');
    expect(b2.slug).toBe('other');
  });

  it('does not bleed under concurrent in-flight resolution of two hosts', async () => {
    const load = vi.fn(async (host: string) => {
      await new Promise(resolve => setTimeout(resolve, host.startsWith('acme') ? 20 : 1));
      return config(host.split('.')[0]);
    });
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });

    const [a, b] = await Promise.all([
      resolver.resolve('acme.octypo.blog'),
      resolver.resolve('other.octypo.blog'),
    ]);
    expect(a.slug).toBe('acme');
    expect(b.slug).toBe('other');
  });

  it('coalesces concurrent requests for the same host into one load', async () => {
    const load = vi.fn(async (host: string) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return config(host.split('.')[0]);
    });
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });
    await Promise.all([resolver.resolve('acme.octypo.blog'), resolver.resolve('acme.octypo.blog')]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('re-loads after the TTL expires so a brand change goes live', async () => {
    let colour = 'red';
    const load = vi.fn(async () => ({ ...config('acme'), brand: { accent: colour } }) as TenantConfig);
    const resolver = new TenantResolver({ load, ttlMs: 10, now: () => Date.now() });

    const first = await resolver.resolve('acme.octypo.blog');
    expect(first.brand.accent).toBe('red');

    colour = 'blue';
    await new Promise(resolve => setTimeout(resolve, 15));
    const second = await resolver.resolve('acme.octypo.blog');
    expect(second.brand.accent).toBe('blue');
  });

  it('does not cache a failed load, so a transient engine error is not sticky', async () => {
    let attempt = 0;
    const load = vi.fn(async () => {
      if (attempt++ === 0) throw new Error('engine down');
      return config('acme');
    });
    const resolver = new TenantResolver({ load, ttlMs: 60_000 });
    await expect(resolver.resolve('acme.octypo.blog')).rejects.toThrow('engine down');
    await expect(resolver.resolve('acme.octypo.blog')).resolves.toMatchObject({ slug: 'acme' });
  });

  it('evicts the least recently used entry rather than growing without bound', async () => {
    const load = vi.fn(async (host: string) => config(host.split('.')[0]));
    const resolver = new TenantResolver({ load, ttlMs: 60_000, maxEntries: 2 });
    await resolver.resolve('a.octypo.blog');
    await resolver.resolve('b.octypo.blog');
    await resolver.resolve('c.octypo.blog');
    expect(resolver.size).toBeLessThanOrEqual(2);
  });
});
