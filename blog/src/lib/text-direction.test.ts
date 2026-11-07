import { describe, expect, it } from 'vitest';
import { textDirection } from './text-direction';

describe('textDirection', () => {
  it('reads right-to-left languages and explicit scripts', () => {
    for (const locale of ['ar', 'fa', 'ur', 'he', 'dv', 'ar-EG', 'az-Arab']) {
      expect(textDirection(locale)).toBe('rtl');
    }
  });

  it('reads everything else, and bad tags, as left-to-right', () => {
    for (const locale of ['en', 'ja', 'de', 'az', '', 'not a tag!']) {
      expect(textDirection(locale)).toBe('ltr');
    }
  });
});
