import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  buildModifications,
  parseRender,
  isTerminal,
  creatomateConfigFromEnv,
  renderArticleVideo,
} = await import('./creatomate.js');

const config = { apiKey: 'k', templateId: 't', pollIntervalMs: 1, maxWaitMs: 1000 };
const noSleep = async () => undefined;

describe('configuration', () => {
  it('needs both a key and a template', () => {
    expect(creatomateConfigFromEnv({ CREATOMATE_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBeNull();
    expect(creatomateConfigFromEnv({ CREATOMATE_TEMPLATE_ID: 't' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      creatomateConfigFromEnv({
        CREATOMATE_API_KEY: 'k',
        CREATOMATE_TEMPLATE_ID: 't',
      } as NodeJS.ProcessEnv)
    ).not.toBeNull();
  });
});

describe('modifications', () => {
  it('maps an article onto the template fields', () => {
    expect(
      buildModifications({ title: 'LED trucks', subtitle: 'What they cost', mediaUrl: 'https://cdn/x.jpg' })
    ).toEqual({
      'Text-1.text': 'LED trucks',
      'Text-2.text': 'What they cost',
      'Video.source': 'https://cdn/x.jpg',
    });
  });

  it('omits an empty field rather than blanking the template default', () => {
    const mods = buildModifications({ title: 'Only a title', subtitle: '   ', mediaUrl: null });
    expect(mods).toEqual({ 'Text-1.text': 'Only a title' });
  });
});

describe('render parsing', () => {
  it('reads the first entry, because a create returns an array', () => {
    const job = parseRender([{ id: 'r1', status: 'planned' }]);
    expect(job).toEqual({ id: 'r1', status: 'planned', url: null, errorMessage: null });
  });

  it('reads a single object, because a status read returns one', () => {
    expect(parseRender({ id: 'r1', status: 'succeeded', url: 'https://cdn/v.mp4' })?.url).toBe(
      'https://cdn/v.mp4'
    );
  });

  it('is null on a payload with no id', () => {
    expect(parseRender({})).toBeNull();
    expect(parseRender(null)).toBeNull();
    expect(parseRender([])).toBeNull();
  });

  it('knows which states will not change again', () => {
    expect(isTerminal('succeeded')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('rendering')).toBe(false);
    expect(isTerminal('planned')).toBe(false);
  });
});

describe('rendering an article video', () => {
  it('polls until the render succeeds and returns the url', async () => {
    const responses = [
      [{ id: 'r1', status: 'planned' }],
      { id: 'r1', status: 'rendering' },
      { id: 'r1', status: 'succeeded', url: 'https://cdn/v.mp4' },
    ];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 })
    ) as unknown as typeof fetch;

    const url = await renderArticleVideo(config, { title: 'T' }, { fetchImpl, sleep: noSleep });
    expect(url).toBe('https://cdn/v.mp4');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns null on a failed render instead of throwing into the pipeline', async () => {
    const responses = [
      [{ id: 'r1', status: 'planned' }],
      { id: 'r1', status: 'failed', error_message: 'bad template' },
    ];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responses.shift()), { status: 200 })
    ) as unknown as typeof fetch;

    expect(await renderArticleVideo(config, { title: 'T' }, { fetchImpl, sleep: noSleep })).toBeNull();
  });

  it('gives up when the render outlasts its budget', async () => {
    // A render that never finishes must not hold a job open forever.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'r1', status: 'rendering' }), { status: 200 })
    ) as unknown as typeof fetch;

    let clock = 0;
    const url = await renderArticleVideo(
      { ...config, maxWaitMs: 10 },
      { title: 'T' },
      { fetchImpl, sleep: noSleep, now: () => (clock += 6) }
    );
    expect(url).toBeNull();
  });

  it('returns null when the render could not even be started', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 402 })) as unknown as typeof fetch;
    expect(await renderArticleVideo(config, { title: 'T' }, { fetchImpl, sleep: noSleep })).toBeNull();
  });

  it('sends the template id and the mapped fields', async () => {
    let body: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      body ??= init.body as string;
      return new Response(JSON.stringify({ id: 'r1', status: 'succeeded', url: 'u' }), { status: 200 });
    }) as unknown as typeof fetch;

    await renderArticleVideo(config, { title: 'A title' }, { fetchImpl, sleep: noSleep });
    expect(JSON.parse(body!)).toEqual({
      template_id: 't',
      modifications: { 'Text-1.text': 'A title' },
    });
  });
});
