import { describe, it, expect } from 'vitest';

import { sanitizeHtml as engineSanitize } from '../../../src/lib/sanitize-html.js';
import { sanitizeHtml, sanitizeText } from './sanitize';

// Rows written before the engine started sanitising (commit 778fc89) and rows
// saved through the admin editor were never cleaned. The blog is the last line
// of defence on a customer's own domain, so it must not trust the engine.
const HOSTILE = [
  '<p>ok</p><script>alert(1)</script>',
  '<script src="//evil">x</script><p>after</p>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="java	script:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href="data:text/html;base64,PHN2Zz4=">x</a>',
  '<img src=x onerror=alert(1)>',
  '<p onclick="alert(1)">hi</p>',
  '<iframe src="//evil"></iframe>',
  '<!--[if IE]><script>alert(1)</script><![endif]-->',
  '<style>body{background:url(javascript:alert(1))}</style><p>p</p>',
  '<p>5 < 6 and 7 > 2</p>',
  '<a href="https://ok.example/x">fine</a>',
  '<a href="/topics/deposits" class="internal-link">deposits</a>',
  '<ul><li>a</li><li>b</li></ul>',
  '<blockquote>quoted</blockquote>',
  '',
];

describe('blog sanitizeHtml', () => {
  it('strips script tags and their contents', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).not.toContain('script');
    expect(out).toContain('ok');
  });

  it('drops javascript: hrefs but keeps the anchor text', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript');
    expect(out).toContain('click');
  });

  it('survives a control-character scheme bypass', () => {
    const out = sanitizeHtml('<a href="java	script:alert(1)">click</a>');
    expect(out).not.toMatch(/href=/);
  });

  it('keeps root-relative internal links so topic hubs still resolve', () => {
    const out = sanitizeHtml('<a href="/topics/deposits" class="internal-link">deposits</a>');
    expect(out).toContain('href="/topics/deposits"');
  });

  it('does not eat prose containing bare angle brackets', () => {
    expect(sanitizeHtml('<p>5 < 6 and 7 > 2</p>')).toContain('5 &lt; 6 and 7 &gt; 2');
  });

  it('strips event handler attributes', () => {
    expect(sanitizeHtml('<p onclick="alert(1)">hi</p>')).toBe('<p>hi</p>');
  });

  // The blog ships as a standalone npm package, so it carries its own copy of
  // the allowlist. Duplication is only safe while the two agree — this is the
  // test that catches drift after somebody hardens one side and not the other.
  it('agrees with the engine sanitiser on every hostile input', () => {
    for (const input of HOSTILE) {
      expect(sanitizeHtml(input), `input: ${input}`).toBe(engineSanitize(input));
    }
  });
});

describe('blog sanitizeText', () => {
  it('removes markup that would break out of a JSON-LD script block', () => {
    expect(sanitizeText('Deposits </script><script>x</script>')).toBe('Deposits x');
  });

  it('returns empty string for non-strings', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
  });
});
