import { describe, it, expect } from 'vitest';

import { rewriteInternalLinks, normalisePrefix } from './rewrite-links';

const opts = { articlePathPrefix: '/blog', topicPathPrefix: '/topics' };

describe('normalisePrefix', () => {
  it('adds a leading slash and drops a trailing one', () => {
    expect(normalisePrefix('blog/')).toBe('/blog');
    expect(normalisePrefix('/guides')).toBe('/guides');
    expect(normalisePrefix('')).toBe('');
    expect(normalisePrefix('/')).toBe('');
  });
});

describe('rewriteInternalLinks', () => {
  // internal-linking-engine.ts:411-415 hardcodes /article/, /guide/ and /review/
  // prefixes that no tenant blog is actually served under.
  it.each([
    ['/article/best-crm-2026', '/blog/best-crm-2026'],
    ['/guide/moving-house', '/blog/moving-house'],
    ['/review/acme-lock', '/blog/acme-lock'],
  ])('rewrites %s to %s', (from, to) => {
    expect(rewriteInternalLinks(`<a href="${from}">x</a>`, opts)).toContain(`href="${to}"`);
  });

  // internal-linking-engine.ts:350 writes 5-8 of these per article.
  it('rewrites /topics/<slug> onto the tenant topic prefix', () => {
    expect(
      rewriteInternalLinks('<a href="/topics/deposits">x</a>', {
        articlePathPrefix: '/blog',
        topicPathPrefix: '/t',
      })
    ).toContain('href="/t/deposits"');
  });

  it('leaves an already-correct topic href untouched', () => {
    expect(rewriteInternalLinks('<a href="/topics/deposits">x</a>', opts)).toContain('href="/topics/deposits"');
  });

  it('never touches absolute or protocol-relative URLs', () => {
    const html = '<a href="https://example.com/article/x">a</a><a href="//cdn.example/article/y">b</a>';
    expect(rewriteInternalLinks(html, opts)).toBe(html);
  });

  it('never touches anchors, mailto or query-only hrefs', () => {
    const html = '<a href="#faq">a</a><a href="mailto:x@y.z">b</a>';
    expect(rewriteInternalLinks(html, opts)).toBe(html);
  });

  it('preserves other attributes on the anchor', () => {
    const out = rewriteInternalLinks('<a class="internal-link" href="/topics/x" data-k="1">t</a>', opts);
    expect(out).toContain('class="internal-link"');
    expect(out).toContain('data-k="1"');
  });

  it('handles single-quoted hrefs', () => {
    expect(rewriteInternalLinks("<a href='/article/x'>t</a>", opts)).toContain('/blog/x');
  });

  it('is a no-op when the prefixes already match the engine defaults', () => {
    const html = '<a href="/article/x">t</a>';
    expect(rewriteInternalLinks(html, { articlePathPrefix: '/article', topicPathPrefix: '/topics' })).toBe(html);
  });

  it('does not rewrite a path that merely starts with the word article', () => {
    const html = '<a href="/articles-index">t</a>';
    expect(rewriteInternalLinks(html, opts)).toBe(html);
  });
});
