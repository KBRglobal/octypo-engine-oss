import { describe, it, expect, vi } from 'vitest';

// site.ts imports the db module, which throws at import time without a
// connection string. These tests exercise pure projection and cursor logic, so
// the connection is stubbed rather than requiring a live Postgres.
vi.mock('../db.js', () => ({ db: {} }));

const { siteConfigFromEnv, envSiteKeyLookup, encodeCursor, decodeCursor, readLimit, readOffset, toSummary } =
  await import('./site.js');
const { hashSiteKey } = await import('./site-auth.js');

/**
 * These routes are the whole contract between the engine and a customer's blog.
 * They were missing entirely — the helper modules existed but nothing was ever
 * mounted, so every blog page died on `GET /api/site/config` with a 404.
 */
describe('site config', () => {
  it('produces every field the blog requires', () => {
    const cfg = siteConfigFromEnv({} as NodeJS.ProcessEnv);
    // The blog validates this with zod and hard-fails the page on a mismatch.
    for (const key of ['slug', 'siteName', 'siteUrl', 'articlePathPrefix', 'topicPathPrefix', 'locale', 'brand']) {
      expect(cfg).toHaveProperty(key);
    }
    expect(typeof cfg.brand).toBe('object');
  });

  it('takes the customer identity from the environment', () => {
    const cfg = siteConfigFromEnv({
      SITE_NAME: 'Example Site',
      SITE_URL: 'https://example.com/',
      ARTICLE_PATH_PREFIX: '/blog',
    } as NodeJS.ProcessEnv);
    expect(cfg.siteName).toBe('Example Site');
    expect(cfg.siteUrl).toBe('https://example.com'); // trailing slash removed
    expect(cfg.articlePathPrefix).toBe('/blog');
  });

  it('survives a malformed brand instead of taking the site down', () => {
    const cfg = siteConfigFromEnv({ OCTYPO_BRAND: '{not json' } as NodeJS.ProcessEnv);
    expect(cfg.brand).toEqual({});
  });

  it('ignores a brand that is not an object', () => {
    expect(siteConfigFromEnv({ OCTYPO_BRAND: '"red"' } as NodeJS.ProcessEnv).brand).toEqual({});
    expect(siteConfigFromEnv({ OCTYPO_BRAND: '[1,2]' } as NodeJS.ProcessEnv).brand).toEqual({});
  });
});

/**
 * `site-auth.ts` shipped with a key check that nothing ever called, so the whole
 * `/api/site/*` surface answered any caller. A single install has no tenant
 * table to look a key up in, so the lookup is satisfied from the environment.
 */
describe('site key authentication', () => {
  const config = siteConfigFromEnv({ OCTYPO_SITE_SLUG: 'example-site' } as NodeJS.ProcessEnv);

  it('stays open when no key is configured, so an existing install keeps working', () => {
    expect(envSiteKeyLookup(config, {} as NodeJS.ProcessEnv)).toBeNull();
    expect(envSiteKeyLookup(config, { OCTYPO_SITE_KEY: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('accepts the configured key and reports this deployment as the tenant', async () => {
    const lookup = envSiteKeyLookup(config, {
      OCTYPO_SITE_KEY: 'octy_site_realkeyvalue',
    } as NodeJS.ProcessEnv);
    const record = await lookup!(hashSiteKey('octy_site_realkeyvalue'));
    expect(record).toEqual({ tenantId: 'example-site', tenantSlug: 'example-site', revokedAt: null });
  });

  it('rejects any other key', async () => {
    const lookup = envSiteKeyLookup(config, {
      OCTYPO_SITE_KEY: 'octy_site_realkeyvalue',
    } as NodeJS.ProcessEnv);
    expect(await lookup!(hashSiteKey('octy_site_someoneelse'))).toBeNull();
    expect(await lookup!('')).toBeNull();
  });
});

describe('sync cursor', () => {
  it('round-trips', () => {
    const at = new Date('2026-08-21T10:00:00.000Z');
    const back = decodeCursor(encodeCursor(at, 'abc-123'));
    expect(back?.updatedAt.toISOString()).toBe(at.toISOString());
    expect(back?.id).toBe('abc-123');
  });

  it('rejects junk rather than paging from a wrong position', () => {
    // A silently-accepted bad cursor would skip articles during a sync, and the
    // blog would simply never show them.
    for (const bad of ['', 'not-base64!!', Buffer.from('nonsense').toString('base64url'), null, 42]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe('limits', () => {
  it('caps the page size so one request cannot pull the whole corpus', () => {
    expect(readLimit(9999)).toBe(100);
    expect(readLimit(10)).toBe(10);
  });

  it('falls back to a sane default for nonsense', () => {
    for (const bad of [undefined, 'abc', -5, 0, Number.NaN]) {
      expect(readLimit(bad)).toBe(50);
    }
  });

  it('accepts safe listing offsets and rejects invalid values', () => {
    expect(readOffset(24)).toBe(24);
    expect(readOffset('12')).toBe(12);
    expect(readOffset(-1)).toBe(0);
    expect(readOffset('nope')).toBe(0);
    expect(readOffset(999_999)).toBe(100_000);
  });
});

describe('summary projection', () => {
  it('never emits undefined for a field the blog schema requires', () => {
    const out = toSummary({ slug: 's', title: 't', updatedAt: new Date('2026-01-01') });
    expect(out.tags).toEqual([]);
    expect(out.metaTitle).toBeNull();
    expect(out.heroImage).toBeNull();
    expect(out.publishedAt).toBeNull();
    expect(typeof out.updatedAt).toBe('string');
  });
});
