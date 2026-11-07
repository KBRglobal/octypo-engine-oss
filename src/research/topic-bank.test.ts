import { describe, it, expect, vi } from 'vitest';

import { buildTopicBank, assignKeywordsExclusively, slugify, toTopicsJson } from './topic-bank.js';
import type { SearchClient, SearchResult } from './brave.js';

function result(host: string, title: string, description = ''): SearchResult {
  return { host, title, description, url: `https://${host}/x` };
}

function clientReturning(byQuery: Record<string, SearchResult[]>): SearchClient {
  return { search: vi.fn(async (q: string) => byQuery[q] ?? []) };
}

describe('slugify', () => {
  it('produces a url-safe slug', () => {
    expect(slugify('LED Truck Advertising!')).toBe('led-truck-advertising');
  });

  it('collapses punctuation and repeated separators', () => {
    expect(slugify('  digital   signage / retail  ')).toBe('digital-signage-retail');
  });

  it('never ends on a separator, even when it had to be truncated', () => {
    expect(slugify('a'.repeat(60))).not.toMatch(/-$/);
  });
});

/**
 * Topics drive both the tag on an article and the per-topic daily limit. A
 * phrase claimed by two topics makes the tag arbitrary and both counts wrong.
 */
describe('exclusive keyword assignment', () => {
  it('gives a shared phrase to the topic that ranked it highest', () => {
    const assigned = assignKeywordsExclusively([
      { slug: 'trucks', keywords: [{ phrase: 'mobile billboard', score: 20 }] },
      { slug: 'billboards', keywords: [{ phrase: 'mobile billboard', score: 40 }] },
    ]);
    expect(assigned.get('billboards')).toContain('mobile billboard');
    expect(assigned.get('trucks')).toEqual([]);
  });

  it('breaks a tie in favour of the earlier seed', () => {
    const assigned = assignKeywordsExclusively([
      { slug: 'first', keywords: [{ phrase: 'shared phrase', score: 30 }] },
      { slug: 'second', keywords: [{ phrase: 'shared phrase', score: 30 }] },
    ]);
    expect(assigned.get('first')).toContain('shared phrase');
    expect(assigned.get('second')).toEqual([]);
  });

  it('lists every topic, including one that lost all its keywords', () => {
    const assigned = assignKeywordsExclusively([
      { slug: 'loser', keywords: [{ phrase: 'x y', score: 1 }] },
      { slug: 'winner', keywords: [{ phrase: 'x y', score: 2 }] },
    ]);
    expect([...assigned.keys()].sort()).toEqual(['loser', 'winner']);
  });
});

describe('topic bank', () => {
  const client = clientReturning({
    'mobile billboard advertising': [
      result('a.test', 'Mobile billboard advertising rates for local business'),
      result('b.test', 'Mobile billboard advertising rates explained'),
      result('c.test', 'How mobile billboard advertising rates compare'),
    ],
    'digital signage': [
      result('d.test', 'Digital signage software for retail stores'),
      result('e.test', 'Digital signage software buying guide', 'retail stores use digital signage software'),
      result('f.test', 'Choosing digital signage software'),
    ],
  });

  it('produces topics in the shape TOPICS_JSON expects', async () => {
    const bank = await buildTopicBank(client, {
      seeds: ['mobile billboard advertising', 'digital signage'],
    });
    expect(bank.map((t) => t.slug)).toEqual(['mobile-billboard-advertising', 'digital-signage']);
    for (const topic of bank) {
      expect(topic.name.length).toBeGreaterThan(0);
      expect(topic.keywords.length).toBeGreaterThan(0);
    }
  });

  it('always keeps the seed as a keyword of its own topic', async () => {
    const bank = await buildTopicBank(client, { seeds: ['digital signage'] });
    expect(bank[0].keywords).toContain('digital signage');
  });

  it('carries the evidence a human needs to disagree with it', async () => {
    const bank = await buildTopicBank(client, { seeds: ['digital signage'] });
    expect(bank[0].evidence.competition.sampleSize).toBe(3);
    expect(bank[0].evidence.topHosts.length).toBeGreaterThan(0);
  });

  it('drops duplicate and blank seeds instead of producing duplicate topics', async () => {
    const bank = await buildTopicBank(client, {
      seeds: ['digital signage', ' digital signage ', '', '   '],
    });
    expect(bank).toHaveLength(1);
  });

  it('survives a search that returned nothing', async () => {
    const bank = await buildTopicBank(clientReturning({}), { seeds: ['whatever'] });
    expect(bank).toHaveLength(1);
    expect(bank[0].keywords).toEqual(['whatever']);
    expect(bank[0].evidence.competition.sampleSize).toBe(0);
  });

  it('returns nothing for no seeds', async () => {
    expect(await buildTopicBank(client, { seeds: [] })).toEqual([]);
  });

  it('emits an environment value with the evidence stripped', async () => {
    const bank = await buildTopicBank(client, { seeds: ['digital signage'] });
    const parsed = JSON.parse(toTopicsJson(bank));
    expect(Object.keys(parsed[0]).sort()).toEqual(['keywords', 'name', 'slug']);
  });
});
