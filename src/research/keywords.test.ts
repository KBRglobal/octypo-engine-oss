import { describe, it, expect } from 'vitest';

import { extractKeywords, competitionSignal, tokenise } from './keywords.js';
import { stripHighlight, parseResults } from './brave.js';
import type { SearchResult } from './brave.js';

function result(host: string, title: string, description = ''): SearchResult {
  return { host, title, description, url: `https://${host}/x` };
}

describe('result parsing', () => {
  it('strips the markup Brave wraps matched terms in', () => {
    expect(stripHighlight('LED <strong>truck</strong> advertising &amp; media')).toBe(
      'LED truck advertising & media'
    );
  });

  it('drops results with no url or no title instead of emitting blanks', () => {
    const parsed = parseResults({
      web: {
        results: [
          { title: 'Good', url: 'https://a.test/1', description: 'd' },
          { title: '', url: 'https://b.test/2' },
          { url: 'https://c.test/3' },
          { title: 'No url' },
        ],
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].host).toBe('a.test');
  });

  it('returns nothing rather than throwing on an unexpected payload', () => {
    expect(parseResults(null)).toEqual([]);
    expect(parseResults({ error: 'quota' })).toEqual([]);
    expect(parseResults({ web: { results: 'nope' } })).toEqual([]);
  });
});

describe('keyword extraction', () => {
  const results = [
    result('a.test', 'Mobile billboard advertising for local business'),
    result('b.test', 'Why mobile billboard advertising works', 'mobile billboard advertising reaches drivers'),
    result('c.test', 'Mobile billboard advertising costs explained'),
    result('d.test', 'Acme Corp — the Acme Corp difference', 'Acme Corp is Acme Corp'),
  ];

  it('ranks by how many distinct hosts share the phrase', () => {
    const [top] = extractKeywords(results, { limit: 5 });
    expect(top.phrase).toBe('mobile billboard advertising');
    expect(top.hosts).toBe(3);
  });

  it('ignores a phrase only one site uses, however often it repeats it', () => {
    // Four occurrences on one host is that host's branding, not the market's wording.
    const phrases = extractKeywords(results, { limit: 50 }).map((c) => c.phrase);
    expect(phrases).not.toContain('acme corp');
  });

  it('never returns a phrase that starts or ends on a stopword', () => {
    for (const { phrase } of extractKeywords(results, { limit: 50 })) {
      expect(phrase).not.toMatch(/^(the|for|and|of|is|why) /);
      expect(phrase).not.toMatch(/ (the|for|and|of|is|why)$/);
    }
  });

  it('leaves out the seed it was searched on', () => {
    const phrases = extractKeywords(results, {
      limit: 50,
      exclude: ['mobile billboard advertising'],
    }).map((c) => c.phrase);
    expect(phrases).not.toContain('mobile billboard advertising');
  });

  it('returns nothing for no results rather than failing', () => {
    expect(extractKeywords([])).toEqual([]);
  });
});

describe('competition signal', () => {
  it('reports concentration when one site owns the page', () => {
    const owned = [
      result('big.test', 'A'),
      result('big.test', 'B'),
      result('big.test', 'C'),
      result('other.test', 'D'),
    ];
    const signal = competitionSignal('led truck', owned);
    expect(signal.distinctHosts).toBe(2);
    expect(signal.topHostShare).toBe(0.75);
  });

  it('counts titles that state the query verbatim', () => {
    const signal = competitionSignal('led truck advertising', [
      result('a.test', 'LED truck advertising in Lisbon'),
      result('b.test', 'Something unrelated'),
    ]);
    expect(signal.exactTitleMatches).toBe(1);
  });

  it('is safe on an empty result set', () => {
    expect(competitionSignal('anything', [])).toEqual({
      distinctHosts: 0,
      topHostShare: 0,
      exactTitleMatches: 0,
      sampleSize: 0,
    });
  });
});

describe('tokenisation', () => {
  it('keeps hyphens and apostrophes, drops the rest', () => {
    expect(tokenise("Don't miss: full-service advertising!")).toEqual([
      "don't",
      'miss',
      'full-service',
      'advertising',
    ]);
  });
});
