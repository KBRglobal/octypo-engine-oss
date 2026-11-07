/**
 * Wiring: environment → engine client + tenant resolver.
 *
 * The one piece of module-level state in the whole blog is the tenant *cache*,
 * which is keyed by host and therefore safe on a warm isolate. Nothing else is
 * hoisted out of a request. That distinction is the difference between a
 * multi-tenant Worker that is fine and one that serves tenant A's article on
 * tenant B's domain, so it is stated here rather than left to be noticed.
 */

import { EngineClient } from './engine-client';
import { TenantResolver, type TenantLoader } from './tenant';
import type { TenantConfig } from './engine-client';

export interface RuntimeEnv {
  OCTYPO_ENGINE_URL?: string;
  OCTYPO_SITE_KEY?: string;
  OCTYPO_PURGE_SECRET?: string;
  OCTYPO_IMAGE_RESIZE_PREFIX?: string;
  OCTYPO_TENANT_TTL_SECONDS?: string;
  OCTYPO_PUBLICATION_TIMEZONE?: string;
  /** Set only in hosted mode: the engine resolves the tenant from the request host. */
  OCTYPO_HOSTED?: string;
  [key: string]: unknown;
}

export interface RuntimeConfig {
  engineUrl: string;
  siteKey: string;
  purgeSecret: string;
  imageResizePrefix: string | null;
  publicationTimeZone: string;
  tenantTtlMs: number;
  hosted: boolean;
}

export class MissingConfigError extends Error {
  constructor(name: string) {
    super(`${name} is not configured`);
    this.name = 'MissingConfigError';
  }
}

const DEFAULT_TENANT_TTL_SECONDS = 300;

function publicationTimeZone(value: unknown): string {
  const candidate = String(value ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

export function readRuntimeConfig(env: RuntimeEnv): RuntimeConfig {
  const engineUrl = (env.OCTYPO_ENGINE_URL ?? '').trim();
  const siteKey = (env.OCTYPO_SITE_KEY ?? '').trim();
  if (!engineUrl) throw new MissingConfigError('OCTYPO_ENGINE_URL');
  if (!siteKey) throw new MissingConfigError('OCTYPO_SITE_KEY');

  const ttlSeconds = Number(env.OCTYPO_TENANT_TTL_SECONDS);
  return {
    engineUrl,
    siteKey,
    purgeSecret: (env.OCTYPO_PURGE_SECRET ?? '').trim(),
    // Absent means self-host: serve the engine's original R2 URLs rather than
    // rewriting them onto a resizing path that does not exist on this zone.
    imageResizePrefix: (env.OCTYPO_IMAGE_RESIZE_PREFIX ?? '').trim() || null,
    publicationTimeZone: publicationTimeZone(env.OCTYPO_PUBLICATION_TIMEZONE),
    tenantTtlMs: (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TENANT_TTL_SECONDS) * 1000,
    hosted: env.OCTYPO_HOSTED === 'true' || env.OCTYPO_HOSTED === '1',
  };
}

export function createEngineClient(config: RuntimeConfig, host?: string): EngineClient {
  return new EngineClient({
    baseUrl: config.engineUrl,
    siteKey: config.siteKey,
    // Self-host keys are already tenant-scoped; only hosted mode needs the host.
    tenantHost: config.hosted ? host : undefined,
  });
}

export function createTenantLoader(config: RuntimeConfig): TenantLoader {
  return async (host: string): Promise<TenantConfig | null> => {
    const client = createEngineClient(config, host);
    return client.getConfig();
  };
}

// Keyed by host, so a warm isolate reuses configs without ever carrying a
// tenant identity across requests.
let sharedResolver: TenantResolver | null = null;
let sharedResolverKey = '';

export function getTenantResolver(config: RuntimeConfig): TenantResolver {
  const key = `${config.engineUrl}|${config.tenantTtlMs}|${config.hosted}`;
  if (!sharedResolver || sharedResolverKey !== key) {
    sharedResolver = new TenantResolver({ load: createTenantLoader(config), ttlMs: config.tenantTtlMs });
    sharedResolverKey = key;
  }
  return sharedResolver;
}

/** Test seam — a new isolate is the production equivalent. */
export function resetTenantResolver(): void {
  sharedResolver = null;
  sharedResolverKey = '';
}
