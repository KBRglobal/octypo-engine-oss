import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {} }));
vi.mock('../lib/logger.js', () => {
  const stub = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: stub, log: stub, createLogger: () => stub };
});

const { liftFaq, markdownToBlocks } = await import('./run-commercial.js');

/**
 * Readers and answer systems use the visible FAQ; the site renders an accordion.
 * Questions buried in prose serve neither — the lift turns the writer's FAQ
 * section into structure.
 */
describe('lifting the FAQ section', () => {
  const md = `Opening paragraph.

## What affects the price
Content about price.

## Frequently Asked Questions

### How far ahead should I book?
Between 48 and 72 hours, subject to availability.

### Do I need power on site?
No. The units are fully autonomous.`;

  it('extracts question/answer pairs and removes them from the body', () => {
    const { blocks, faq } = liftFaq(markdownToBlocks(md));
    expect(faq).toHaveLength(2);
    expect(faq[0].question).toContain('How far ahead');
    expect(faq[1].answer).toContain('autonomous');
    const texts = blocks.map((b) => JSON.stringify(b.data));
    expect(texts.join(' ')).not.toContain('48 and 72');
    expect(texts.join(' ')).toContain('Content about price');
  });

  it("handles bold-line questions, the writer's other habit", () => {
    const alt = `Body.

## Frequently Asked Questions

**Is there a minimum term?**
There is no commitment.

**What does the price include?**
The price includes setup and operation.`;
    const { faq } = liftFaq(markdownToBlocks(alt));
    expect(faq).toHaveLength(2);
    expect(faq[1].question).toBe('What does the price include?');
  });

  it('leaves an article without a FAQ section untouched', () => {
    const { blocks, faq } = liftFaq(markdownToBlocks('One paragraph.\n\n## Heading\nAnother paragraph.'));
    expect(faq).toEqual([]);
    expect(blocks).toHaveLength(3);
  });

  it('treats non-Latin question marks as questions at the FAQ heading level', () => {
    const arabic = `Body.

## FAQ

## كم التكلفة؟
تبدأ من ألفي دولار.

## 費用はいくらですか？
二千ドルからです。

## Next section
Still body.`;
    const { blocks, faq } = liftFaq(markdownToBlocks(arabic));
    expect(faq.map((f) => f.question)).toEqual(['كم التكلفة؟', '費用はいくらですか？']);
    expect(JSON.stringify(blocks)).toContain('Still body');
  });
});
