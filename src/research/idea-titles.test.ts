import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/engine-registry.js', () => ({
  EngineRegistry: { getEngineCount: () => 0, getNextFromQueue: () => null, reportSuccess: vi.fn(), reportError: vi.fn() },
  generateWithEngine: vi.fn(),
}));

const { parseTitles, buildTitlePrompt, titleIdeas, TITLE_BATCH_SIZE } = await import('./idea-titles.js');

function idea(targetKeyword: string, isPillar = false) {
  return {
    title: `${targetKeyword}, explained`,
    targetKeyword,
    dedupeKey: targetKeyword,
    cluster: 'c',
    articleType: 'analyst' as const,
    isPillar,
    searchVolume: null,
    priority: 0,
    evidence: {},
  };
}

describe('title parsing', () => {
  it('reads a plain array', () => {
    expect(parseTitles('["One","Two"]', 2)).toEqual(['One', 'Two']);
  });

  it('survives code fences and surrounding prose', () => {
    expect(parseTitles('```json\n["One","Two"]\n```', 2)).toEqual(['One', 'Two']);
    expect(parseTitles('Here you go:\n["One","Two"]\nHope that helps', 2)).toEqual(['One', 'Two']);
  });

  it('rejects a short answer rather than shifting titles onto the wrong ideas', () => {
    // A misaligned headline promises something the article is not about.
    expect(parseTitles('["Only one"]', 2)).toBeNull();
    expect(parseTitles('["a","b","c"]', 2)).toBeNull();
  });

  it('rejects blanks and non-strings', () => {
    expect(parseTitles('["Good",""]', 2)).toBeNull();
    expect(parseTitles('["Good",null]', 2)).toBeNull();
  });

  it('rejects unparseable output', () => {
    expect(parseTitles('I could not do that', 1)).toBeNull();
    expect(parseTitles('["unterminated', 1)).toBeNull();
  });
});

describe('the prompt', () => {
  it('names each phrase and says which one is the pillar', () => {
    const prompt = buildTitlePrompt([idea('led truck cost'), idea('led trucks', true)]);
    expect(prompt).toContain('led truck cost');
    expect(prompt).toContain('pillar');
    expect(prompt).toContain('supporting');
  });
});

describe('titling', () => {
  it('keeps the fallback titles when there is no engine at all', async () => {
    const ideas = [idea('led truck cost')];
    expect(await titleIdeas(ideas)).toBe(0);
    expect(ideas[0].title).toBe('led truck cost, explained');
  });

  it('does nothing for an empty plan', async () => {
    expect(await titleIdeas([])).toBe(0);
  });

  it('batches rather than calling once per idea', () => {
    expect(TITLE_BATCH_SIZE).toBeGreaterThan(1);
  });
});
