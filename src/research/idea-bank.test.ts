import { describe, it, expect } from 'vitest';

import {
  planIdeas,
  dedupeKeyFor,
  articleTypeFor,
  fallbackTitle,
  coverageMonths,
  type ClusterInput,
} from './idea-bank.js';

function cluster(slug: string, keywords: [string, number | null][]): ClusterInput {
  return {
    slug,
    name: slug,
    keywords: keywords.map(([keyword, searchVolume]) => ({
      keyword,
      searchVolume,
      competition: null,
      cpc: null,
    })),
  };
}

describe('deduplication', () => {
  it('treats the same phrase written differently as one idea', () => {
    expect(dedupeKeyFor('LED Truck Advertising')).toBe(dedupeKeyFor('  led   truck advertising  '));
    expect(dedupeKeyFor('mobile billboards')).toBe(dedupeKeyFor('mobile billboard'));
    expect(dedupeKeyFor('led-truck, advertising')).toBe(dedupeKeyFor('led truck advertising'));
  });

  it('treats word order as the same idea, because the article would be', () => {
    expect(dedupeKeyFor('advertising truck led')).toBe(dedupeKeyFor('led truck advertising'));
  });

  it('keeps genuinely different phrases apart', () => {
    expect(dedupeKeyFor('led truck cost')).not.toBe(dedupeKeyFor('led truck rental'));
  });
});

describe('article type', () => {
  it('reads the intent out of the phrase the searcher typed', () => {
    expect(articleTypeFor('how to rent an led truck')).toBe('how-to-writer');
    expect(articleTypeFor('best mobile billboard companies')).toBe('listicle-writer');
    expect(articleTypeFor('led truck vs static billboard')).toBe('reviewer');
    expect(articleTypeFor('led truck advertising cost')).toBe('analyst');
    expect(articleTypeFor('outdoor advertising trends 2026')).toBe('trends-writer');
    expect(articleTypeFor('what is a mobile billboard')).toBe('deep-dive-researcher');
  });

  it('falls back to reporting when the phrase states no intent', () => {
    expect(articleTypeFor('led truck lisbon')).toBe('news-reporter');
  });
});

describe('fallback titles', () => {
  it('does not produce "How to how to"', () => {
    expect(fallbackTitle('how to rent an led truck', 'how-to-writer')).toBe(
      'How to rent an led truck'
    );
  });

  it('gives every type a readable line', () => {
    expect(fallbackTitle('led truck cost', 'analyst')).toBe('Led truck cost: what the numbers say');
  });
});

describe('planning', () => {
  const clusters = [
    cluster('trucks', [
      ['led truck advertising', 5000],
      ['led truck rental', 800],
      ['led truck cost', 200],
    ]),
    cluster('billboards', [
      ['mobile billboard advertising', 3000],
      ['mobile billboard rental', 400],
    ]),
  ];

  it('stops at the requested size', () => {
    expect(planIdeas(clusters, { target: 3 })).toHaveLength(3);
  });

  it('spreads across clusters rather than draining one first', () => {
    // A bank cut short must still cover the topic space.
    const plan = planIdeas(clusters, { target: 2 });
    expect(new Set(plan.map((i) => i.cluster)).size).toBe(2);
  });

  it('makes the first idea of each cluster its pillar and writes it first', () => {
    const plan = planIdeas(clusters, { target: 5 });
    const pillars = plan.filter((i) => i.isPillar);
    expect(pillars.map((p) => p.cluster).sort()).toEqual(['billboards', 'trucks']);
    // Everything in a cluster links back to its pillar, so the pillar cannot be
    // written last — the links would point at nothing.
    const firstNonPillar = plan.findIndex((i) => !i.isPillar);
    expect(plan.slice(0, firstNonPillar).every((i) => i.isPillar)).toBe(true);
  });

  it('ranks by real search volume when there is one', () => {
    const plan = planIdeas([clusters[0]], { target: 3, pillarsPerCluster: 0 });
    expect(plan.map((i) => i.targetKeyword)).toEqual([
      'led truck advertising',
      'led truck rental',
      'led truck cost',
    ]);
  });

  it('keeps the evidence order when no provider supplied volume', () => {
    const noVolume = cluster('trucks', [
      ['first by evidence', null],
      ['second by evidence', null],
      ['third by evidence', null],
    ]);
    const plan = planIdeas([noVolume], { target: 3, pillarsPerCluster: 0 });
    expect(plan.map((i) => i.targetKeyword)).toEqual([
      'first by evidence',
      'second by evidence',
      'third by evidence',
    ]);
    expect(plan.every((i) => i.searchVolume === null)).toBe(true);
  });

  it('never plans the same phrase twice, across clusters or spellings', () => {
    const overlapping = [
      cluster('a', [['mobile billboards', 100]]),
      cluster('b', [['mobile billboard', 100]]),
    ];
    expect(planIdeas(overlapping, { target: 10 })).toHaveLength(1);
  });

  it('tops an existing bank up instead of doubling it', () => {
    const existing = [dedupeKeyFor('led truck advertising')];
    const plan = planIdeas(clusters, { target: 10, existingKeys: existing });
    expect(plan.map((i) => i.targetKeyword)).not.toContain('led truck advertising');
  });

  it('returns what it has when the clusters run dry before the target', () => {
    // Asking for 1,200 ideas from a narrow niche must yield the honest number,
    // not padding.
    const plan = planIdeas(clusters, { target: 1200 });
    expect(plan).toHaveLength(5);
  });

  it('plans nothing for a zero target or empty clusters', () => {
    expect(planIdeas(clusters, { target: 0 })).toEqual([]);
    expect(planIdeas([], { target: 10 })).toEqual([]);
    expect(planIdeas([cluster('empty', [])], { target: 10 })).toEqual([]);
  });
});

describe('competition-aware ranking', () => {
  it('is order-identical to the volume ranking when no competition data exists', () => {
    // Regression: competition undefined AND per-keyword competition null must
    // reproduce today's order exactly.
    const plain = [
      cluster('trucks', [
        ['led truck advertising', 5000],
        ['led truck rental', 800],
        ['led truck cost', 200],
      ]),
    ];
    const plan = planIdeas(plain, { target: 3, pillarsPerCluster: 0 });
    expect(plan.map((i) => i.targetKeyword)).toEqual([
      'led truck advertising',
      'led truck rental',
      'led truck cost',
    ]);
    expect(plan.every((i) => i.evidence.saturation === undefined)).toBe(true);
    expect(plan.every((i) => i.evidence.competitionMultiplier === undefined)).toBe(true);
  });

  it('demotes a saturated head-term below a long-tail variant with meaningfully lower volume', () => {
    // saturation = 6/10 = 0.6 >= 0.5, distinctHosts 9 >= 8: the two-word head
    // term is multiplied by (1 - 0.5 * 0.6) = 0.7; the five-word long tail is
    // untouched. log10(5001)*1000*0.7 ≈ 2589 < log10(801)*1000 ≈ 2904.
    const saturated: ClusterInput = {
      ...cluster('screens', [
        ['led screens', 5000],
        ['mobile led screen rental price', 800],
      ]),
      competition: { distinctHosts: 9, topHostShare: 0.2, exactTitleMatches: 6, sampleSize: 10 },
    };
    const plan = planIdeas([saturated], { target: 2, pillarsPerCluster: 0 });
    expect(plan.map((i) => i.targetKeyword)).toEqual([
      'mobile led screen rental price',
      'led screens',
    ]);
    const head = plan.find((i) => i.targetKeyword === 'led screens')!;
    expect(head.evidence.saturation).toBeCloseTo(0.6, 5);
    const tail = plan.find((i) => i.targetKeyword === 'mobile led screen rental price')!;
    expect(tail.evidence.saturation).toBeUndefined();
  });

  it('leaves head-terms alone below the saturation and host thresholds', () => {
    const mild: ClusterInput = {
      ...cluster('screens', [
        ['led screens', 5000],
        ['mobile led screen rental price', 800],
      ]),
      // saturation 0.4 < 0.5 — not the SERP everyone already answers verbatim.
      competition: { distinctHosts: 9, topHostShare: 0.2, exactTitleMatches: 4, sampleSize: 10 },
    };
    const plan = planIdeas([mild], { target: 2, pillarsPerCluster: 0 });
    expect(plan[0].targetKeyword).toBe('led screens');
    expect(plan[0].evidence.saturation).toBeUndefined();
  });

  it('demotes advertiser-contested phrases: same volume, competition 0.9 ranks below null', () => {
    const contested: ClusterInput = {
      slug: 'ads',
      name: 'ads',
      keywords: [
        { keyword: 'billboard ads pricing', searchVolume: 1000, competition: 0.9, cpc: null },
        { keyword: 'billboard ads schedule', searchVolume: 1000, competition: null, cpc: null },
      ],
    };
    const plan = planIdeas([contested], { target: 2, pillarsPerCluster: 0 });
    expect(plan.map((i) => i.targetKeyword)).toEqual([
      'billboard ads schedule',
      'billboard ads pricing',
    ]);
    const demoted = plan.find((i) => i.targetKeyword === 'billboard ads pricing')!;
    expect(demoted.evidence.competitionMultiplier).toBeCloseTo(1 - 0.3 * 0.9, 5);
    const untouched = plan.find((i) => i.targetKeyword === 'billboard ads schedule')!;
    expect(untouched.evidence.competitionMultiplier).toBeUndefined();
  });

  it('records the applied multipliers in evidence so the plan stays inspectable', () => {
    const saturated: ClusterInput = {
      ...cluster('screens', [['led screens', 5000]]),
      competition: { distinctHosts: 9, topHostShare: 0.2, exactTitleMatches: 6, sampleSize: 10 },
    };
    const plan = planIdeas([saturated], { target: 1, pillarsPerCluster: 0 });
    expect(plan[0].evidence.saturation).toBeCloseTo(0.6, 5);
    expect(plan[0].evidence.saturationMultiplier).toBeCloseTo(0.7, 5);
  });

  it('ignores an empty competition sample rather than dividing by zero', () => {
    const empty: ClusterInput = {
      ...cluster('screens', [['led screens', 5000]]),
      competition: { distinctHosts: 0, topHostShare: 0, exactTitleMatches: 0, sampleSize: 0 },
    };
    const plan = planIdeas([empty], { target: 1, pillarsPerCluster: 0 });
    expect(plan[0].evidence.saturation).toBeUndefined();
  });
});

describe('coverage', () => {
  it('says how long a bank lasts at the customer plan', () => {
    expect(coverageMonths(1200, 100)).toBe(12);
    expect(coverageMonths(450, 100)).toBe(4.5);
    expect(coverageMonths(1200, 0)).toBe(0);
  });
});
