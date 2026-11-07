import { describe, it, expect, vi } from 'vitest';

vi.mock('../db.js', () => ({ db: {} }));
vi.mock('../lib/logger.js', () => {
  const stub = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: stub, log: stub, createLogger: () => stub };
});

const { markdownToBlocks, inlineMarkdownToHtml } = await import('./run-commercial.js');

/**
 * The writer emits markdown. Nothing downstream converted it, so ** and
 * [anchor](url) and pipe tables shipped as literal text on customer sites,
 * with every internal link dead.
 */
describe('inline markdown to HTML', () => {
  it('turns bold into <strong>', () => {
    expect(inlineMarkdownToHtml('really **important** to know')).toBe('really <strong>important</strong> to know');
  });

  it('turns a markdown link into a real anchor', () => {
    expect(inlineMarkdownToHtml('see [the guide](/insights/x/) for details')).toContain(
      '<a href="/insights/x/">the guide</a>'
    );
  });

  it('keeps non-Latin text intact around the markup', () => {
    expect(inlineMarkdownToHtml('[ガイド](/insights/x/)と**重要**')).toBe(
      '<a href="/insights/x/">ガイド</a>と<strong>重要</strong>'
    );
  });

  it('escapes stray angle brackets so author text cannot inject tags', () => {
    expect(inlineMarkdownToHtml('a < b and <script>x</script>')).not.toContain('<script>');
  });

  it('rejects a javascript: link by not matching it as a link', () => {
    // Only /path and http(s) hrefs are recognised; anything else stays literal
    // text and is then escaped.
    const html = inlineMarkdownToHtml('[x](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
  });
});

describe('block conversion', () => {
  it('renders a paragraph body as HTML, not literal markdown', () => {
    const [block] = markdownToBlocks('Text with **emphasis** and a [link](/a/).');
    const content = (block.data as { content: string }).content;
    expect(content).toContain('<strong>emphasis</strong>');
    expect(content).toMatch(/<a href="\/a\/"[^>]*>link<\/a>/);
    expect(content).not.toContain('**');
  });

  it('converts a pipe table into an HTML table', () => {
    const md = `| Parameter | Value |
| --- | --- |
| Brightness | 6000 nits |
| Autonomy | Full |`;
    const [block] = markdownToBlocks(md);
    const content = (block.data as { content: string }).content;
    expect(content).toContain('<table>');
    expect(content).toContain('<th>Parameter</th>');
    expect(content).toContain('<td>6000 nits</td>');
  });

  it('converts list items too', () => {
    const [block] = markdownToBlocks('- An **emphasised** item\n- An item with a [link](/b/)');
    const items = (block.data as { items: string[] }).items;
    expect(items[0]).toContain('<strong>emphasised</strong>');
    expect(items[1]).toMatch(/<a href="\/b\/"[^>]*>link<\/a>/);
  });
});
