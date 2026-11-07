/**
 * English slugs for articles written in any language.
 *
 * Rankings do not care about slug script, but a non-Latin slug percent-encodes
 * into gibberish the moment it is copied into a chat app or an email. New
 * articles therefore get a short English slug by default; already-published
 * slugs stay untouched (changing them would only churn redirects).
 *
 * The writer prompt still asks for a slug in the article's language; this
 * module deliberately overrides the outcome after generation. SLUG_STYLE=native
 * keeps the per-locale slug for an operator who wants native-script URLs.
 */

import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { logger } from "../lib/logger.js";

const TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You write the URL slug for an article.

Rules:
- 3 to 6 English words, lowercase, joined by hyphens.
- Real English words describing the article's topic — never a transliteration
  of another language, never a brand name, never filler words (the, a, of, for
  are allowed only when dropping them harms meaning).
- No dates, no stray numbers unless the number is the subject (e.g. a price
  guide year).
- Return ONLY the slug. No quotes, no explanation, no leading slash.`;

/** Style switch: "english" (default) | "native" (per-locale slug). */
export function slugStyle(env: NodeJS.ProcessEnv = process.env): "english" | "native" {
  return (env.SLUG_STYLE ?? "").trim().toLowerCase() === "native" ? "native" : "english";
}

/** Strict shape gate — anything else falls back to the native slug path. */
export function sanitiseEnglishSlug(raw: string): string | null {
  const cleaned = raw
    .toLowerCase()
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return null;
  const words = cleaned.split("-").filter(Boolean);
  if (words.length < 2 || words.length > 7) return null;
  if (cleaned.length > 60) return null;
  return words.join("-");
}

export type SlugTranslator = (title: string, keyword: string) => Promise<string | null>;

/**
 * Ask whichever engine is healthy for an English slug. Returns null on any
 * failure — the caller then keeps the previous native-slug behavior, so an
 * article is never lost to a slug.
 */
export async function englishSlug(
  title: string,
  keyword: string,
  translator?: SlugTranslator
): Promise<string | null> {
  if (translator) {
    const out = await translator(title, keyword);
    return out ? sanitiseEnglishSlug(out) : null;
  }
  if (EngineRegistry.getEngineCount() === 0) return null;

  const tried = new Set<string>();
  for (let attempt = 0; attempt < Math.max(EngineRegistry.getEngineCount(), 1); attempt++) {
    const engine = preferFast(tried);
    if (!engine) break;
    tried.add(engine.id);
    if (!engine.isHealthy) continue;

    try {
      const response = await Promise.race([
        generateWithEngine(engine, SYSTEM_PROMPT, `Article title: ${title}\nPrimary keyword: ${keyword}`),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("english slug timeout")), TIMEOUT_MS)
        ),
      ]);
      EngineRegistry.reportSuccess(engine.id);
      const slug = sanitiseEnglishSlug(response ?? "");
      if (slug) {
        logger.info({ title, slug }, "[Slug] English slug generated");
        return slug;
      }
      return null;
    } catch (error) {
      EngineRegistry.reportError(engine.id, error instanceof Error ? error.message : "Unknown");
    }
  }
  return null;
}

/** Helper calls ride the cheap tier when one is configured (see query-language.ts). */
function preferFast(tried: Set<string>) {
  const fast = EngineRegistry.getFastEngine();
  if (fast && !tried.has(fast.id) && fast.isHealthy) return fast;
  return EngineRegistry.getNextFromQueue(tried);
}
