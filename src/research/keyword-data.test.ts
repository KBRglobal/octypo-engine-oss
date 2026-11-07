import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  toMetrics,
  extractResults,
  chunk,
  DataForSeoProvider,
  dataForSeoConfigFromEnv,
  keywordDataProviderFromEnv,
  MAX_KEYWORDS_PER_TASK,
} = await import('./keyword-data.js');

const config = { login: 'l', password: 'p' };

describe('configuration', () => {
  it('is null without credentials, so the engine ranks without volume', () => {
    expect(dataForSeoConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(keywordDataProviderFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('is present once both halves are set', () => {
    expect(
      keywordDataProviderFromEnv({
        DATAFORSEO_LOGIN: 'l',
        DATAFORSEO_PASSWORD: 'p',
      } as NodeJS.ProcessEnv)
    ).not.toBeNull();
  });
});

describe('metrics normalisation', () => {
  it('reads the flat shape the Google Ads endpoint returns', () => {
    expect(toMetrics({ keyword: 'LED Truck', search_volume: 1300, competition: 0.42, cpc: 2.1 })).toEqual({
      keyword: 'led truck',
      searchVolume: 1300,
      competition: 0.42,
      cpc: 2.1,
    });
  });

  it('reads the doubly-nested shape related_keywords returns', () => {
    expect(
      toMetrics({ keyword_data: { keyword: 'led truck media', keyword_info: { search_volume: 110 } } })
    ).toEqual({ keyword: 'led truck media', searchVolume: 110, competition: null, cpc: null });
  });

  it('reads the nested shape the Labs endpoints return', () => {
    expect(toMetrics({ keyword: 'mobile billboard', keyword_info: { search_volume: 720 } })).toEqual({
      keyword: 'mobile billboard',
      searchVolume: 720,
      competition: null,
      cpc: null,
    });
  });

  it('keeps a missing number missing instead of inventing a zero', () => {
    // A fabricated volume silently decides which articles get written.
    const metrics = toMetrics({ keyword: 'obscure phrase' });
    expect(metrics?.searchVolume).toBeNull();
    expect(metrics?.competition).toBeNull();
  });

  it('is null for a row with no keyword', () => {
    expect(toMetrics({ search_volume: 100 })).toBeNull();
    expect(toMetrics(null)).toBeNull();
  });
});

describe('response unwrapping', () => {
  it('reads tasks[].result[]', () => {
    expect(
      extractResults({ tasks: [{ result: [{ keyword: 'a' }, { keyword: 'b' }] }] })
    ).toHaveLength(2);
  });

  it('reads the extra items[] level the Labs endpoints add', () => {
    const rows = extractResults({
      tasks: [{ result: [{ items: [{ keyword: 'a' }, { keyword: 'b' }] }] }],
    });
    expect(rows).toHaveLength(2);
  });

  it('returns nothing rather than throwing on an error payload', () => {
    expect(extractResults({ status_code: 40401 })).toEqual([]);
    expect(extractResults(null)).toEqual([]);
    expect(extractResults({ tasks: [{ result: null }] })).toEqual([]);
  });
});

describe('batching', () => {
  it('splits at the provider limit', () => {
    const keywords = Array.from({ length: 2500 }, (_, i) => `kw ${i}`);
    const batches = chunk(keywords, MAX_KEYWORDS_PER_TASK);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
  });

  it('sends more than one task when asked for more than the limit', async () => {
    const calls: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ tasks: [{ result: [] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new DataForSeoProvider(config, { fetchImpl });
    await provider.metricsFor(Array.from({ length: 1500 }, (_, i) => `kw ${i}`));
    expect(calls).toHaveLength(2);
  });

  it('deduplicates and lowercases before spending a request on them', async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ tasks: [{ result: [] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await new DataForSeoProvider(config, { fetchImpl }).metricsFor([
      'LED truck',
      'led truck',
      '  led truck  ',
      '',
    ]);
    expect(body[0].keywords).toEqual(['led truck']);
  });

  it('spends nothing on an empty list', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await new DataForSeoProvider(config, { fetchImpl }).metricsFor([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('idea sourcing', () => {
  it('asks suggestions and related, never keyword_ideas', async () => {
    // keyword_ideas expands on individual words: "led truck advertising" comes
    // back with "led meaning" and "led drawing board". Measured, not assumed.
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify({ tasks: [{ result: [{ items: [] }] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await new DataForSeoProvider(config, { fetchImpl }).ideasFor('led truck advertising');
    expect(paths.some((p) => p.includes('keyword_suggestions'))).toBe(true);
    expect(paths.some((p) => p.includes('related_keywords'))).toBe(true);
    expect(paths.some((p) => p.includes('keyword_ideas'))).toBe(false);
  });

  it('merges both sources, suggestions first, without duplicates', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const items = url.includes('keyword_suggestions')
        ? [{ keyword: 'led advertising truck', keyword_info: { search_volume: 260 } }]
        : [
            { keyword_data: { keyword: 'led advertising truck', keyword_info: { search_volume: 260 } } },
            { keyword_data: { keyword: 'mobile billboard truck', keyword_info: { search_volume: 390 } } },
          ];
      return new Response(JSON.stringify({ tasks: [{ result: [{ items }] }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const merged = await new DataForSeoProvider(config, { fetchImpl }).ideasFor('led truck advertising');
    expect(merged.map((m) => m.keyword)).toEqual(['led advertising truck', 'mobile billboard truck']);
  });

  it('honours the limit across both sources', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tasks: [
            {
              result: [
                {
                  items: Array.from({ length: 50 }, (_, i) => ({
                    keyword: `phrase ${i}`,
                    keyword_info: { search_volume: i },
                  })),
                },
              ],
            },
          ],
        }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    expect(await new DataForSeoProvider(config, { fetchImpl }).ideasFor('seed', 10)).toHaveLength(10);
  });
});

describe('failure', () => {
  it('degrades to no metrics rather than throwing into the caller', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 402 })) as unknown as typeof fetch;
    expect(await new DataForSeoProvider(config, { fetchImpl }).metricsFor(['a'])).toEqual([]);
  });

  it('sends basic auth', async () => {
    let auth = '';
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      auth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await new DataForSeoProvider(config, { fetchImpl }).metricsFor(['a']);
    expect(auth).toBe(`Basic ${Buffer.from('l:p').toString('base64')}`);
  });
});
