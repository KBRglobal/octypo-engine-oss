import { describe, it, expect, beforeEach } from 'vitest';

import { readRuntimeConfig, MissingConfigError, getTenantResolver, resetTenantResolver } from './runtime';

const base = { OCTYPO_ENGINE_URL: 'https://engine.octypo.io', OCTYPO_SITE_KEY: 'octy_site_abc' };

beforeEach(() => resetTenantResolver());

describe('readRuntimeConfig', () => {
  it('reads the engine URL and site key', () => {
    const config = readRuntimeConfig(base);
    expect(config.engineUrl).toBe('https://engine.octypo.io');
    expect(config.siteKey).toBe('octy_site_abc');
  });

  // Failing to boot is the correct behaviour: a blog with no engine cannot
  // render anything, and a blank page served with a 200 is worse than an error.
  it('throws rather than starting without an engine URL or a site key', () => {
    expect(() => readRuntimeConfig({ ...base, OCTYPO_ENGINE_URL: '' })).toThrow(MissingConfigError);
    expect(() => readRuntimeConfig({ ...base, OCTYPO_SITE_KEY: '  ' })).toThrow(MissingConfigError);
  });

  it('treats an absent resize prefix as self-host, not as an empty prefix', () => {
    expect(readRuntimeConfig(base).imageResizePrefix).toBeNull();
    expect(readRuntimeConfig(base).publicationTimeZone).toBe('UTC');
    expect(readRuntimeConfig({ ...base, OCTYPO_IMAGE_RESIZE_PREFIX: '/cdn-cgi/image' }).imageResizePrefix).toBe(
      '/cdn-cgi/image'
    );
    expect(readRuntimeConfig({ ...base, OCTYPO_PUBLICATION_TIMEZONE: 'Asia/Tokyo' }).publicationTimeZone).toBe(
      'Asia/Tokyo'
    );
    expect(readRuntimeConfig({ ...base, OCTYPO_PUBLICATION_TIMEZONE: 'not/a-zone' }).publicationTimeZone).toBe('UTC');
  });

  it('defaults the tenant TTL and ignores a nonsense value', () => {
    expect(readRuntimeConfig(base).tenantTtlMs).toBe(300_000);
    expect(readRuntimeConfig({ ...base, OCTYPO_TENANT_TTL_SECONDS: 'abc' }).tenantTtlMs).toBe(300_000);
    expect(readRuntimeConfig({ ...base, OCTYPO_TENANT_TTL_SECONDS: '-5' }).tenantTtlMs).toBe(300_000);
    expect(readRuntimeConfig({ ...base, OCTYPO_TENANT_TTL_SECONDS: '60' }).tenantTtlMs).toBe(60_000);
  });

  it('defaults to self-host mode unless hosting is explicitly on', () => {
    expect(readRuntimeConfig(base).hosted).toBe(false);
    expect(readRuntimeConfig({ ...base, OCTYPO_HOSTED: 'true' }).hosted).toBe(true);
    expect(readRuntimeConfig({ ...base, OCTYPO_HOSTED: 'yes' }).hosted).toBe(false);
  });

  it('never exposes the site key under a PUBLIC_ name', () => {
    const config = readRuntimeConfig(base);
    for (const [key, value] of Object.entries(config)) {
      if (key === 'siteKey' || key === 'purgeSecret') continue;
      expect(String(value)).not.toContain('octy_site_');
    }
  });
});

describe('getTenantResolver', () => {
  it('reuses one resolver across requests with the same config', () => {
    const config = readRuntimeConfig(base);
    expect(getTenantResolver(config)).toBe(getTenantResolver(readRuntimeConfig(base)));
  });

  // A cached resolver bound to the previous engine would keep answering with a
  // stale tenant set after a config change.
  it('rebuilds the resolver when the engine URL changes', () => {
    const first = getTenantResolver(readRuntimeConfig(base));
    const second = getTenantResolver(
      readRuntimeConfig({ ...base, OCTYPO_ENGINE_URL: 'https://other.octypo.io' })
    );
    expect(second).not.toBe(first);
  });
});
