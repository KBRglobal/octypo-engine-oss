import { describe, it, expect } from 'vitest';

import { brandToCssVariables, sanitizeCustomCss, renderThemeStyle } from './theme';

describe('brandToCssVariables', () => {
  it('renders known brand fields as octypo custom properties', () => {
    const css = brandToCssVariables({ accent: '#ff0055', background: '#ffffff', radius: '12px' });
    expect(css).toContain('--octypo-accent: #ff0055');
    expect(css).toContain('--octypo-background: #ffffff');
    expect(css).toContain('--octypo-radius: 12px');
  });

  it('omits fields the tenant has not set, so the stylesheet defaults win', () => {
    expect(brandToCssVariables({ accent: '#000' })).not.toContain('--octypo-background');
  });

  it('ignores unknown brand keys rather than emitting arbitrary properties', () => {
    expect(brandToCssVariables({ evil: 'x' } as never)).not.toContain('evil');
  });

  // brand is a JSONB column an admin edits. A value that can close the
  // declaration can inject arbitrary CSS into every page of the site.
  it('drops a value that tries to break out of the declaration', () => {
    const css = brandToCssVariables({ accent: 'red; } body { display:none } .x {' });
    expect(css).not.toContain('display:none');
  });

  it('drops a value containing a url() or an @rule', () => {
    expect(brandToCssVariables({ background: 'url(//evil/x.png)' })).toBe('');
    expect(brandToCssVariables({ accent: '@import url(//evil)' })).toBe('');
  });

  it('drops a value containing a closing style tag', () => {
    expect(brandToCssVariables({ accent: '</style><script>alert(1)</script>' })).toBe('');
  });

  it('accepts the font stacks a real brand needs, quotes and commas included', () => {
    const css = brandToCssVariables({ fontBody: '"Inter", system-ui, sans-serif' });
    expect(css).toContain('--octypo-font-body: "Inter", system-ui, sans-serif');
  });
});

describe('sanitizeCustomCss', () => {
  it('strips @import, which would pull a stylesheet from any host', () => {
    expect(sanitizeCustomCss('@import url(//evil/x.css); .a { color: red }')).not.toContain('@import');
  });

  it('strips javascript: and expression() payloads', () => {
    expect(sanitizeCustomCss('.a { background: url(javascript:alert(1)) }')).not.toContain('javascript:');
    expect(sanitizeCustomCss('.a { width: expression(alert(1)) }')).not.toContain('expression(');
  });

  it('strips any markup that would close the style element', () => {
    const out = sanitizeCustomCss('.a{}</style><script>alert(1)</script>');
    expect(out).not.toContain('<');
  });

  it('strips a remote url() but keeps a same-origin one', () => {
    expect(sanitizeCustomCss('.a { background: url(//evil/x.png) }')).not.toContain('//evil');
    expect(sanitizeCustomCss('.a { background: url(/assets/x.png) }')).toContain('/assets/x.png');
  });

  it('keeps ordinary declarations intact', () => {
    expect(sanitizeCustomCss('.octypo-hero { border-radius: 12px; color: #123 }')).toContain('border-radius: 12px');
  });

  it('caps the size, so a pasted megabyte does not ship on every page', () => {
    expect(sanitizeCustomCss('a{}'.repeat(50_000)).length).toBeLessThanOrEqual(20_000);
  });

  it('returns empty for non-strings', () => {
    expect(sanitizeCustomCss(undefined)).toBe('');
    expect(sanitizeCustomCss(null)).toBe('');
  });
});

describe('renderThemeStyle', () => {
  it('emits a single style element carrying both variables and custom css', () => {
    const html = renderThemeStyle({ accent: '#f0f', customCss: '.a { color: red }' });
    expect(html.startsWith('<style>')).toBe(true);
    expect(html).toContain('--octypo-accent: #f0f');
    expect(html).toContain('color: red');
    expect(html.endsWith('</style>')).toBe(true);
  });

  it('emits nothing when the tenant has no brand at all', () => {
    expect(renderThemeStyle({})).toBe('');
  });

  it('cannot be made to close its own style element', () => {
    const html = renderThemeStyle({ customCss: 'a{}</style><script>x</script>' });
    expect(html.match(/<\/style>/g)?.length).toBe(1);
  });
});
