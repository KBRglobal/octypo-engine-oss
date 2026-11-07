import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {} }));

const { toSubtitle } = await import('./render-article-video.js');

/**
 * A template gives the subtitle one line. A summary pasted in whole is clipped
 * by the renderer, mid-word and without any indication that it was cut.
 */
describe('subtitle', () => {
  it('passes a short line through untouched', () => {
    expect(toSubtitle('What LED truck advertising costs')).toBe('What LED truck advertising costs');
  });

  it('collapses whitespace', () => {
    expect(toSubtitle('  two\n\nlines  ')).toBe('two lines');
  });

  it('is undefined for nothing, so the template keeps its own default', () => {
    expect(toSubtitle('')).toBeUndefined();
    expect(toSubtitle(null)).toBeUndefined();
    expect(toSubtitle('   ')).toBeUndefined();
  });

  it('cuts on a word boundary and marks the cut', () => {
    const long =
      'Mobile billboard advertising reaches drivers in traffic where a static billboard cannot, ' +
      'and the trucks can follow an event around a city all day long.';
    const subtitle = toSubtitle(long)!;
    expect(subtitle.length).toBeLessThanOrEqual(121);
    expect(subtitle.endsWith('…')).toBe(true);
    expect(subtitle).not.toMatch(/[ ,;:.]…$/);
    // The last word before the ellipsis is a whole word from the original.
    const lastWord = subtitle.slice(0, -1).split(' ').pop()!;
    expect(long).toContain(lastWord);
  });
});
