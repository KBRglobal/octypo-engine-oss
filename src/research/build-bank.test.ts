import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {} }));
vi.mock('./bank-store.js', () => ({
  existingDedupeKeys: vi.fn(async () => new Set<string>()),
  storeIdeas: vi.fn(async () => ({ inserted: 0, skipped: 0 })),
}));
const stubLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../lib/logger.js', () => ({
  logger: stubLogger,
  log: stubLogger,
  createLogger: () => stubLogger,
}));

const { clusterKeywords, buildIdeaBank } = await import('./build-bank.js');
const { briefFor } = await import('./idea-writer.js');

const topic = {
  slug: 'trucks',
  name: 'Trucks',
  keywords: ['led truck advertising', 'led truck rental'],
  evidence: {
    query: 'led truck advertising',
    competition: { distinctHosts: 5, topHostShare: 0.2, exactTitleMatches: 2, sampleSize: 10 },
    topHosts: ['a.test'],
  },
};

describe('cluster keywords', () => {
  it('uses only search evidence when there is no provider', async () => {
    const keywords = await clusterKeywords(topic, null, 10);
    expect(keywords.map((k) => k.keyword)).toEqual(topic.keywords);
    // Nothing invents a volume it was not given.
    expect(keywords.every((k) => k.searchVolume === null)).toBe(true);
  });

  it('puts the provider ideas first and measures what it missed', async () => {
    const provider = {
      ideasFor: vi.fn(async () => [
        { keyword: 'led billboard truck', searchVolume: 900, competition: null, cpc: null },
      ]),
      metricsFor: vi.fn(async (keywords: string[]) =>
        keywords.map((keyword) => ({ keyword, searchVolume: 100, competition: null, cpc: null }))
      ),
    };

    const keywords = await clusterKeywords(topic, provider, 10);
    expect(keywords[0].keyword).toBe('led billboard truck');
    // The search-derived phrases came back with a real volume attached.
    expect(keywords.find((k) => k.keyword === 'led truck rental')?.searchVolume).toBe(100);
    // One batched call, not one per phrase.
    expect(provider.metricsFor).toHaveBeenCalledTimes(1);
  });

  it('respects the per-cluster cap', async () => {
    expect(await clusterKeywords(topic, null, 1)).toHaveLength(1);
  });
});

describe('building a bank', () => {
  const search = {
    search: vi.fn(async () => [
      { host: 'a.test', title: 'Mobile billboard advertising rates', description: '', url: 'https://a.test/1' },
      { host: 'b.test', title: 'Mobile billboard advertising rates explained', description: '', url: 'https://b.test/2' },
      { host: 'c.test', title: 'Comparing mobile billboard advertising rates', description: '', url: 'https://c.test/3' },
    ]),
  };

  it('reports the honest number when the niche runs out', async () => {
    // Asking for 1,200 from one thin cluster must not be padded with
    // near-duplicates; the caller needs to know to add seeds.
    const result = await buildIdeaBank(
      { seeds: ['mobile billboard advertising'], target: 1200, persist: false },
      { search, provider: null }
    );
    expect(result.requested).toBe(1200);
    expect(result.produced).toBeLessThan(1200);
    expect(result.produced).toBe(result.ideas.length);
  });

  it('reports coverage against the plan the customer bought', async () => {
    const result = await buildIdeaBank(
      { seeds: ['mobile billboard advertising'], target: 2, articlesPerMonth: 1, persist: false },
      { search, provider: null }
    );
    expect(result.coverageMonths).toBe(result.produced / 1);
  });

  it('says whether a keyword provider was actually used', async () => {
    const result = await buildIdeaBank(
      { seeds: ['mobile billboard advertising'], target: 2, persist: false },
      { search, provider: null }
    );
    expect(result.usedKeywordProvider).toBe(false);
  });

  it('threads the topic SERP competition signal into the planned ideas', async () => {
    // Every result title states the seed verbatim across 3+ distinct hosts —
    // with 8+ hosts the head term would be demoted; here we only prove the
    // signal reaches planIdeas by checking it was computed and attached.
    const result = await buildIdeaBank(
      { seeds: ['mobile billboard advertising'], target: 2, persist: false },
      { search, provider: null }
    );
    expect(result.topics[0].evidence.competition.sampleSize).toBeGreaterThan(0);
    // The plan came from clusters that carried the competition signal — the
    // wiring is what this asserts (behavioral demotion is unit-tested in
    // idea-bank.test.ts with concrete numbers).
    expect(result.ideas.length).toBeGreaterThan(0);
  });

  it('refuses to run with no search client rather than returning an empty plan', async () => {
    await expect(
      buildIdeaBank({ seeds: ['x'], target: 10, persist: false }, { search: null, provider: null })
    ).rejects.toThrow(/BRAVE_API_KEY/);
  });
});

describe('the brief handed to the writer', () => {
  it('always names the phrase the article must answer', () => {
    const brief = briefFor({ targetKeyword: 'led truck cost', cluster: 'trucks', isPillar: false });
    expect(brief).toContain('led truck cost');
    expect(brief).toContain('supporting article');
  });

  it('tells a pillar that the cluster links back to it', () => {
    const brief = briefFor({ targetKeyword: 'led trucks', cluster: 'trucks', isPillar: true });
    expect(brief).toContain('pillar');
    expect(brief).toContain('link back');
  });

  it('never asks for repetition to hit a quota', () => {
    const brief = briefFor({ targetKeyword: 'x', cluster: null, isPillar: false });
    expect(brief).toContain('never repeated to hit a quota');
  });
});
