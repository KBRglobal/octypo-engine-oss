/**
 * Content domain configuration.
 * The engine is domain-neutral — set CONTENT_DOMAIN to steer all prompts
 * (e.g. "fintech news", "AI and machine learning", "consumer electronics").
 */

export const CONTENT_DOMAIN: string =
  process.env.CONTENT_DOMAIN?.trim() || "general news and analysis";

/**
 * The language every article is written in.
 *
 * The engine used to hard-code English into three prompts, which made it
 * unusable for any customer whose audience does not read English. Stated as a
 * plain language name because that is what a model follows reliably; a code
 * like "de-DE" is not an instruction.
 */
export const CONTENT_LANGUAGE: string = process.env.CONTENT_LANGUAGE?.trim() || "English";

/**
 * The language rule injected into every writing prompt. One sentence, one
 * place, so a new prompt cannot quietly go back to English.
 */
export const LANGUAGE_RULE = `ABSOLUTE RULE: Write ALL content in ${CONTENT_LANGUAGE} only, regardless of the language of the source material or the title. If the source is in another language, work from it but write in ${CONTENT_LANGUAGE}.`;

/**
 * Per-install editorial rules, written by the publisher's own editor — not by
 * us. A publisher's editor decides what every article must contain and must
 * never contain; the engine's job is to carry those rules verbatim into every
 * writing prompt (both the news path and the idea-bank path). Empty means
 * "no publisher rules", and every prompt reads exactly as it did before.
 */
export function editorialRulesBlock(env: NodeJS.ProcessEnv = process.env): string {
  const rules = env.EDITORIAL_RULES?.trim();
  if (!rules) return "";
  return `EDITORIAL RULES FROM THE PUBLISHER — MANDATORY, OVERRIDE ANY CONFLICTING GUIDANCE BELOW:\n${rules}`;
}

/** One page on the publisher's own site the engine is allowed to link to. */
export interface SiteLink {
  path: string;
  label: string;
  /** Extra phrases (beyond the label) whose appearance in a text marks a link opportunity. */
  keywords: string[];
}

/**
 * The publisher's real pages, for internal links. A git-delivered site's pages
 * live outside this engine's database, so without this list the linking
 * engine knows only what it wrote itself. Format, one entry per comma:
 * `/path/=Label`, optionally `/path/=Label|phrase one|phrase two` for extra
 * anchor phrases. Malformed entries are skipped, never thrown.
 */
export function siteLinks(env: NodeJS.ProcessEnv = process.env): SiteLink[] {
  const raw = env.SITE_LINKS?.trim();
  if (!raw) return [];
  const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  const out: SiteLink[] = [];
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const path = clean(entry.slice(0, eq));
    const [label, ...extra] = entry.slice(eq + 1).split("|").map(clean);
    if (!path.startsWith("/") || !label) continue;
    out.push({ path, label, keywords: extra.filter(Boolean) });
  }
  return out;
}

/** The allow-list as a prompt block, or "" when there is none. */
export function siteLinksBlock(env: NodeJS.ProcessEnv = process.env): string {
  const links = siteLinks(env);
  if (links.length === 0) return "";
  return (
    "INTERNAL LINKS — ONLY these pages exist on the publisher's site. Link to them where genuinely relevant, using exactly these paths; never invent any other internal path:\n" +
    links.map(l => `- ${l.path} — ${l.label}`).join("\n")
  );
}

/** One page on a sister site run by the same owner, linked with a full URL. */
export interface SisterLink {
  url: string;
  label: string;
}

/**
 * Pages on the owner's other business site (SISTER_LINKS), so two installs of
 * one owner pass readers and authority to each other. Format, one entry per
 * comma: `https://site/path/=Label`. Only https URLs are accepted.
 */
export function sisterLinks(env: NodeJS.ProcessEnv = process.env): SisterLink[] {
  const raw = env.SISTER_LINKS?.trim();
  if (!raw) return [];
  const clean = (s: string) => s.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  const out: SisterLink[] = [];
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const url = clean(entry.slice(0, eq));
    const label = clean(entry.slice(eq + 1));
    if (!/^https:\/\/[^\s)]+$/.test(url) || !label) continue;
    out.push({ url, label });
  }
  return out;
}

/** The sister-site list as a prompt block, or "" when there is none. */
export function sisterLinksBlock(env: NodeJS.ProcessEnv = process.env): string {
  const links = sisterLinks(env);
  if (links.length === 0) return "";
  const name = env.SISTER_SITE_NAME?.trim() || "the owner's sister company";
  return (
    `SISTER SITE — ${name} belongs to the same owner. Where the reader genuinely needs what it offers, link ONCE in the article to the single most fitting page below, using its full URL and a descriptive anchor. Never more than one sister link, never forced:\n` +
    links.map(l => `- ${l.url} — ${l.label}`).join("\n")
  );
}

/** Optional public site URL (used for IndexNow pings and canonical URLs). */
export const SITE_URL: string | null = process.env.SITE_URL?.replace(/\/$/, "") || null;

/** Brand name used in generated meta titles / schema. */
export const SITE_NAME: string = process.env.SITE_NAME?.trim() || "Octypo";
