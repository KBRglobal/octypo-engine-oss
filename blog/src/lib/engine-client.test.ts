import { describe, it, expect, vi } from 'vitest';

import { EngineClient, EngineResponseError, EngineHttpError } from './engine-client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const TENANT = {
  slug: 'acme',
  siteName: 'Acme',
  siteUrl: 'https://acme.com',
  articlePathPrefix: '/blog',
  topicPathPrefix: '/topics',
  brand: { accent: '#ff0055' },
  plan: 'growth',
};

const ARTICLE = {
  slug: 'deposit-rules',
  title: 'Deposit rules',
  publishedAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  tags: ['deposits'],
  blocks: [{ id: '1', type: 'text', data: { content: '<p>hi</p>' } }],
};

function makeClient(fetchImpl: typeof fetch) {
  return new EngineClient({
    baseUrl: 'https://engine.octypo.io',
    siteKey: 'octy_site_abc123',
    fetch: fetchImpl,
  });
}

describe('EngineClient authentication', () => {
  it('sends the site key as a bearer header', async () => {
    const spy = vi.fn(async () => jsonResponse({ tenant: TENANT }));
    await makeClient(spy as unknown as typeof fetch).getConfig();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer octy_site_abc123');
  });

  // A key in a query string ends up in access logs, Referer headers and the
  // Cloudflare cache key. It is the same class of mistake as a compiled-in
  // customer host in a shipped bundle.
  it('never puts the site key in the URL', async () => {
    const spy = vi.fn(async () =>
      jsonResponse({
        tenant: TENANT,
        article: ARTICLE,
        items: [],
        nextCursor: null,
        total: 0,
        limit: 12,
        offset: 0,
      })
    );
    const client = makeClient(spy as unknown as typeof fetch);
    await client.getConfig();
    await client.listArticles({ updatedSince: '2026-01-01T00:00:00.000Z', limit: 10 });
    await client.listPublications({ limit: 12, offset: 0 });
    await client.getArticle('x');
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain('octy_site_');
    }
  });

  it('surfaces a 401 as a typed error, not a parse failure', async () => {
    const client = makeClient((async () => jsonResponse({ error: 'Unauthorized' }, { status: 401 })) as never);
    await expect(client.getConfig()).rejects.toBeInstanceOf(EngineHttpError);
  });

  it('reports 404 as a null result for by-slug lookups instead of throwing', async () => {
    const client = makeClient((async () => jsonResponse({ error: 'not found' }, { status: 404 })) as never);
    await expect(client.getArticle('nope')).resolves.toBeNull();
  });
});

describe('EngineClient response validation', () => {
  // A silently changed engine payload renders a blank page on every customer
  // site. Failing loudly at the boundary is the only place it can be seen.
  it('throws on a config payload missing required fields', async () => {
    const client = makeClient((async () => jsonResponse({ tenant: { slug: 'acme' } })) as never);
    await expect(client.getConfig()).rejects.toBeInstanceOf(EngineResponseError);
  });

  it('throws on an article missing a slug', async () => {
    const client = makeClient((async () => jsonResponse({ article: { title: 'x' } })) as never);
    await expect(client.getArticle('x')).rejects.toBeInstanceOf(EngineResponseError);
  });

  it('tolerates unknown extra fields so the engine can add data without a blog deploy', async () => {
    const client = makeClient(
      (async () => jsonResponse({ article: { ...ARTICLE, somethingNew: 42 } })) as never
    );
    await expect(client.getArticle('deposit-rules')).resolves.toMatchObject({ slug: 'deposit-rules' });
  });

  it('accepts a block of an unknown type — the renderer degrades, the client must not reject', async () => {
    const client = makeClient(
      (async () =>
        jsonResponse({
          article: { ...ARTICLE, blocks: [{ id: '1', type: 'video', data: { content: '<p>hi</p>' } }] },
        })) as never
    );
    const article = await client.getArticle('deposit-rules');
    expect(article!.blocks[0].type).toBe('video');
  });
});

describe('EngineClient incremental sync', () => {
  it('passes updatedSince and cursor through as query parameters', async () => {
    const spy = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    await makeClient(spy as unknown as typeof fetch).listArticles({
      updatedSince: '2026-08-01T00:00:00.000Z',
      cursor: 'abc',
      limit: 50,
    });
    const url = new URL(String((spy.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get('updatedSince')).toBe('2026-08-01T00:00:00.000Z');
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('parses tombstones alongside live articles', async () => {
    const client = makeClient(
      (async () =>
        jsonResponse({
          items: [
            { slug: 'live-one', title: 'Live', updatedAt: '2026-08-02T00:00:00.000Z', tags: [] },
            { slug: 'gone-one', deleted: true, updatedAt: '2026-08-03T00:00:00.000Z' },
          ],
          nextCursor: 'next',
        })) as never
    );
    const page = await client.listArticles({});
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({ slug: 'gone-one', deleted: true });
    expect(page.nextCursor).toBe('next');
  });

  it('walks every page of a sync, following nextCursor to exhaustion', async () => {
    const pages = [
      { items: [{ slug: 'a', title: 'A', updatedAt: '1', tags: [] }], nextCursor: 'c1' },
      { items: [{ slug: 'b', title: 'B', updatedAt: '2', tags: [] }], nextCursor: null },
    ];
    let i = 0;
    const client = makeClient((async () => jsonResponse(pages[i++])) as never);
    const all = await client.listAllArticles({});
    expect(all.map(a => a.slug)).toEqual(['a', 'b']);
  });

  it('stops rather than looping forever if the engine echoes the same cursor', async () => {
    const client = makeClient(
      (async () =>
        jsonResponse({ items: [{ slug: 'a', title: 'A', updatedAt: '1', tags: [] }], nextCursor: 'same' })) as never
    );
    const all = await client.listAllArticles({ maxPages: 3 });
    expect(all.length).toBeLessThanOrEqual(3);
  });
});

describe('EngineClient publication listing', () => {
  it('requests a stable numbered page and validates the total', async () => {
    const spy = vi.fn(async () =>
      jsonResponse({ items: [ARTICLE], total: 25, limit: 12, offset: 12 })
    );
    const page = await makeClient(spy as unknown as typeof fetch).listPublications({
      limit: 12,
      offset: 12,
    });
    const url = new URL(String((spy.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe('/api/site/publications');
    expect(url.searchParams.get('limit')).toBe('12');
    expect(url.searchParams.get('offset')).toBe('12');
    expect(page.total).toBe(25);
    expect(page.items[0].slug).toBe('deposit-rules');
  });
});

describe('EngineClient hardening', () => {
  it('never forwards the engine X-Robots-Tag onward', async () => {
    // src/index.ts:55-58 sets noindex on *every* engine response. A blog that
    // copied response headers would de-index every customer silently.
    const client = makeClient(
      (async () =>
        jsonResponse({ tenant: TENANT }, { headers: { 'x-robots-tag': 'noindex, nofollow' } })) as never
    );
    const config = await client.getConfig();
    expect(Object.keys(config as object)).not.toContain('x-robots-tag');
  });

  it('sends no cookies and no credentials', async () => {
    const spy = vi.fn(async () => jsonResponse({ tenant: TENANT }));
    await makeClient(spy as unknown as typeof fetch).getConfig();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials ?? 'omit').toBe('omit');
  });

  it('names the tenant by host header in hosted mode, never by a path segment', async () => {
    const spy = vi.fn(async () => jsonResponse({ tenant: TENANT }));
    const client = new EngineClient({
      baseUrl: 'https://engine.octypo.io',
      siteKey: 'octy_site_platform',
      tenantHost: 'acme.octypo.blog',
      fetch: spy as unknown as typeof fetch,
    });
    await client.getConfig();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Octypo-Tenant-Host']).toBe('acme.octypo.blog');
    expect(String(url)).not.toContain('acme');
  });

  it('omits the tenant host header entirely in self-host mode', async () => {
    const spy = vi.fn(async () => jsonResponse({ tenant: TENANT }));
    await makeClient(spy as unknown as typeof fetch).getConfig();
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty('X-Octypo-Tenant-Host');
  });

  it('refuses to construct without a site key', () => {
    expect(
      () => new EngineClient({ baseUrl: 'https://e.io', siteKey: '', fetch: globalThis.fetch })
    ).toThrow(/site key/i);
  });
});
