/**
 * Render-time HTML sanitiser for the Octypo blog.
 *
 * The engine sanitises on write (src/lib/sanitize-html.ts), but two classes of
 * row are not covered: articles stored before that landed, and anything saved
 * through the admin editor's PUT path. The blog renders with `set:html` on a
 * paying customer's own domain, so trusting the engine's word is not a defence
 * we can offer them. This is a deliberate second pass.
 *
 * It is a vendored copy rather than an import because the blog is published as
 * a standalone package with no engine code in it. `sanitize.test.ts` asserts
 * byte-identical output against the engine implementation so the copies cannot
 * drift apart unnoticed.
 */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'h2', 'h3', 'h4',
  'blockquote', 'code', 'pre',
  'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href']),
};

const VOID_CONTENT_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript'];

const CONTROL_CHARS = /[\x00-\x1F]/g;

function safeHref(value: string): string | null {
  const trimmed = value.trim();
  // Control characters are stripped first because `java\tscript:` is a real bypass.
  const normalised = trimmed.replace(CONTROL_CHARS, '').toLowerCase();
  if (/^(javascript|vbscript|data|file|blob):/i.test(normalised)) return null;
  if (/^(https:\/\/|\/\/|\/|#|mailto:)/i.test(normalised)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalised)) return null;
  return trimmed;
}

function escapeText(s: string): string {
  return s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sanitizeHtml(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '';

  let html = input;

  for (const tag of VOID_CONTENT_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, 'gi'), '');
  }
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  const out: string[] = [];
  const open: string[] = [];
  // Split only on things that actually look like tags: splitting on any "<...>"
  // ate real prose such as "5 < 6 and 7 > 2".
  const tokens = html.split(/(<\/?[a-zA-Z][^>]*>)/);

  for (const token of tokens) {
    if (!token) continue;

    if (!token.startsWith('<')) {
      out.push(escapeText(token));
      continue;
    }

    const closing = /^<\s*\//.test(token);
    const nameMatch = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(token);
    const name = nameMatch?.[1]?.toLowerCase();

    if (!name || !ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      const idx = open.lastIndexOf(name);
      if (idx === -1) continue;
      while (open.length > idx) out.push(`</${open.pop()}>`);
      continue;
    }

    const attrs: string[] = [];
    const allowed = ALLOWED_ATTRS[name];
    if (allowed) {
      const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(token)) !== null) {
        const attr = (m[1] ?? '').toLowerCase();
        if (!allowed.has(attr)) continue;
        const raw = m[3] ?? m[4] ?? '';
        if (attr === 'href') {
          const href = safeHref(raw);
          if (href === null) continue;
          attrs.push(`href="${escapeText(href).replace(/"/g, '&quot;')}"`);
          attrs.push('rel="noopener noreferrer"');
        }
      }
    }

    const selfClosing = name === 'br' || /\/\s*>$/.test(token);
    if (selfClosing) {
      out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''} />`);
      continue;
    }

    out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    open.push(name);
  }

  while (open.length) out.push(`</${open.pop()}>`);

  return out.join('');
}

/** Plain-text fields (titles, meta) must carry no markup: they land in <title> and JSON-LD. */
export function sanitizeText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/<[^>]*>/g, '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** Escape a value for interpolation into an HTML attribute or text node. */
export function escapeHtml(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
