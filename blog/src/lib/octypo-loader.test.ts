import { describe, it, expect, vi } from 'vitest';

import { octypoLoader } from './octypo-loader';

function makeStore() {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    entries,
    store: {
      clear: () => entries.clear(),
      set: (entry: { id: string; data: Record<string, unknown> }) => void entries.set(entry.id, entry.data),
      delete: (id: string) => void entries.delete(id),
    },
  };
}

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const article = (slug: string) => ({
  slug,
  title: slug,
  updatedAt: '2026-08-01T00:00:00.000Z',
  tags: [],
  blocks: [{ id: '1', type: 'text', data: { content: `<p>${slug}</p>` } }],
});

describe('octypoLoader', () => {
  it('loads every published article into the store', async () => {
    const fetchImpl = stubFetch({
      '/api/site/articles': { items: [article('a'), article('b')], nextCursor: null },
      '/api/site/articles/a': { article: article('a') },
      '/api/site/articles/b': { article: article('b') },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const { store, entries } = makeStore();
    await octypoLoader({ engineUrl: 'https://engine.io', siteKey: 'octy_site_x' }).load({ store });

    expect([...entries.keys()].sort()).toEqual(['a', 'b']);
    vi.unstubAllGlobals();
  });

  // A static build that keeps emitting a page for a deleted article is the
  // static equivalent of never purging it: the URL stays live forever.
  it('removes a tombstoned article from the store', async () => {
    const fetchImpl = stubFetch({
      '/api/site/articles': {
        items: [article('a'), { slug: 'gone', deleted: true, updatedAt: '2026-08-02T00:00:00.000Z' }],
        nextCursor: null,
      },
      '/api/site/articles/a': { article: article('a') },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const { store, entries } = makeStore();
    entries.set('gone', { slug: 'gone' });
    await octypoLoader({ engineUrl: 'https://engine.io', siteKey: 'octy_site_x' }).load({ store });

    expect(entries.has('gone')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('skips an article that 404s between the list and the fetch, rather than failing the build', async () => {
    const fetchImpl = stubFetch({
      '/api/site/articles': { items: [article('a'), article('vanished')], nextCursor: null },
      '/api/site/articles/a': { article: article('a') },
    });
    vi.stubGlobal('fetch', fetchImpl);

    const { store, entries } = makeStore();
    await expect(
      octypoLoader({ engineUrl: 'https://engine.io', siteKey: 'octy_site_x' }).load({ store })
    ).resolves.toBeUndefined();
    expect([...entries.keys()]).toEqual(['a']);
    vi.unstubAllGlobals();
  });
});
