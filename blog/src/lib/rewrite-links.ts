/**
 * The engine's internal-linking engine writes hrefs against path prefixes the
 * blog does not serve: `/topics/<slug>` (internal-linking-engine.ts:350) and
 * `/article/<slug>` | `/guide/<slug>` | `/review/<slug>` from the DB-backed
 * link targets (internal-linking-engine.ts:411-415). A Scale tenant gets 5-8 of
 * these per article, so getting this wrong ships thousands of 404s that no
 * build step and no test in the engine would ever surface.
 */

export interface RewriteOptions {
  articlePathPrefix: string;
  topicPathPrefix: string;
}

/** `blog/` → `/blog`, `/` → `""`. A blog mounted at the root has no prefix. */
export function normalisePrefix(prefix: string): string {
  const trimmed = (prefix || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const ENGINE_ARTICLE_PREFIXES = ['/article', '/guide', '/review'] as const;
const ENGINE_TOPIC_PREFIX = '/topics';

function rewriteHref(href: string, opts: RewriteOptions): string {
  // Only root-relative single-slash paths are ours; "//cdn" is protocol-relative.
  if (!href.startsWith('/') || href.startsWith('//')) return href;

  const article = normalisePrefix(opts.articlePathPrefix);
  const topic = normalisePrefix(opts.topicPathPrefix);

  if (href === ENGINE_TOPIC_PREFIX || href.startsWith(`${ENGINE_TOPIC_PREFIX}/`)) {
    return `${topic}${href.slice(ENGINE_TOPIC_PREFIX.length)}`;
  }

  for (const enginePrefix of ENGINE_ARTICLE_PREFIXES) {
    if (href.startsWith(`${enginePrefix}/`)) {
      return `${article}${href.slice(enginePrefix.length)}`;
    }
  }

  return href;
}

/** Rewrite every engine-authored internal href in a fragment of article HTML. */
export function rewriteInternalLinks(html: string, opts: RewriteOptions): string {
  if (!html) return html;
  return html.replace(
    /(<a\b[^>]*?\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (match, lead: string, _quoted: string, dq?: string, sq?: string) => {
      const raw = dq ?? sq ?? '';
      const next = rewriteHref(raw, opts);
      if (next === raw) return match;
      const quote = dq !== undefined ? '"' : "'";
      return `${lead}${quote}${next}${quote}`;
    }
  );
}
