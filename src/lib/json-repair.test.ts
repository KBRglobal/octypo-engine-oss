import { describe, it, expect } from 'vitest';

import { parseJsonLoose, escapeControlCharsInStrings } from './json-repair.js';

/**
 * A 2,000-word article inside a JSON object fails the same way every time: the
 * prose contains a literal newline, which JSON forbids inside a string. Losing
 * the article over one escape costs a full regeneration.
 */
describe('parsing a model\'s near-JSON', () => {
  it('leaves valid JSON exactly as it is', () => {
    const value = { a: 'one', b: ['two', 3], c: { d: null } };
    expect(parseJsonLoose(JSON.stringify(value))).toEqual(value);
  });

  it('recovers a literal newline inside a string', () => {
    const broken = '{"body":"first line\nsecond line"}';
    expect(parseJsonLoose<{ body: string }>(broken).body).toBe('first line\nsecond line');
  });

  it('recovers tabs and carriage returns', () => {
    const broken = '{"body":"a\tb\r\nc"}';
    expect(parseJsonLoose<{ body: string }>(broken).body).toBe('a\tb\r\nc');
  });

  it('keeps escapes that were already correct', () => {
    const fine = '{"body":"already \\n escaped"}';
    expect(parseJsonLoose<{ body: string }>(fine).body).toBe('already \n escaped');
  });

  it('does not treat an escaped quote as the end of a string', () => {
    const broken = '{"body":"he said \\"hello\\"\nand left"}';
    expect(parseJsonLoose<{ body: string }>(broken).body).toBe('he said "hello"\nand left');
  });

  it('leaves newlines between properties alone', () => {
    const pretty = '{\n  "a": "x",\n  "b": "y"\n}';
    expect(parseJsonLoose(pretty)).toEqual({ a: 'x', b: 'y' });
  });

  it('handles non-Latin content, which is where this actually bites', () => {
    const broken = '{"intro":"شاشات العرض للفعاليات\nهي الأداة الرئيسية"}';
    expect(parseJsonLoose<{ intro: string }>(broken).intro).toContain('شاشات العرض');
  });

  it('reports the original error when the text is genuinely broken', () => {
    // A repair that invented structure would turn a parse error into silently
    // wrong content, which is worse than a retry.
    expect(() => parseJsonLoose('{"a": ')).toThrow();
    expect(() => parseJsonLoose('not json at all')).toThrow();
  });
});

describe('unescaped quotes inside prose', () => {
  it('recovers a quoted phrase the model did not escape', () => {
    const broken = '{"body":"the client asked "how much" and left"}';
    expect(parseJsonLoose<{ body: string }>(broken).body).toBe(
      'the client asked "how much" and left'
    );
  });

  it('still ends the string at a real closing quote', () => {
    const fine = '{"a":"one","b":"two"}';
    expect(parseJsonLoose(fine)).toEqual({ a: 'one', b: 'two' });
  });

  it('handles non-Latin prose with straight quotes', () => {
    const broken = '{"intro":"سأل العميل "كم التكلفة" وهذا هو السؤال الثاني"}';
    expect(parseJsonLoose<{ intro: string }>(broken).intro).toContain('كم التكلفة');
  });
});

describe('the escape pass', () => {
  it('escapes an exotic control character as a unicode escape', () => {
    const escaped = escapeControlCharsInStrings('{"a":"xy"}');
    expect(escaped).toContain('\\u0001');
    expect(JSON.parse(escaped)).toEqual({ a: 'xy' });
  });

  it('never touches text outside a string', () => {
    expect(escapeControlCharsInStrings('{\n"a":1\n}')).toBe('{\n"a":1\n}');
  });
});
