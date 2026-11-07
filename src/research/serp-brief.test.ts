import { describe, it, expect, vi, beforeEach } from 'vitest';

// The db mock is a tiny chainable select/insert recorder: enough to feed
// clusterQueries and capture the upsert without a real database.
const state: {
  ideas: { keyword: string | null }[];
  briefs: { brief: string }[];
  inserted: unknown[];
} = { ideas: [], briefs: [], inserted: [] };

vi.mock('../db.js', () => {
  const selectChain = (rows: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) {
      chain[m] = () => chain;
    }
    chain.limit = async () => rows();
    // selectDistinct().from().where() resolves without limit — make the chain
    // thenable so awaiting it yields the rows.
    chain.then = (resolve: (v: unknown) => void) => resolve(rows());
    return chain;
  };
  return {
    db: {
      select: () => selectChain(() => (state.ideas.length ? state.ideas : state.briefs)),
      selectDistinct: () => selectChain(() => state.ideas),
      insert: () => ({
        values: (v: unknown) => ({
          onConflictDoUpdate: async () => {
            state.inserted.push(v);
          },
        }),
      }),
    },
  };
});

const stubLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../lib/logger.js', () => ({
  logger: stubLogger,
  log: stubLogger,
  createLogger: () => stubLogger,
}));

vi.mock('../services/engine-registry.js', () => ({
  EngineRegistry: {
    getFastEngine: () => ({ id: 'fast' }),
    getNextFromQueue: () => ({ id: 'fallback' }),
  },
  generateWithEngine: vi.fn(async () => 'Topics every competitor covers:\n- price'),
}));

const { buildSerpBrief } = await import('./serp-brief.js');

beforeEach(() => {
  state.ideas = [];
  state.briefs = [];
  state.inserted = [];
});

describe('buildSerpBrief', () => {
  it('returns null without a search client — the capability was not bought', async () => {
    const result = await buildSerpBrief('led', { search: null });
    expect(result).toBeNull();
  });

  it('returns null when the bank has no queries for the cluster', async () => {
    const search = { search: vi.fn(async () => []) };
    const result = await buildSerpBrief('led', { search });
    expect(result).toBeNull();
    expect(search.search).not.toHaveBeenCalled();
  });

  it('searches each distinct query once and stores the distilled brief', async () => {
    state.ideas = [
      { keyword: 'event projector' },
      { keyword: 'event projector' },
      { keyword: 'projector rental' },
    ];
    const search = {
      search: vi.fn(async () => [
        { title: 'Title', url: 'https://a.test', description: 'Description', host: 'a.test' },
      ]),
    };
    const result = await buildSerpBrief('led', { search });
    expect(result).not.toBeNull();
    expect(result!.queries).toEqual(['event projector', 'projector rental']);
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(state.inserted).toHaveLength(1);
    expect(result!.brief).toContain('competitor');
  });

  it('survives a failing query and still distills the rest', async () => {
    state.ideas = [{ keyword: 'a' }, { keyword: 'b' }];
    const search = {
      search: vi
        .fn()
        // Query a fails with the country filter and again without it.
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValueOnce([
          { title: 't', url: 'https://a.test', description: 'd', host: 'a.test' },
        ]),
    };
    const result = await buildSerpBrief('led', { search });
    expect(result).not.toBeNull();
    expect(search.search).toHaveBeenCalledTimes(3);
  });

  it('returns null when every search comes back empty', async () => {
    state.ideas = [{ keyword: 'a' }];
    const search = { search: vi.fn(async () => []) };
    const result = await buildSerpBrief('led', { search });
    expect(result).toBeNull();
    expect(state.inserted).toHaveLength(0);
  });
});

describe('SERP language follows the cluster locale (LANG-04)', () => {
  const enUS = { language: 'en', country: 'US', languageName: 'English', isDefault: false };
  const result = [{ title: 't', url: 'https://a.test', description: 'd', host: 'a.test' }];

  it('a default cluster searches in English with the country hint', async () => {
    state.ideas = [{ keyword: 'event projector' }];
    const search = { search: vi.fn(async () => result) };
    await buildSerpBrief('led', { search });
    expect(search.search).toHaveBeenCalledWith('event projector', { count: 10, lang: 'en', country: 'US' });
  });

  it('an en/US cluster searches in English with the country hint', async () => {
    state.ideas = [{ keyword: 'event projector rental' }];
    const search = { search: vi.fn(async () => result) };
    await buildSerpBrief('led', { search, locale: enUS });
    expect(search.search).toHaveBeenCalledWith('event projector rental', {
      count: 10,
      lang: 'en',
      country: 'US',
    });
  });

  it('a Japanese cluster searches in its own language and country', async () => {
    state.ideas = [{ keyword: 'プロジェクター レンタル' }];
    const search = { search: vi.fn(async () => result) };
    const jaJP = { language: 'ja', country: 'JP', languageName: 'Japanese', isDefault: false };
    await buildSerpBrief('led', { search, locale: jaJP });
    expect(search.search).toHaveBeenCalledWith('プロジェクター レンタル', { count: 10, lang: 'ja', country: 'JP' });
  });

  it('retries once WITHOUT the country when results come back empty with it (Brave 422 lesson)', async () => {
    state.ideas = [{ keyword: 'led screen' }];
    const search = {
      search: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(result),
    };
    const out = await buildSerpBrief('led', { search, locale: enUS });
    expect(out).not.toBeNull();
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(search.search).toHaveBeenNthCalledWith(2, 'led screen', { count: 10, lang: 'en' });
  });

  it('retries once WITHOUT the country when the country filter is rejected outright (Brave 422)', async () => {
    state.ideas = [{ keyword: 'led screen' }];
    const search = {
      search: vi.fn().mockRejectedValueOnce(new Error('422')).mockResolvedValueOnce(result),
    };
    const out = await buildSerpBrief('led', { search, locale: enUS });
    expect(out).not.toBeNull();
    expect(search.search).toHaveBeenCalledTimes(2);
    expect(search.search).toHaveBeenNthCalledWith(2, 'led screen', { count: 10, lang: 'en' });
  });

  it('labels each query for the distiller in English, whatever the cluster language', async () => {
    const { generateWithEngine } = await import('../services/engine-registry.js');
    state.ideas = [{ keyword: 'プロジェクター' }];
    const search = { search: vi.fn(async () => result) };
    const jaJP = { language: 'ja', country: 'JP', languageName: 'Japanese', isDefault: false };
    await buildSerpBrief('led', { search, locale: jaJP });
    expect(vi.mocked(generateWithEngine).mock.lastCall?.[2]).toContain('Query: プロジェクター');
  });
});

describe('the zero-cost path', () => {
  it('builds a paste-ready prompt from the cluster queries', async () => {
    state.ideas = [{ keyword: 'event projector' }, { keyword: 'projector rental' }];
    const { serpBriefPrompt } = await import('./serp-brief.js');
    const result = await serpBriefPrompt('led');
    expect(result).not.toBeNull();
    expect(result!.prompt).toContain('event projector');
    expect(result!.prompt).toContain('Gaps and opportunities');
  });

  it('returns null when the cluster has no queries', async () => {
    const { serpBriefPrompt } = await import('./serp-brief.js');
    expect(await serpBriefPrompt('empty')).toBeNull();
  });

  it('stores a pasted brief', async () => {
    const { storePastedBrief } = await import('./serp-brief.js');
    await storePastedBrief('led', 'A brief pasted from the owner subscription');
    expect(state.inserted).toHaveLength(1);
  });
});
