/**
 * Host → tenant resolution.
 *
 * One Cloudflare Worker serves every customer's blog, so this is the single
 * place where a bug puts tenant A's articles on tenant B's domain. Two rules
 * follow from that and are enforced by tests rather than by care:
 *
 *  - There is no "current tenant". Nothing is ever written to module scope on
 *    behalf of a request. Everything is keyed by host, because a warm isolate
 *    handles request N+1 with whatever request N left behind.
 *  - A failed load is never cached. Otherwise one blip during a deploy pins a
 *    customer's site to an error for the whole TTL.
 *
 * The Host header is attacker-controlled, so it is validated as a bare hostname
 * before it is allowed to become a cache key or reach the engine.
 */

import type { TenantConfig } from './engine-client';

export class UnknownTenantError extends Error {
  constructor(readonly host: string | null) {
    super(host ? `No tenant is configured for host ${host}` : 'Request carried no usable Host header');
    this.name = 'UnknownTenantError';
  }
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normaliseHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip the port, then the FQDN trailing dot. Anything else — a scheme, a
  // path, credentials, whitespace — is not a hostname and is refused outright.
  const withoutPort = trimmed.replace(/:\d+$/, '');
  const host = withoutPort.replace(/\.$/, '');
  if (!HOSTNAME.test(host)) return null;
  return host;
}

export type TenantLoader = (host: string) => Promise<TenantConfig | null>;

export interface TenantResolverOptions {
  load: TenantLoader;
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  config: TenantConfig;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;

export class TenantResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<TenantConfig>>();
  private readonly load: TenantLoader;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TenantResolverOptions) {
    this.load = options.load;
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.cache.size;
  }

  async resolve(rawHost: string | null | undefined): Promise<TenantConfig> {
    const host = normaliseHost(rawHost);
    if (!host) throw new UnknownTenantError(typeof rawHost === 'string' ? rawHost : null);

    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > this.now()) {
      // Re-insert so Map iteration order stays least-recently-used first.
      this.cache.delete(host);
      this.cache.set(host, cached);
      return cached.config;
    }

    const existing = this.inFlight.get(host);
    if (existing) return existing;

    const pending = this.loadAndCache(host);
    this.inFlight.set(host, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(host);
    }
  }

  private async loadAndCache(host: string): Promise<TenantConfig> {
    const config = await this.load(host);
    if (!config) throw new UnknownTenantError(host);
    this.cache.set(host, { config, expiresAt: this.now() + this.ttlMs });
    this.evict();
    return config;
  }

  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Drop one host (or everything) — used by the purge webhook when a tenant's brand changes. */
  invalidate(rawHost?: string): void {
    if (rawHost === undefined) {
      this.cache.clear();
      return;
    }
    const host = normaliseHost(rawHost);
    if (host) this.cache.delete(host);
  }
}
