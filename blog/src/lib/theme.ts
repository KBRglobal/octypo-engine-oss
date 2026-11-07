/**
 * Theming is data, never code.
 *
 * A customer's brand lives as a JSONB column on their tenant row and is
 * rendered into CSS custom properties in <head> on every request. Changing an
 * accent colour is therefore an admin field edit that goes live on the next
 * purge — no rebuild, no deploy, and no per-customer fork of the theme. Every
 * stylesheet in the blog references only `var(--octypo-*)`.
 *
 * Everything here is attacker-adjacent: `brand` and `customCss` are edited
 * through the admin panel and injected into a <style> element on a page that
 * carries the customer's own domain. Values that could close the declaration,
 * close the element, or pull a remote stylesheet are dropped, not escaped —
 * there is no legitimate brand value that needs them.
 */

export interface Brand {
  accent?: string;
  accentContrast?: string;
  background?: string;
  surface?: string;
  text?: string;
  muted?: string;
  fontBody?: string;
  fontHeading?: string;
  radius?: string;
  logoUrl?: string;
  customCss?: string;
  [key: string]: unknown;
}

const VARIABLE_MAP: Record<string, string> = {
  accent: '--octypo-accent',
  accentContrast: '--octypo-accent-contrast',
  background: '--octypo-background',
  surface: '--octypo-surface',
  text: '--octypo-text',
  muted: '--octypo-muted',
  fontBody: '--octypo-font-body',
  fontHeading: '--octypo-font-heading',
  radius: '--octypo-radius',
};

const MAX_VALUE_LENGTH = 160;
const MAX_CUSTOM_CSS = 20_000;

/** Anything that can escape a declaration, open an at-rule, or fetch a resource. */
const UNSAFE_VALUE = /[;{}<>\\]|@|url\s*\(|expression\s*\(|javascript\s*:|\/\*|\*\//i;

function safeValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_VALUE_LENGTH) return null;
  if (UNSAFE_VALUE.test(value)) return null;
  return value;
}

export function brandToCssVariables(brand: Brand | null | undefined): string {
  if (!brand) return '';
  const declarations: string[] = [];
  for (const [field, property] of Object.entries(VARIABLE_MAP)) {
    const value = safeValue(brand[field]);
    if (value) declarations.push(`  ${property}: ${value};`);
  }
  return declarations.join('\n');
}

export function sanitizeCustomCss(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  let css = raw.slice(0, MAX_CUSTOM_CSS);

  // No markup at all: the only place this lands is inside a <style> element.
  css = css.replace(/[<>]/g, '');
  // At-rules that fetch (@import) or escape context (@charset, @namespace).
  css = css.replace(/@(import|charset|namespace)[^;]*;?/gi, '');
  css = css.replace(/expression\s*\(/gi, '');
  css = css.replace(/(javascript|vbscript|data)\s*:/gi, '');
  // url() may only reference this origin. A remote one is a tracking beacon at
  // best and a stylesheet-borne exfiltration channel at worst.
  css = css.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote: string, target: string) => {
    const value = target.trim();
    return value.startsWith('/') && !value.startsWith('//') ? match : '';
  });

  return css.trim();
}

/** The single <style> element the layout injects into <head>. */
export function renderThemeStyle(brand: Brand | null | undefined): string {
  const variables = brandToCssVariables(brand);
  const custom = sanitizeCustomCss(brand?.customCss);
  if (!variables && !custom) return '';

  const parts: string[] = [];
  // `:root:root` is deliberate. The default stylesheet also defines these
  // variables on `:root`, so at equal specificity the winner depends on which
  // block the bundler happens to emit last — and it was emitting the defaults,
  // silently discarding every customer's brand. Doubling the selector wins
  // regardless of order without resorting to !important.
  if (variables) parts.push(`:root:root {\n${variables}\n}`);
  if (custom) parts.push(custom);
  return `<style>${parts.join('\n')}</style>`;
}
