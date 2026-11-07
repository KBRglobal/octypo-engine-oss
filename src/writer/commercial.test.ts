import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildInputBlock, parseCommercialArticle, auditNumbers, auditSuperlatives, auditLinks, numbersIn, commercialSystemPrompt } =
  await import('./commercial.js');
const { packFor } = await import('../i18n/language-pack.js');

const input = {
  host: 'example.com',
  buyerQuery: 'How much does it cost to rent a projector for an event?',
  uniqueFact: 'The units are autonomous. A projection day costs 2,500 to 4,000 dollars. Phone: 054-814-7767.',
  liveUrls: ['/insights/a/'],
};

describe('the prompt file', () => {
  it('ships the STOP contract and the output layout intact', () => {
    const prompt = commercialSystemPrompt();
    expect(prompt).toContain('STOP:');
    expect(prompt).toContain('facts_used');
    expect(prompt).toContain('Do not invent data');
  });
});

describe('input block', () => {
  it('renders every field the contract requires, empty lists included', () => {
    const block = buildInputBlock(input);
    for (const field of ['host:', 'buyer_query:', 'unique_fact:', 'forbidden:', 'live_urls:', 'sister_hosts:', 'external_sources:']) {
      expect(block).toContain(field);
    }
    expect(block).toContain('forbidden: []');
  });
});

describe('parsing the fixed output layout', () => {
  const sample = `title: Renting a projector for an event — what sets the price
meta: What an event projector costs and what affects the price.
slug: event-projector-price
h1: How much does it cost to rent a projector for an event?
body: A projection day runs between 2,500 and 4,000 dollars.

## What affects the price
The units are autonomous, so there is no dependence on mains power.
internal_links: ["/insights/a/"]
facts_used:
- A projection day: 2,500 to 4,000 dollars
sources_used: []`;

  it('reads every field', () => {
    const article = parseCommercialArticle(sample)!;
    expect(article.title).toContain('Renting a projector');
    expect(article.slug).toBe('event-projector-price');
    expect(article.body).toContain('## What affects the price');
    expect(article.internalLinks).toEqual(['/insights/a/']);
    expect(article.factsUsed).toHaveLength(1);
    expect(article.sourcesUsed).toEqual([]);
  });

  it('reads non-Latin field values under the English labels', () => {
    const article = parseCommercialArticle('title: 料金\nmeta: 説明\nslug: 料金-案内\nh1: 料金案内\nbody: 本文です。')!;
    expect(article.title).toBe('料金');
    expect(article.slug).toBe('料金-案内');
    expect(article.body).toBe('本文です。');
  });

  it('treats STOP as missing input, not as an article', () => {
    expect(parseCommercialArticle('STOP: [unique_fact]')).toBeNull();
  });

  it('rejects a response that dropped the contract', () => {
    expect(parseCommercialArticle('Just free text with no fields')).toBeNull();
  });

  it('does not let a "meta:" inside the body overwrite the real meta', () => {
    const tricky = sample.replace('no dependence on mains power.', 'no dependence on mains power.\nmeta: forged');
    expect(parseCommercialArticle(tricky)!.meta).not.toBe('forged');
  });

  it('tolerates markdown-bold field labels', () => {
    const bolded = sample.replace('title:', '**title:**').replace('body:', '**body:**');
    expect(parseCommercialArticle(bolded)).not.toBeNull();
  });
});

describe('the number audit', () => {
  const article = (body: string) =>
    ({ title: 'T', meta: '', slug: 's', h1: 'H', body, internalLinks: [], factsUsed: [], sourcesUsed: [] });

  it('extracts and normalises numbers', () => {
    expect(numbersIn('between 2,500 and 4,000 dollars')).toEqual(['2500', '4000']);
  });

  it('accepts an article whose numbers all came from the input', () => {
    const audit = auditNumbers(article('The cost runs between 2,500 and 4,000 dollars. Call 054-814-7767.'), input);
    expect(audit.ok).toBe(true);
  });

  it('flags an invented price — the exact failure the blind round exposed', () => {
    const audit = auditNumbers(article('A night surcharge of 800 dollars and a travel surcharge of 650 dollars.'), input);
    expect(audit.ok).toBe(false);
    expect(audit.unsupported).toEqual(expect.arrayContaining(['800', '650']));
  });

  it('does not flag years or small structural numbers', () => {
    const audit = auditNumbers(article(`As of ${new Date().getFullYear()}, three stages and 8 working hours.`), input);
    expect(audit.ok).toBe(true);
  });

  it('notices vague quantities when the input held no numbers at all', () => {
    const bare = { ...input, uniqueFact: 'The units are autonomous.', buyerQuery: 'What is a projector?' };
    const audit = auditNumbers(article('The cost can reach thousands of dollars.'), bare);
    expect(audit.vagueQuantities).toBe(true);
  });

  it('reads native digits, so an invented Arabic price cannot slip past the gate', () => {
    expect(numbersIn('٢٬٥٠٠ دولار')).toEqual(['2500']);
    expect(numbersIn('٢٫٥ متر')).toEqual(['2.5']);
    expect(numbersIn('۱۲۰۰ تومان')).toEqual(['1200']);
    expect(numbersIn('२५०० रुपये')).toEqual(['2500']);

    const arabic = { host: 'x', buyerQuery: 'q', uniqueFact: 'التكلفة ٢٬٥٠٠ دولار' } as never;
    expect(auditNumbers(article('التكلفة 2,500 دولار.'), arabic, packFor('ar')).ok).toBe(true);
    const invented = auditNumbers(article('رسوم إضافية ٨٠٠ دولار.'), arabic, packFor('ar'));
    expect(invented.ok).toBe(false);
    expect(invented.unsupported).toContain('800');
  });
});

describe('the superlative audit', () => {
  const article = (body: string) =>
    ({ title: 'T', meta: 'M', h1: 'H', body }) as never;
  const bare = { uniqueFact: 'Facts with no boasts' } as never;

  it('does not flag a negated quantifier — "not always" is a hedge, not a boast', () => {
    expect(auditSuperlatives(article('The business cannot rely on existing infrastructure, not always.'), bare).ok).toBe(true);
  });

  it('still flags the bare quantifier', () => {
    expect(auditSuperlatives(article('The team is always available, at every hour.'), bare).found).toContain('always');
  });

  it('flags when an unhedged occurrence exists alongside a hedged one', () => {
    expect(auditSuperlatives(article('It is not always easy, but we always deliver.'), bare).found).toContain('always');
  });

  it('allows a superlative the facts state literally', () => {
    const facts = { uniqueFact: 'the screen is always bright even in daylight' } as never;
    expect(auditSuperlatives(article('The screen is always bright even in daylight.'), facts).ok).toBe(true);
  });
});

describe('missing body label recovery', () => {
  it('splits an unlabeled body out of the h1 field', () => {
    const body = 'A first paragraph with a complete answer for the buyer. '.repeat(12);
    const raw = [
      'title: Title',
      'meta: Description',
      'slug: article-title',
      'h1: Main title',
      '',
      body,
      'internal_links: []',
      'facts_used: A fact',
      'sources_used: —',
    ].join('\n');
    const article = parseCommercialArticle(raw);
    expect(article).not.toBeNull();
    expect(article!.h1).toBe('Main title');
    expect(article!.body).toContain('A first paragraph');
  });

  it('still fails when there is no body at all', () => {
    const raw = 'title: T\nmeta: M\nslug: S\nh1: Title\ninternal_links: []';
    expect(parseCommercialArticle(raw)).toBeNull();
  });
});

describe('numeric-format normalization (LANG-06)', () => {
  it('keeps the historical thousands behavior: separator + exactly 3 digits is grouping', () => {
    expect(numbersIn('from 2,500 to 4,000')).toEqual(['2500', '4000']);
    expect(numbersIn('1,500')).toEqual(['1500']);
  });

  it('a separator NOT followed by exactly 3 digits is a decimal, normalized to a dot', () => {
    expect(numbersIn('2,5 Meter hoch')).toEqual(['2.5']);
    expect(numbersIn('pi is 3.14')).toEqual(['3.14']);
    expect(numbersIn('99,95 Euro')).toEqual(['99.95']);
  });

  it('European dot-grouping collapses: 1.234.567 → 1234567, 2.500 → 2500', () => {
    expect(numbersIn('1.234.567 Zuschauer')).toEqual(['1234567']);
    expect(numbersIn('ab 2.500 Euro pro Tag')).toEqual(['2500']);
  });

  it('mixed US format survives: 1,234.56 → 1234.56', () => {
    expect(numbersIn('$1,234.56 total')).toEqual(['1234.56']);
  });

  it('identical fact and article formats always still match each other', () => {
    const article = (body: string) =>
      ({ title: 'T', meta: '', slug: 's', h1: 'H', body, internalLinks: [], factsUsed: [], sourcesUsed: [] });
    const germanInput = {
      host: 'x.de', buyerQuery: 'led wand mieten preis',
      uniqueFact: 'Ein voller Projektionstag kostet 2.500 bis 4.000 Euro. Bis zu 1.234.567 Kontakte.',
    } as never;
    const audit = auditNumbers(
      article('Ein Tag kostet 2.500 bis 4.000 Euro — bis zu 1.234.567 Kontakte.'),
      germanInput
    );
    expect(audit.ok).toBe(true);
    // And the equivalent comma-decimal phrasing of an unrelated number still fails.
    const bad = auditNumbers(article('Zuschlag von 850,50 Euro.'), germanInput);
    expect(bad.ok).toBe(false);
    expect(bad.unsupported).toContain('850.5');
  });
});

describe('language-aware gates (LANG-03)', () => {
  const article = (body: string) =>
    ({ title: 'T', meta: 'M', slug: 's', h1: 'H', body, internalLinks: [], factsUsed: [], sourcesUsed: [] });
  const bare = { host: 'x', buyerQuery: 'q', uniqueFact: 'plain facts, no boasts' } as never;

  it('en articles are audited with the English superlative list', () => {
    const audit = auditSuperlatives(
      article('We are simply the best choice, guaranteed to work everywhere.') as never,
      bare,
      packFor('en')
    );
    expect(audit.ok).toBe(false);
    expect(audit.found).toEqual(expect.arrayContaining(['the best', 'guaranteed', 'everywhere']));
  });

  it('English negation is a hedge — "not always" is not a boast', () => {
    const audit = auditSuperlatives(
      article('Setup is not always required on site.') as never,
      bare,
      packFor('en')
    );
    expect(audit.ok).toBe(true);
  });

  it('an English superlative the facts state literally is allowed', () => {
    const facts = { host: 'x', buyerQuery: 'q', uniqueFact: 'Rated the best in the 2025 survey' } as never;
    const audit = auditSuperlatives(article('Rated the best in the 2025 survey.') as never, facts, packFor('en'));
    expect(audit.ok).toBe(true);
  });

  it('an uncurated language reports an explicit skipped marker — never a false hold, never a silent pass', () => {
    const audit = auditSuperlatives(article('Einfach die beste Wahl, immer.') as never, bare, packFor('de'));
    expect(audit.ok).toBe(true);
    expect(audit.found).toEqual([]);
    expect(audit.skipped).toBe('no-superlative-list:de');
  });

  it('a non-Latin language skips the same way', () => {
    const audit = auditSuperlatives(article('最高の選択です。') as never, bare, packFor('ja'));
    expect(audit.ok).toBe(true);
    expect(audit.skipped).toBe('no-superlative-list:ja');
  });

  it('the default path is the en pack — same results with and without an explicit pack', () => {
    const enArticle = article('The team is always available.') as never;
    const implicit = auditSuperlatives(enArticle, bare);
    const explicit = auditSuperlatives(enArticle, bare, packFor('en'));
    expect(explicit).toEqual(implicit);
    expect(implicit.found).toContain('always');
    expect(implicit.skipped).toBeUndefined();
  });

  it('vague quantities dispatch per pack: en words fire, uncurated languages skip explicitly', () => {
    const noNumbers = { host: 'x', buyerQuery: 'q', uniqueFact: 'no digits here' } as never;
    const en = auditNumbers(article('It can cost thousands of dollars.'), noNumbers, packFor('en'));
    expect(en.vagueQuantities).toBe(true);
    const de = auditNumbers(article('Es kostet Tausende von Euro.'), noNumbers, packFor('de'));
    expect(de.vagueQuantities).toBe(false);
    expect(de.skipped).toBe('no-vague-quantity-words:de');
    expect(en.skipped).toBeUndefined();
  });
});

describe('the link audit — generic anchors (SEO-G)', () => {
  const article = (body: string) =>
    ({ title: 'T', meta: 'M', slug: 's', h1: 'H', body, internalLinks: [], factsUsed: [], sourcesUsed: [] });
  const linkInput = { host: 'x', buyerQuery: 'q', uniqueFact: 'f', liveUrls: ['/guides/a/ — Guide A', '/guides/b/ — Guide B'] } as never;

  it('names a generic anchor in markdown form and fails the audit', () => {
    const audit = auditLinks(article('See [click here](/guides/a/) for the full service details.'), linkInput);
    expect(audit.genericAnchors).toEqual(['click here']);
    expect(audit.ok).toBe(false);
  });

  it('names a generic anchor in HTML form', () => {
    const audit = auditLinks(article('See <a href="/guides/a/">click here</a> for details.'), linkInput);
    expect(audit.genericAnchors).toEqual(['click here']);
    expect(audit.ok).toBe(false);
  });

  it('catches read more and bare here, case- and space-tolerant', () => {
    const audit = auditLinks(
      article('More: [Read More](/guides/a/) and also <a href="/guides/b/"> here </a>.'),
      linkInput
    );
    expect(audit.genericAnchors).toEqual(expect.arrayContaining(['read more', 'here']));
    expect(audit.ok).toBe(false);
  });

  it('accepts descriptive anchors — the negative case', () => {
    const audit = auditLinks(
      article('Read [the full guide to renting a projector](/guides/a/) before you book.'),
      linkInput
    );
    expect(audit.genericAnchors).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('accepts a descriptive non-Latin anchor', () => {
    const audit = auditLinks(article('[プロジェクターのレンタル案内](/guides/a/)'), linkInput);
    expect(audit.genericAnchors).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('does not flag descriptive anchors that merely contain a generic word', () => {
    const audit = auditLinks(article('See [here are all the prices](/guides/a/).'), linkInput);
    expect(audit.genericAnchors).toEqual([]);
  });
});

describe('bounded quantifiers', () => {
  const article = (body: string) =>
    ({ title: 'T', meta: 'M', h1: 'H', body }) as never;
  const bare = { uniqueFact: 'Facts with no boasts' } as never;

  it('allows a quantifier bounded by a restrictive clause', () => {
    expect(auditSuperlatives(article('We project at any location you choose for the event.'), bare).ok).toBe(true);
    expect(auditSuperlatives(article('Screening at every location that was picked.'), bare).ok).toBe(true);
  });

  it('still flags the unbounded quantifier', () => {
    expect(auditSuperlatives(article('Screening at every location in the country.'), bare).found).toContain('every location');
  });

  it('never lets a restrictive clause excuse a boast that is not a quantifier', () => {
    expect(auditSuperlatives(article('Simply the best you can get.'), bare).found).toContain('the best');
  });
});
