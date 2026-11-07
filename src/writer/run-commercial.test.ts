import { describe, it, expect, vi } from 'vitest';

const dbRows: { heroImage: string | null; cardImage: string | null }[] = [];
vi.mock('../db.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          limit: async () => dbRows,
        }),
      }),
    }),
  },
}));
vi.mock('../lib/logger.js', () => {
  const stub = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: stub, log: stub, createLogger: () => stub };
});

const {
  commoditySpanAudit,
  ctaAudit,
  vatQualifierAudit,
  ymylPromiseAudit,
  processLeakAudit,
  faqOverlapAudit,
  slugGate,
  firstSentences,
  buildSeoSchemaPayload,
  moneyUrlsFromEnv,
  moneyLiveUrls,
  buildMoneyLinkRider,
  inUseImageUrls,
  buildQualityRules,
  buildTableHint,
  buildFaqRequest,
} = await import('./run-commercial.js');
const { auditLinks } = await import('./commercial.js');
const { packFor, enPack } = await import('../i18n/language-pack.js');
import type { ContentBlock } from '../schema/index.js';
import type { CommercialArticle } from './commercial.js';

function article(overrides: Partial<CommercialArticle> = {}): CommercialArticle {
  return {
    title: 'Renting a projector for an event',
    meta: 'What an event projector costs and what the service includes.',
    slug: 'event-projector',
    h1: 'How much does it cost to rent a projector?',
    body: 'A mobile projector reaches each event with a dedicated operator.',
    internalLinks: [],
    factsUsed: [],
    sourcesUsed: [],
    ...overrides,
  };
}

function heading(text: string): ContentBlock {
  return { type: 'heading', id: `h-${text}`, data: { text, level: 2 } } as ContentBlock;
}
function text(content: string, id = `t-${Math.random()}`): ContentBlock {
  return { type: 'text', id, data: { content } } as ContentBlock;
}

// 20+ content words, generic — zero fact tokens, zero brand mentions.
const GENERIC_SECTION =
  '<p>Choosing a display solution for any gathering takes thought around the target audience and the placement site ' +
  'and evening hours and also ground conditions and access roads and available parking and coordination with local authorities in town.</p>';
const GENERIC_SECTION_2 =
  '<p>Planning the schedule properly needs early arrival and lighting checks and content fitting and backup options ' +
  'for delays and also crew briefing and setting expectations with the hosts right after the gathering closes.</p>';

const FACT = 'A full projection day from ACME-EVENTS starts at about 2,500 dollars and includes a dedicated operator throughout the activity';

describe('commoditySpanAudit — sections that could appear on any competitor site', () => {
  it('names both headings when two sections carry zero fact tokens and zero brand mentions', () => {
    const blocks = [
      heading('How to choose a solution'),
      text(GENERIC_SECTION),
      heading('Planning the schedule'),
      text(GENERIC_SECTION_2),
    ];
    const flagged = commoditySpanAudit(blocks, FACT, 'ACME-EVENTS');
    expect(flagged).toHaveLength(2);
    expect(flagged.join(' ')).toContain('How to choose a solution');
    expect(flagged.join(' ')).toContain('Planning the schedule');
  });

  it('stays silent when exactly one section is generic', () => {
    const blocks = [
      heading('How to choose a solution'),
      text(GENERIC_SECTION),
      heading('Our price'),
      text('<p>A full projection day from ACME-EVENTS starts at about 2,500 dollars and includes a dedicated operator.</p>'),
    ];
    expect(commoditySpanAudit(blocks, FACT, 'ACME-EVENTS')).toEqual([]);
  });

  it('does not flag a section that cites a fact token', () => {
    const blocks = [
      heading('First section'),
      text(GENERIC_SECTION.replace('target audience', 'dedicated operator')),
      heading('Second section'),
      text(GENERIC_SECTION_2),
    ];
    const flagged = commoditySpanAudit(blocks, FACT, 'ACME-EVENTS');
    expect(flagged.join(' ')).not.toContain('First section');
  });

  it('does not flag a section that names the brand', () => {
    const blocks = [
      heading('First section'),
      text(GENERIC_SECTION.replace('target audience', 'ACME-EVENTS and its customers')),
      heading('Second section'),
      text(GENERIC_SECTION_2),
    ];
    const flagged = commoditySpanAudit(blocks, FACT, 'ACME-EVENTS');
    expect(flagged.join(' ')).not.toContain('First section');
  });

  it('ignores short sections — under 20 content words there is nothing to judge', () => {
    const blocks = [
      heading('Short'),
      text('<p>Just one short sentence.</p>'),
      heading('Also short'),
      text('<p>Another short sentence.</p>'),
    ];
    expect(commoditySpanAudit(blocks, FACT, 'ACME-EVENTS')).toEqual([]);
  });
});

describe('ctaAudit — the rider mandates exactly one CTA', () => {
  it('names both spans when two phone numbers appear', () => {
    const blocks = [
      text('<p>Call us: 03-1234567 with any question.</p>', 'a'),
      text('<p>Or dial 054-1234567 in the evening.</p>', 'b'),
    ];
    const spans = ctaAudit(blocks, enPack);
    expect(spans).toHaveLength(2);
    expect(spans.join(' ')).toContain('03-1234567');
    expect(spans.join(' ')).toContain('054-1234567');
  });

  it.each([
    ['North American', '(212) 555-0123', '212-555-0123'],
    ['international', '+44 20 7946 0958', '+1 212 555 0123'],
    ['trunk-zero', '020 7946 0958', '0612345678'],
  ])('recognizes %s phone shapes', (_shape, first, second) => {
    const spans = ctaAudit([text(`<p>Ring ${first} today.</p>`, 'a'), text(`<p>Or try ${second}.</p>`, 'b')], enPack);
    expect(spans).toEqual([first, second]);
  });

  it('never reads prices, years, dates or digit runs as phone numbers', () => {
    const blocks = [
      text('<p>From 2,500 to 4,000 dollars, or 12500 in total, as of 2026-09-15.</p>', 'a'),
      text('<p>Between 1500 2000 units, reference 1234567890.</p>', 'b'),
    ];
    expect(ctaAudit(blocks, enPack)).toEqual([]);
  });

  it('accepts exactly one phone with no extra contact sentences', () => {
    const blocks = [
      text('<p>For details: 054-8147767 — happy to help.</p>', 'a'),
      text('<p>The screen also runs in rain.</p>', 'b'),
    ];
    expect(ctaAudit(blocks, enPack)).toEqual([]);
  });

  it('holds one phone plus a contact sentence in a different block — two spans', () => {
    const blocks = [
      text('<p>Details: 03-1234567.</p>', 'a'),
      text('<p>Contact us today and we will arrange a demo.</p>', 'b'),
    ];
    const spans = ctaAudit(blocks, enPack);
    expect(spans).toHaveLength(2);
  });

  it('folds case when matching contact markers', () => {
    const blocks = [text('<p>Details: 03-1234567.</p>', 'a'), text('<p>GET IN TOUCH today.</p>', 'b')];
    expect(ctaAudit(blocks, enPack)).toHaveLength(2);
  });

  it('does not double-count a closing sentence that carries both the marker and the phone', () => {
    const blocks = [text('<p>Call us now: 03-1234567 and we will arrange it.</p>', 'a')];
    expect(ctaAudit(blocks, enPack)).toEqual([]);
  });

  it('still counts phones in a language with no contact markers', () => {
    const blocks = [text('<p>電話 03-1234-5678</p>', 'a'), text('<p>または 06-1234-5678</p>', 'b')];
    expect(ctaAudit(blocks, packFor('ja'))).toHaveLength(2);
  });
});

describe('vatQualifierAudit — a price must say where it stands on VAT', () => {
  it('holds a price with no VAT qualifier anywhere', () => {
    const a = article({
      title: 'Projectors for events',
      meta: 'A display solution for events.',
      h1: 'Projectors — the full answer',
      body: 'The cost is 1,500 € for a full day of activity.',
    });
    const result = vatQualifierAudit(a, enPack);
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('1,500 €');
  });

  it('is clean when a VAT qualifier appears anywhere in the article', () => {
    const a = article({
      title: 'Projectors for events',
      meta: 'A display solution for events.',
      h1: 'Projectors — the full answer',
      body: 'The cost is 1,500 € per day, plus VAT and transport.',
    });
    expect(vatQualifierAudit(a, enPack).ok).toBe(true);
  });

  it('is clean when the body has no price marker at all', () => {
    const a = article({
      title: 'Projectors for events',
      meta: 'A display solution.',
      h1: 'Projectors',
      body: 'The screen also runs in rain and arrives with an operator.',
    });
    expect(vatQualifierAudit(a, enPack).ok).toBe(true);
  });

  it('leaves a dollar price alone — US prices are quoted before sales tax', () => {
    const a = article({
      title: 'Projectors for events',
      meta: 'A display solution.',
      h1: 'Projectors',
      body: 'The cost is $1,500 for a full day of activity.',
    });
    expect(vatQualifierAudit(a, enPack).ok).toBe(true);
  });

  it('skips with an explicit marker for an uncurated language — never a hold', () => {
    const a = article({ body: 'Der Preis beträgt 1.500 Euro pro Tag.' });
    const result = vatQualifierAudit(a, packFor('de'));
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.skipped).toBe('no-vat-wordlist:de');
  });
});

describe('ymylPromiseAudit — promise verbs on health/money/legal topics', () => {
  it('names every promise verb on a YMYL topic', () => {
    const a = article({
      title: 'Business car insurance',
      body: 'The cover is guaranteed, and we promise payment within a week.',
    });
    const result = ymylPromiseAudit(a, 'car insurance', enPack);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('guaranteed');
    expect(result.reasons.join(' ')).toContain('we promise');
  });

  it('leaves the same verbs alone on a non-YMYL topic', () => {
    const a = article({
      title: 'Renting a projector',
      body: 'The team arrives on time, guaranteed, at each event.',
    });
    expect(ymylPromiseAudit(a, 'projector rental', enPack).ok).toBe(true);
  });

  it('is clean on a YMYL topic without promise verbs', () => {
    const a = article({
      title: 'Business car insurance',
      body: 'The cover depends on the chosen policy.',
    });
    expect(ymylPromiseAudit(a, 'car insurance', enPack).ok).toBe(true);
  });

  it('catches promise verbs with word boundaries on a YMYL topic', () => {
    const a = article({
      title: 'Business Loan Rates Compared',
      body: 'Approval is guaranteed within one day.',
    });
    const result = ymylPromiseAudit(a, 'business loan', packFor('en'));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('guaranteed');
  });

  it('a topic term inside a longer word does not arm the gate', () => {
    const a = article({ title: 'Syntax highlighting', body: 'Accuracy is guaranteed.' });
    expect(ymylPromiseAudit(a, 'syntax', enPack).ok).toBe(true);
  });

  it('skips with an explicit marker when the language has no verb list', () => {
    const a = article({ title: 'Versicherung für Firmen', body: 'garantiert.' });
    const result = ymylPromiseAudit(a, 'versicherung', packFor('de'));
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('no-promise-verb-list:de');
  });
});

describe('processLeakAudit and FAQ deictics fold case on the en pack', () => {
  it('catches a process leak at the start of a sentence', () => {
    expect(processLeakAudit([text('<p>Per the brief, the units run on batteries.</p>')], enPack)).toEqual(['per the brief']);
  });

  it('skips for a language with no list', () => {
    expect(processLeakAudit([text('<p>Per the brief.</p>')], packFor('ja'))).toEqual([]);
  });

  it('catches a capitalised pointer in a standalone FAQ answer', () => {
    const faq = {
      type: 'faq',
      id: 'faq-0',
      data: { items: [{ question: 'What is the price?', answer: 'See above for the rates.' }] },
    } as ContentBlock;
    expect(faqOverlapAudit([faq], enPack)).toEqual(['What is the price?']);
  });
});

describe('slugGate — a candidate must be short, single-script and from the title', () => {
  it('accepts a slug whose words come from the title, whatever the case', () => {
    const a = article({ slug: 'led-screen-rental', title: 'LED Screen Rental Costs', h1: 'LED Screen Rental' });
    expect(slugGate(a)).toBe('led-screen-rental');
  });

  it('accepts non-Latin and accented tokens', () => {
    expect(slugGate(article({ slug: 'レンタル-料金', title: 'レンタル料金の案内', h1: '料金' }))).toBe('レンタル-料金');
    expect(slugGate(article({ slug: 'جهاز-عرض', title: 'جهاز عرض للفعاليات', h1: 'جهاز عرض' }))).toBe('جهاز-عرض');
    expect(slugGate(article({ slug: 'für-events', title: 'Beamer für Events', h1: 'Beamer' }))).toBe('für-events');
  });

  it('discards a token that mixes Latin with another script', () => {
    expect(slugGate(article({ slug: 'renタル-price', title: 'renタル price', h1: 'x' }))).toBe('');
  });

  it('discards a slug unrelated to the title', () => {
    expect(slugGate(article({ slug: 'something-else-entirely', title: 'Projector rental', h1: 'Projector' }))).toBe('');
  });
});

describe('firstSentences — whole sentences within a budget', () => {
  it('stops at the budget on a sentence boundary', () => {
    expect(firstSentences('One short line. Another short line. A third one.', 20)).toBe('One short line.');
  });

  it('does not split a decimal', () => {
    expect(firstSentences('It weighs 3.5 kg today. More follows here.', 25)).toBe('It weighs 3.5 kg today.');
  });

  it('splits on CJK full stops, which take no following space', () => {
    expect(firstSentences('最初の文です。次の文です。最後の文です。', 8)).toBe('最初の文です。');
  });

  it('splits on the Arabic question mark', () => {
    expect(firstSentences('كم التكلفة؟ تبدأ من ألفي دولار.', 12)).toBe('كم التكلفة؟');
  });
});

describe('the persisted audit payload — additive keys only', () => {
  const cleanAudit = {
    ok: true,
    unsupported: [] as string[],
    unknownLinks: [] as string[],
    factCoverage: { provided: 5, used: 5, wordsPerFact: 100 },
    similarTo: null,
    superlatives: [] as string[],
    faqOverlap: [] as string[],
    repeatedSpans: [] as string[],
  };

  it('stays null for a fully-clean default-path article — the historical shape', () => {
    expect(buildSeoSchemaPayload(cleanAudit)).toBeNull();
  });

  it('keeps the exact historical key set when only legacy defects fire', () => {
    const payload = buildSeoSchemaPayload({ ...cleanAudit, superlatives: ['always'] })!;
    expect(Object.keys(payload).sort()).toEqual(
      ['factCoverage', 'faqOverlap', 'linkAudit', 'numberAudit', 'repeatedSpans', 'similarTo', 'superlatives'].sort()
    );
  });

  it('carries vatQualifier reasons into the payload, only when non-empty', () => {
    const payload = buildSeoSchemaPayload({
      ...cleanAudit,
      vatQualifier: ['price without VAT qualifier: "1,500 €"'],
    })!;
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).vatQualifier).toEqual([
      'price without VAT qualifier: "1,500 €"',
    ]);
  });

  it('carries ymylPromises and genericAnchors the same additive way', () => {
    const payload = buildSeoSchemaPayload({
      ...cleanAudit,
      ymylPromises: ['YMYL promise: "guaranteed"'],
      genericAnchors: ['click here'],
    }) as Record<string, unknown>;
    expect(payload.ymylPromises).toEqual(['YMYL promise: "guaranteed"']);
    expect(payload.genericAnchors).toEqual(['click here']);
  });

  it('never leaks empty new keys into a payload persisted for legacy reasons', () => {
    const payload = buildSeoSchemaPayload({
      ...cleanAudit,
      superlatives: ['always'],
      vatQualifier: [],
      ymylPromises: [],
      genericAnchors: [],
    }) as Record<string, unknown>;
    expect('vatQualifier' in payload).toBe(false);
    expect('ymylPromises' in payload).toBe(false);
    expect('genericAnchors' in payload).toBe(false);
  });
});

describe('moneyUrlsFromEnv — operator money pages (Task 3)', () => {
  it('parses comma-separated path=label pairs', () => {
    expect(moneyUrlsFromEnv('/pricing=Pricing,/contact=Contact us')).toEqual([
      { path: '/pricing', label: 'Pricing' },
      { path: '/contact', label: 'Contact us' },
    ]);
  });

  it('skips malformed pairs instead of throwing', () => {
    expect(
      moneyUrlsFromEnv('nopath=x,/ok=Fine,=empty,/alsook=Also,justtext,relative/x=Bad')
    ).toEqual([
      { path: '/ok', label: 'Fine' },
      { path: '/alsook', label: 'Also' },
    ]);
  });

  it('strips control characters and newlines from labels before they near a prompt', () => {
    expect(moneyUrlsFromEnv('/a=line\nbreak\x07bell')).toEqual([
      { path: '/a', label: 'linebreakbell' },
    ]);
  });

  it('returns [] when unset or empty', () => {
    expect(moneyUrlsFromEnv(undefined)).toEqual([]);
    expect(moneyUrlsFromEnv('')).toEqual([]);
    expect(moneyUrlsFromEnv('  ')).toEqual([]);
  });

  it('joins live_urls in the "path — label" shape, so auditLinks accepts a money link', () => {
    const entries = moneyUrlsFromEnv('/pricing=Pricing');
    const liveUrls = ['/guides/a/ — Guide A', ...moneyLiveUrls(entries)];
    expect(moneyLiveUrls(entries)).toEqual(['/pricing — Pricing']);
    const a = article({ body: 'All the prices are on [our full pricing page](/pricing).' });
    const audit = auditLinks(a, { host: 'x', buyerQuery: 'q', uniqueFact: 'f', liveUrls });
    expect(audit.unknown).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('builds a rider that names the money pages and asks for exactly one natural link', () => {
    const entries = moneyUrlsFromEnv('/pricing=Pricing');
    const rider = buildMoneyLinkRider(entries, enPack);
    expect(rider.startsWith('\n\n')).toBe(true);
    expect(rider).toContain('/pricing');
    expect(rider).toContain('Pricing');
    // Every language shares the English meta-language rider.
    const de = buildMoneyLinkRider(entries, packFor('de'));
    expect(de).toContain('/pricing');
    expect(de).toMatch(/exactly one/i);
  });

  it('appends NOTHING when MONEY_URLS is unset — the assembled prompt is byte-identical', () => {
    const prev = process.env.MONEY_URLS;
    delete process.env.MONEY_URLS;
    try {
      const base = buildQualityRules('related terms') + buildTableHint(6) + buildFaqRequest();
      expect(buildMoneyLinkRider(moneyUrlsFromEnv(), enPack)).toBe('');
      expect(base + buildMoneyLinkRider(moneyUrlsFromEnv(), enPack)).toBe(base);
    } finally {
      if (prev === undefined) delete process.env.MONEY_URLS;
      else process.env.MONEY_URLS = prev;
    }
  });
});

describe('inUseImageUrls — the hero reuse guard (SEO-E)', () => {
  it('collects distinct hero and card URLs from recent rows', async () => {
    dbRows.length = 0;
    dbRows.push(
      { heroImage: 'https://cdn.test/X.webp', cardImage: 'https://cdn.test/X.webp' },
      { heroImage: 'https://cdn.test/Y.webp', cardImage: null },
      { heroImage: null, cardImage: 'https://cdn.test/Z.webp' },
      { heroImage: null, cardImage: null }
    );
    const urls = await inUseImageUrls();
    expect(urls.sort()).toEqual([
      'https://cdn.test/X.webp',
      'https://cdn.test/Y.webp',
      'https://cdn.test/Z.webp',
    ]);
  });

  it('returns [] on an empty table', async () => {
    dbRows.length = 0;
    expect(await inUseImageUrls()).toEqual([]);
  });
});
