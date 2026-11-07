import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/engine-registry.js', () => ({
  EngineRegistry: {
    getEngineCount: () => 0,
    getNextFromQueue: () => null,
    reportSuccess: vi.fn(),
    reportError: vi.fn(),
  },
  generateWithEngine: vi.fn(),
}));

const { needsTranslation, sanitiseQuery, translateQuery } = await import('./query-language.js');
const { StockImageProvider } = await import('./stock-provider.js');

/**
 * Stock libraries index English. A non-Latin query returns nothing at every rung,
 * which is how the first non-English customer ended up with every article
 * published image-less and a log that only said "no relevant match".
 */
describe('detecting a query stock cannot search', () => {
  it('flags text with no Latin letters', () => {
    expect(needsTranslation('イベント用スクリーンのレンタル')).toBe(true);
    expect(needsTranslation('تأجير شاشات')).toBe(true);
  });

  it('leaves English alone', () => {
    expect(needsTranslation('led screen rental')).toBe(false);
    // A mixed phrase is searchable as-is; the Latin half carries it.
    expect(needsTranslation('شاشة LED متنقلة')).toBe(false);
  });
});

describe('sanitising what the model returned', () => {
  it('lowercases, strips punctuation and caps the length', () => {
    expect(sanitiseQuery('"LED Screen, Outdoor Event, Night, Crowd, Extra, More"')).toBe(
      'led screen outdoor event night'
    );
  });

  it('rejects an answer that came back in the original language', () => {
    expect(sanitiseQuery('شاشة عرض')).toBeNull();
  });

  it('rejects an empty answer', () => {
    expect(sanitiseQuery('   ')).toBeNull();
    expect(sanitiseQuery('')).toBeNull();
  });
});

describe('translation without an engine', () => {
  it('returns null rather than throwing, so the search still runs', async () => {
    expect(await translateQuery('شيء ما')).toBeNull();
  });
});

describe('the provider using a translation', () => {
  const upload = async (_d: Buffer, key: string) => `https://cdn.test/${key}`;

  it('searches in English for a non-Latin topic', async () => {
    const searched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('api.pexels.com')) {
        searched.push(new URL(url).searchParams.get('query') ?? '');
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({
      keys: { pexels: 'k' },
      upload,
      fetchImpl,
      fallback: null,
      translate: async () => 'led screen outdoor event',
    });

    await provider.getArticleImage('تأجير شاشات العرض للفعاليات', [], 'guide');
    expect(searched.length).toBeGreaterThan(0);
    expect(searched[0]).toContain('led screen');
  });

  it('falls back to the original query when translation fails', async () => {
    const searched: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('api.pexels.com')) {
        searched.push(new URL(url).searchParams.get('query') ?? '');
        return new Response(JSON.stringify({ photos: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    const provider = new StockImageProvider({
      keys: { pexels: 'k' },
      upload,
      fetchImpl,
      fallback: null,
      translate: async () => null,
    });

    await provider.getArticleImage('تأجير شاشات العرض للفعاليات', [], 'guide');
    // It still tried, rather than giving up before making a request.
    expect(searched.length).toBeGreaterThan(0);
  });

  it('does not spend a translation on an English topic', async () => {
    const translate = vi.fn(async () => 'never called');
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ photos: [] }), { status: 200 })
    ) as unknown as typeof fetch;

    const provider = new StockImageProvider({
      keys: { pexels: 'k' },
      upload,
      fetchImpl,
      fallback: null,
      translate,
    });

    await provider.getArticleImage('led screen rental for events', [], 'guide');
    expect(translate).not.toHaveBeenCalled();
  });
});
