import { describe, it, expect, vi } from 'vitest';

// report.ts imports the db module, which throws at import time without a
// connection string. Every test here exercises pure functions or the handler
// with injected deps, so the connection is stubbed (site.test.ts pattern).
vi.mock('../db.js', () => ({ db: {} }));

const {
  checkReportKey,
  createReportHandler,
  renderReportHtml,
  escapeHtml,
  buildWeeklyBuckets,
  liveUrlFor,
  buildReportData,
} = await import('./report.js');

import type { ClusterLocale } from '../config/locale.js';
import type { ReportData } from './report.js';

const DE_LOCALE: ClusterLocale = {
  language: 'de',
  country: 'DE',
  languageName: 'German',
  isDefault: false,
};

const EN_LOCALE: ClusterLocale = {
  language: 'en',
  country: 'US',
  languageName: 'English',
  isDefault: false,
};

function emptyData(overrides: Partial<ReportData> = {}): ReportData {
  return {
    siteName: 'Acme Events',
    ownerName: null,
    siteUrl: 'https://example.com',
    articlePathPrefix: '/guides',
    now: new Date('2026-08-23T10:00:00'),
    publishedThisMonth: 0,
    totalLive: 0,
    totalWords: 0,
    topicsCovered: 0,
    weekly: [],
    recent: [],
    scheduledAhead: 0,
    ...overrides,
  };
}

interface StubRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  status(code: number): StubRes;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

function stubRes(): StubRes {
  const res: StubRes = {
    statusCode: 0,
    headers: {},
    body: '',
    status(code) {
      res.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    send(body) {
      res.body = String(body);
    },
  };
  return res;
}

/**
 * The key gate is the only thing standing between the public internet and the
 * client's delivery numbers. Off means invisible (404), wrong means denied
 * (401) — and the compare must never branch on secret bytes (T-qr-01).
 */
describe('owner greeting', () => {
  it('greets the owner by name when ownerName is set', () => {
    const html = renderReportHtml(emptyData({ ownerName: 'Avery' }), EN_LOCALE);
    expect(html).toContain('Hello Avery, here is what the engine has been doing for you');
    expect(html).not.toContain('Your content engine');
  });

  it('falls back to the tagline when no ownerName', () => {
    const html = renderReportHtml(emptyData(), DE_LOCALE);
    expect(html).toContain('Your content engine');
  });

  it('escapes a hostile ownerName', () => {
    const html = renderReportHtml(emptyData({ ownerName: '<script>x</script>' }), EN_LOCALE);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('checkReportKey', () => {
  it('reports the feature as off when no key is configured', () => {
    expect(checkReportKey('anything', undefined)).toBe('off');
    expect(checkReportKey('anything', '')).toBe('off');
    expect(checkReportKey('anything', '   ')).toBe('off');
  });

  it('denies a wrong key, a missing key, and a wrong-length key', () => {
    expect(checkReportKey('octy_report_wrong000000', 'octy_report_right000000')).toBe('denied');
    expect(checkReportKey(undefined, 'octy_report_right000000')).toBe('denied');
    expect(checkReportKey('', 'octy_report_right000000')).toBe('denied');
    expect(checkReportKey('short', 'octy_report_right000000')).toBe('denied');
    expect(checkReportKey(['octy_report_right000000'], 'octy_report_right000000')).toBe('denied');
  });

  it('accepts the exact key', () => {
    expect(checkReportKey('octy_report_right000000', 'octy_report_right000000')).toBe('ok');
  });
});

describe('report handler auth matrix', () => {
  const fakeLoad = async () => emptyData();
  const fakeLocale = async () => DE_LOCALE;

  it('returns 404 when CLIENT_REPORT_KEY is unset (feature off)', async () => {
    const handler = createReportHandler({
      loadReportData: fakeLoad,
      resolveLocale: fakeLocale,
      env: {} as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: { key: 'whatever' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not found');
  });

  it('returns 401 on a wrong key when the key is set', async () => {
    const handler = createReportHandler({
      loadReportData: fakeLoad,
      resolveLocale: fakeLocale,
      env: { CLIENT_REPORT_KEY: 'octy_report_secret' } as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: { key: 'octy_report_nope00' } }, res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 on a missing key when the key is set', async () => {
    const handler = createReportHandler({
      loadReportData: fakeLoad,
      resolveLocale: fakeLocale,
      env: { CLIENT_REPORT_KEY: 'octy_report_secret' } as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: {} }, res);
    expect(res.statusCode).toBe(401);
  });

  it('renders the page on the correct key: 200, html, no-store', async () => {
    const handler = createReportHandler({
      loadReportData: fakeLoad,
      resolveLocale: fakeLocale,
      env: { CLIENT_REPORT_KEY: 'octy_report_secret' } as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: { key: 'octy_report_secret' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('Acme Events');
    expect(res.body).toContain('dir="ltr"');
    expect(res.body).toContain('Powered by Octypo');
  });

  it('never references the admin bundle in a client-facing page', async () => {
    const handler = createReportHandler({
      loadReportData: fakeLoad,
      resolveLocale: fakeLocale,
      env: { CLIENT_REPORT_KEY: 'octy_report_secret' } as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: { key: 'octy_report_secret' } }, res);
    expect(res.body).not.toContain('/admin');
  });

  it('answers 500 with a minimal page (never a stack) when data loading dies', async () => {
    const handler = createReportHandler({
      loadReportData: async () => {
        throw new Error('SECRET_CONNECTION_STRING exploded');
      },
      resolveLocale: fakeLocale,
      env: { CLIENT_REPORT_KEY: 'octy_report_secret' } as NodeJS.ProcessEnv,
    });
    const res = stubRes();
    await handler({ query: { key: 'octy_report_secret' } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SECRET_CONNECTION_STRING');
    expect(res.body).not.toContain('Error');
  });
});

describe('escapeHtml', () => {
  it('neutralises every HTML metacharacter (T-qr-02)', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("O'Reilly & Sons")).toBe('O&#39;Reilly &amp; Sons');
    expect(escapeHtml(null)).toBe('');
  });
});

// ── Task 2: full report content ────────────────────────────────────────────

// 2026-08-23 is a Sunday; the current Monday-start week began 2026-08-17.
const NOW = new Date('2026-08-23T10:00:00');

function fullData(overrides: Partial<ReportData> = {}): ReportData {
  return emptyData({
    now: NOW,
    publishedThisMonth: 9,
    totalLive: 42,
    totalWords: 31250,
    topicsCovered: 6,
    weekly: buildWeeklyBuckets(
      [new Date('2026-08-18T09:00:00'), new Date('2026-08-19T09:00:00'), new Date('2026-07-07T09:00:00')],
      NOW
    ),
    recent: [
      {
        title: 'Mobile LED screen for events',
        slug: 'mobile-led-screen',
        wordCount: 742,
        publishedAt: new Date('2026-08-18T09:00:00'),
        topic: 'led-screens',
        image: 'https://cdn.example.com/covers/led-screen.jpg',
      },
      {
        title: 'Plain title',
        slug: 'plain-title',
        wordCount: 615,
        publishedAt: new Date('2026-08-12T09:00:00'),
        topic: null,
        image: null,
      },
    ],
    scheduledAhead: 4,
    ...overrides,
  });
}

describe('buildWeeklyBuckets', () => {
  it('produces exactly 8 Monday-start buckets, oldest first', () => {
    const buckets = buildWeeklyBuckets([], NOW);
    expect(buckets).toHaveLength(8);
    for (const b of buckets) {
      // getDay(): Monday === 1
      expect(b.start.getDay()).toBe(1);
      expect(b.count).toBe(0);
    }
    expect(buckets[7].start.toDateString()).toBe(new Date('2026-08-17').toDateString());
    expect(buckets[0].start.toDateString()).toBe(new Date('2026-06-29').toDateString());
    expect(buckets[0].start.getTime()).toBeLessThan(buckets[7].start.getTime());
  });

  it('counts publishes into the right week and drops out-of-window dates', () => {
    const buckets = buildWeeklyBuckets(
      [
        new Date('2026-08-18T09:00:00'), // current week
        new Date('2026-08-19T23:00:00'), // current week
        new Date('2026-08-16T23:59:00'), // Sunday — previous week
        new Date('2026-06-28T09:00:00'), // before the window
        new Date('2026-09-15T09:00:00'), // after the window
        null,
      ],
      NOW
    );
    expect(buckets[7].count).toBe(2);
    expect(buckets[6].count).toBe(1);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
  });
});

describe('liveUrlFor', () => {
  it('builds the live URL from SITE_URL + prefix + slug', () => {
    expect(liveUrlFor('https://example.com', '/guides', 'my-post')).toBe(
      'https://example.com/guides/my-post'
    );
  });

  it('URL-encodes non-Latin slugs', () => {
    const url = liveUrlFor('https://example.com', '/guides', '\u30DB\u30C6\u30EB-\u6771\u4EAC');
    expect(url).toContain('/guides/');
    expect(url).not.toContain('\u30DB\u30C6\u30EB');
    expect(decodeURIComponent(url!)).toBe('https://example.com/guides/\u30DB\u30C6\u30EB-\u6771\u4EAC');
  });

  it('returns null without a site URL — titles render as plain text', () => {
    expect(liveUrlFor(null, '/guides', 'my-post')).toBeNull();
  });
});

describe('buildReportData', () => {
  const rows = [
    {
      title: 'A',
      slug: 'a',
      wordCount: 700,
      publishedAt: new Date('2026-08-18T09:00:00'),
      topics: ['led-screens', 'events'],
      category: 'guide',
    },
    {
      title: 'B',
      slug: 'b',
      wordCount: 500,
      publishedAt: new Date('2026-07-10T09:00:00'),
      topics: ['led-screens'],
      category: 'tips',
    },
    {
      title: 'C',
      slug: 'c',
      wordCount: null,
      publishedAt: null,
      topics: [],
      category: 'news',
    },
  ];

  it('computes the four tiles: month, live, words, topics', () => {
    const data = buildReportData(rows, 4, { SITE_NAME: 'X' } as NodeJS.ProcessEnv, NOW);
    expect(data.publishedThisMonth).toBe(1); // only A is in August
    expect(data.totalLive).toBe(3);
    expect(data.totalWords).toBe(1200); // null wordCount counts as 0
    expect(data.topicsCovered).toBe(2); // led-screens + events
    expect(data.scheduledAhead).toBe(4);
  });

  it('falls back to distinct categories when no row carries topic slugs', () => {
    const noTopics = rows.map((r) => ({ ...r, topics: [] }));
    const data = buildReportData(noTopics, 0, {} as NodeJS.ProcessEnv, NOW);
    expect(data.topicsCovered).toBe(3); // guide, tips, news
  });

  it('caps the recent table at 20 rows, newest first', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      title: `T${i}`,
      slug: `t${i}`,
      wordCount: 100,
      publishedAt: new Date(2026, 7, 1 + (i % 20), 9),
      topics: [],
      category: null,
    }));
    const data = buildReportData(many, 0, {} as NodeJS.ProcessEnv, NOW);
    expect(data.recent).toHaveLength(20);
  });

  it('picks card_image first, hero_image as fallback, null when neither exists', () => {
    const withImages = [
      { ...rows[0], cardImage: '/img/card.jpg', heroImage: '/img/hero.jpg' },
      { ...rows[1], cardImage: null, heroImage: '/img/hero-only.jpg' },
      { ...rows[2], publishedAt: new Date('2026-08-01T09:00:00') },
    ];
    const data = buildReportData(withImages, 0, {} as NodeJS.ProcessEnv, NOW);
    const bySlug = new Map(data.recent.map((r) => [r.slug, r.image]));
    expect(bySlug.get('a')).toBe('/img/card.jpg');
    expect(bySlug.get('b')).toBe('/img/hero-only.jpg');
    expect(bySlug.get('c')).toBeNull();
  });

  it('reads site identity from the environment', () => {
    const data = buildReportData([], 0, {
      SITE_NAME: 'Example Screens',
      SITE_URL: 'https://screens.example.com/',
      ARTICLE_PATH_PREFIX: '/blog',
    } as NodeJS.ProcessEnv, NOW);
    expect(data.siteName).toBe('Example Screens');
    expect(data.siteUrl).toBe('https://screens.example.com');
    expect(data.articlePathPrefix).toBe('/blog');
  });
});

describe('renderReportHtml — full page', () => {
  it('renders all sections: tiles, 8 bars, article cards, scheduled line, footer', () => {
    const html = renderReportHtml(fullData(), DE_LOCALE);
    const deFmt = new Intl.NumberFormat('de-DE');
    expect(html).toContain(deFmt.format(9));
    expect(html).toContain(deFmt.format(42));
    expect(html).toContain(deFmt.format(31250));
    expect(html).toContain(deFmt.format(6));
    expect((html.match(/class="track"/g) ?? []).length).toBe(8);
    expect((html.match(/<article class="art"/g) ?? []).length).toBe(2);
    expect(html).toContain(deFmt.format(4)); // scheduled ahead
    expect(html).toContain('Powered by Octypo');
  });

  it('renders the portal chrome: kicker, LIVE pill, ember-tipped current week', () => {
    const html = renderReportHtml(fullData(), DE_LOCALE);
    expect(html).toContain('OCTYPO / CLIENT PORTAL');
    expect(html).toContain('>LIVE</span>');
    // Current week (2026-08-17 bucket) has publishes → ember-capped bar.
    expect(html).toContain('class="bar cur"');
  });

  it('renders the card image when present and the graphite placeholder when null', () => {
    const html = renderReportHtml(fullData(), DE_LOCALE);
    // First article carries an image…
    expect(html).toContain('src="https://cdn.example.com/covers/led-screen.jpg"');
    // …the second has none and must still render, with the placeholder block.
    expect(html).toContain('Plain title');
    expect((html.match(/class="thumb ph"/g) ?? []).length).toBe(1);
  });

  it('never renders a non-http image URL as a src (placeholder instead)', () => {
    const html = renderReportHtml(
      fullData({
        recent: [
          {
            title: 'T',
            slug: 't',
            wordCount: 100,
            publishedAt: new Date('2026-08-18T09:00:00'),
            topic: null,
            image: 'javascript:alert(1)',
          },
        ],
      }),
      EN_LOCALE
    );
    expect(html).not.toContain('javascript:alert');
    expect(html).toContain('class="thumb ph"');
  });

  it('links titles to the live site with noopener, in a new tab', () => {
    const html = renderReportHtml(fullData(), DE_LOCALE);
    expect(html).toContain('https://example.com/guides/');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it('renders plain-text titles when SITE_URL is missing', () => {
    const html = renderReportHtml(fullData({ siteUrl: null }), DE_LOCALE);
    expect(html).not.toContain('<a href');
    expect(html).toContain('Plain title');
  });

  it('formats dates per locale', () => {
    const date = new Date('2026-08-18T09:00:00');
    const de = renderReportHtml(fullData(), DE_LOCALE);
    const en = renderReportHtml(fullData(), EN_LOCALE);
    expect(de).toContain(new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(date));
    expect(en).toContain(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date));
  });

  it('keeps the English copy in every language, and lets titles set their own direction', () => {
    const arabic = renderReportHtml(fullData(), {
      language: 'ar',
      country: 'EG',
      languageName: 'Arabic',
      isDefault: false,
    });
    expect(arabic).toContain('dir="ltr"');
    expect(arabic).toContain('Content Report');
    expect(arabic).toContain('dir="auto"');
  });

  it('hides the scheduled-ahead line entirely at 0', () => {
    const html = renderReportHtml(fullData({ scheduledAhead: 0 }), DE_LOCALE);
    expect(html).not.toContain('class="sched"');
  });

  it('renders a complete page on a zero-data install (no NaN, no crash)', () => {
    const html = renderReportHtml(
      emptyData({ weekly: buildWeeklyBuckets([], NOW), siteUrl: null }),
      DE_LOCALE
    );
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('NaN');
    expect((html.match(/class="track"/g) ?? []).length).toBe(8);
  });

  it('caps the rendered cards at 20 even if fed more', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      title: `T${i}`,
      slug: `t${i}`,
      wordCount: 100,
      publishedAt: new Date('2026-08-01T09:00:00'),
      topic: null,
      image: null,
    }));
    const html = renderReportHtml(fullData({ recent: rows }), EN_LOCALE);
    expect((html.match(/<article class="art"/g) ?? []).length).toBe(20);
  });

  it('escapes model-written titles and slugs everywhere (T-qr-02)', () => {
    const html = renderReportHtml(
      fullData({
        recent: [
          {
            title: '<script>alert(1)</script>',
            slug: '"><svg onload=alert(1)>',
            wordCount: 1,
            publishedAt: new Date('2026-08-18T09:00:00'),
            topic: '<b>x</b>',
            image: 'https://x.example/"><img src=x onerror=alert(1)>.jpg',
          },
        ],
      }),
      EN_LOCALE
    );
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<b>x</b>');
  });

  it('never leaks operational data: no aeo, cost, dollar signs (T-qr-03)', () => {
    for (const locale of [DE_LOCALE, EN_LOCALE]) {
      const html = renderReportHtml(fullData(), locale).toLowerCase();
      expect(html).not.toContain('aeo');
      expect(html).not.toContain('cost');
      expect(html).not.toContain('$');
      expect(html).not.toContain('review');
      expect(html).not.toContain('quality');
    }
  });
});

describe('renderReportHtml shell', () => {
  it('renders a full document with lang + dir for an English install', () => {
    const html = renderReportHtml(emptyData(), EN_LOCALE);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('lang="en"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('Content Report');
  });

  it('escapes a model-written site name', () => {
    const html = renderReportHtml(emptyData({ siteName: '<img src=x onerror=1>' }), EN_LOCALE);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});
