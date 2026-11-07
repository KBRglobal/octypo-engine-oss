import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateCalls: { set: Record<string, unknown>; count: number }[] = [];
let failDbWrite = false;

vi.mock('../db.js', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (failDbWrite) throw new Error('db down');
          updateCalls.push({ set: values, count: updateCalls.length });
          return [];
        },
      }),
    }),
  },
}));

const stubLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../lib/logger.js', () => ({
  logger: stubLogger,
  log: stubLogger,
  createLogger: () => stubLogger,
}));

let siteUrl: string | null = 'https://client.example';
vi.mock('../config/domain.js', () => ({
  get SITE_URL() {
    return siteUrl;
  },
  SITE_NAME: 'Client',
}));

const { verifyArticleLiveness } = await import('./liveness.js');

function response(
  status: number,
  body = '<html><head></head><body>ok</body></html>',
  headers: Record<string, string> = {}
): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
}

beforeEach(() => {
  updateCalls.length = 0;
  failDbWrite = false;
  siteUrl = 'https://client.example';
  stubLogger.warn.mockClear();
});

describe('verifyArticleLiveness', () => {
  it('records ok:true for a 200 with no noindex, and writes it to the row', async () => {
    const fetchImpl = vi.fn(async () => response(200)) as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 'my-article' }, fetchImpl);
    expect(record).toMatchObject({ ok: true, httpStatus: 200, noindex: false });
    expect(typeof record!.checkedAt).toBe('string');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set.liveness).toMatchObject({ ok: true, httpStatus: 200 });
  });

  it('builds the URL from SITE_URL + ARTICLE_PATH_PREFIX + the encoded slug only', async () => {
    const fetchImpl = vi.fn(async () => response(200)) as unknown as typeof fetch;
    await verifyArticleLiveness({ id: 'c1', slug: 'شاشة-عرض' }, fetchImpl);
    const url = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url.startsWith('https://client.example/guides/')).toBe(true);
    expect(url).toContain(encodeURIComponent('شاشة-عرض'));
  });

  it('flags noindex from the X-Robots-Tag header — ok:false', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, '<html></html>', { 'x-robots-tag': 'noindex, nofollow' })
    ) as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(record).toMatchObject({ ok: false, noindex: true, httpStatus: 200 });
  });

  it('flags noindex from a robots meta tag in the HTML head', async () => {
    const html = '<html><head><meta name="robots" content="noindex"></head><body></body></html>';
    const fetchImpl = vi.fn(async () => response(200, html)) as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(record).toMatchObject({ ok: false, noindex: true });
  });

  it('records a 404 as ok:false', async () => {
    const fetchImpl = vi.fn(async () => response(404, 'not here')) as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(record).toMatchObject({ ok: false, httpStatus: 404, noindex: false });
  });

  it('records a thrown fetch as a failed check and NEVER throws — the publish is safe', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(record).toMatchObject({ ok: false, httpStatus: null });
    expect(record!.error).toContain('network unreachable');
    expect(updateCalls).toHaveLength(1);
  });

  it('does not throw even when the db write itself fails', async () => {
    failDbWrite = true;
    const fetchImpl = vi.fn(async () => response(200)) as unknown as typeof fetch;
    await expect(verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl)).resolves.toBeTruthy();
  });

  it('skips silently when SITE_URL is unset', async () => {
    siteUrl = null;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const record = await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(record).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('logs a warning when the article is live but noindexed', async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, '<html></html>', { 'x-robots-tag': 'noindex' })
    ) as unknown as typeof fetch;
    await verifyArticleLiveness({ id: 'c1', slug: 's' }, fetchImpl);
    expect(stubLogger.warn).toHaveBeenCalled();
  });
});
