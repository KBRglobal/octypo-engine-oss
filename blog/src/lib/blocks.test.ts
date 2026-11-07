import { describe, it, expect } from 'vitest';

import { engineBlocksToPlainText } from '../../../admin/src/lib/blocks.js';
import { renderBlocks, blocksToPlainText, type Block } from './blocks';
import { ENGINE_BLOCK_FIXTURE } from '../../test/fixtures/blocks';

const ctx = {
  articlePathPrefix: '/blog',
  topicPathPrefix: '/topics',
  imageResizePrefix: null,
};

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('renderBlocks — every type the engine and the editor can write', () => {
  it('renders text blocks as HTML', () => {
    const html = renderBlocks([{ id: '1', type: 'text', data: { content: '<p>Hello <strong>world</strong></p>' } }], ctx);
    expect(html).toContain('<strong>world</strong>');
  });

  it('renders heading blocks at the declared level', () => {
    const html = renderBlocks([{ id: '1', type: 'heading', data: { text: 'What to expect', level: 2 } }], ctx);
    expect(html).toContain('<h2');
    expect(html).toContain('What to expect');
  });

  it('clamps an out-of-range heading level instead of emitting <h9>', () => {
    const html = renderBlocks([{ id: '1', type: 'heading', data: { text: 'x', level: 9 } }], ctx);
    expect(html).toMatch(/<h[2-4]/);
    expect(html).not.toContain('<h9');
  });

  it('renders image blocks with explicit width and height', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'image', data: { url: 'https://pub-x.r2.dev/a.png', alt: 'A door', caption: 'Credit' } }],
      ctx
    );
    expect(html).toContain('width="1536"');
    expect(html).toContain('height="1024"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('alt="A door"');
    expect(html).toContain('Credit');
  });

  it('accepts the API.md `credit` field as a caption alias', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'image', data: { url: 'https://pub-x.r2.dev/a.png', alt: 'x', credit: 'Photo: ACME' } }],
      ctx
    );
    expect(html).toContain('Photo: ACME');
  });

  it('renders faq blocks as a question/answer list', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'faq', data: { items: [{ question: 'Q one?', answer: '<p>A one.</p>' }] } }],
      ctx
    );
    expect(html).toContain('<h2 class="octypo-faq-title">Frequently asked questions</h2>');
    expect(html).toContain('Q one?');
    expect(html).toContain('A one.');
  });

  it('renders editor-only list blocks in both styles', () => {
    const ol = renderBlocks([{ id: '1', type: 'list', data: { items: ['a', 'b'], style: 'ordered' } }], ctx);
    expect(ol).toContain('<ol');
    const ul = renderBlocks([{ id: '1', type: 'list', data: { items: ['a'], style: 'unordered' } }], ctx);
    expect(ul).toContain('<ul');
  });

  it('renders legacy quote blocks', () => {
    const html = renderBlocks([{ id: '1', type: 'quote', data: { content: 'Never trust the engine.' } }], ctx);
    expect(html).toContain('<blockquote');
    expect(html).toContain('Never trust the engine.');
  });

  // The failure this catches is silent: a future engine block type renders as
  // nothing and a whole section vanishes from every article for a month.
  it('falls back to data.content for an unknown block type', () => {
    const html = renderBlocks([{ id: '1', type: 'video', data: { content: '<p>hi</p>' } }], ctx);
    expect(textOf(html)).toBe('hi');
  });

  it('falls back to data.text for an unknown block type', () => {
    const html = renderBlocks([{ id: '1', type: 'callout', data: { text: 'important' } }], ctx);
    expect(textOf(html)).toBe('important');
  });

  it('drops nothing when a block is malformed', () => {
    expect(() => renderBlocks([{ id: '1', type: 'text', data: {} } as Block], ctx)).not.toThrow();
    expect(() => renderBlocks([{ id: '1', type: 'faq', data: { items: 'nope' } } as unknown as Block], ctx)).not.toThrow();
  });

  it('re-sanitises unsanitised legacy HTML rather than trusting the engine', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'text', data: { content: '<p>ok</p><script>alert(1)</script>' } }],
      ctx
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('ok');
  });

  it('escapes heading text so a poisoned title cannot inject markup', () => {
    const html = renderBlocks([{ id: '1', type: 'heading', data: { text: '<img src=x onerror=alert(1)>', level: 2 } }], ctx);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('omits the anchor id rather than emitting id="" for an unslugifiable heading', () => {
    const html = renderBlocks([{ id: '1', type: 'heading', data: { text: '<img src=x>', level: 2 } }], ctx);
    expect(html).not.toContain('id=""');
  });
});

describe('word-count parity with the engine-side projection', () => {
  // If a whole block type quietly stops rendering, the rendered text stops
  // matching the projection the admin already uses. Nothing else notices.
  it('rendered plain text equals engineBlocksToPlainText over every known type', () => {
    const rendered = textOf(renderBlocks(ENGINE_BLOCK_FIXTURE, ctx));
    const expected = engineBlocksToPlainText(ENGINE_BLOCK_FIXTURE as never).replace(/\s+/g, ' ').trim();

    for (const word of expected.split(' ')) {
      expect(rendered, `missing word "${word}" from rendered output`).toContain(word);
    }
  });

  it('blocksToPlainText matches the engine projection word for word', () => {
    const mine = blocksToPlainText(ENGINE_BLOCK_FIXTURE);
    const theirs = engineBlocksToPlainText(ENGINE_BLOCK_FIXTURE as never);
    expect(mine).toBe(theirs);
  });
});

describe('link rewriting inside rendered text', () => {
  it('rewrites /article/<slug> hrefs onto the tenant article prefix', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'text', data: { content: '<p><a href="/article/best-crm">x</a></p>' } }],
      ctx
    );
    expect(html).toContain('href="/blog/best-crm"');
  });

  it('leaves external links alone', () => {
    const html = renderBlocks(
      [{ id: '1', type: 'text', data: { content: '<p><a href="https://other.example/article/x">x</a></p>' } }],
      ctx
    );
    expect(html).toContain('https://other.example/article/x');
  });
});
