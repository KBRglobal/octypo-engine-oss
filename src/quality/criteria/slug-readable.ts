/**
 * Criterion 13: a slug a person can read.
 *
 * "atrktzih-mdobrt-chozrt-mkom-shmoshk-milionim" is what a mechanical
 * transliteration produces: Latin letters, no vowels, no meaning. The rule is
 * English keywords, 2-8 words, and this criterion is the deterministic half of
 * it: words without vowels or with long consonant
 * runs are transliteration, and the slug is held.
 *
 * `slug` undefined = not supplied (skipped).
 */

import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build, skipped } from "./result.js";

const LABEL = "Readable slug";

const VOWELS = /[aeiouy]/;
const CONSONANT_RUN = /[bcdfghjklmnpqrstvwxz]{4,}/;
/** Short function words and common abbreviations that legitimately lack a vowel. */
const ALLOWED_VOWELLESS = new Set(["vs", "tv", "diy", "faq", "sms", "gps", "pc", "hr", "km", "kg", "rv", "ny", "dj"]);

/**
 * How an English word may begin. A transliteration like "mdobrt" or
 * "shmoshk" opens with a cluster no English word does, and that is the
 * cheapest reliable tell — vowel counts alone let "flights" and "mkom"
 * score the same.
 */
const ENGLISH_ONSETS = new Set([
  "bl", "br", "ch", "cl", "cr", "dr", "dw", "fl", "fr", "gh", "gl", "gn", "gr", "kn", "ph", "pl", "pr", "ps",
  "qu", "rh", "sc", "sh", "sk", "sl", "sm", "sn", "sp", "st", "sw", "th", "tr", "tw", "wh", "wr",
  "sch", "scr", "shr", "spl", "spr", "squ", "str", "thr", "chr", "phr", "sph", "thw",
]);
/** Three-consonant word endings that are English (beyond anything ending in s). */
const ENGLISH_CODAS = new Set(["ght", "nth", "rst", "rth", "nch", "tch", "rch", "lch", "cht", "nct", "mpt", "rld", "rnd"]);
const LEADING_CONSONANTS = /^[bcdfghjklmnpqrstvwxz]+/;
const TRAILING_CONSONANTS = /[bcdfghjklmnpqrstvwxz]+$/;

/** True when a Latin word could plausibly be English rather than a transliteration. */
export function looksEnglish(word: string): boolean {
  const letters = word.replace(/[^a-z]/g, "");
  if (letters.length <= 2 || ALLOWED_VOWELLESS.has(letters)) return true;
  if (!VOWELS.test(letters)) return false;
  const onset = LEADING_CONSONANTS.exec(letters)?.[0] ?? "";
  if (onset.length >= 2 && !ENGLISH_ONSETS.has(onset)) return false;
  const coda = TRAILING_CONSONANTS.exec(letters)?.[0] ?? "";
  if (coda.length >= 3 && !coda.endsWith("s") && !ENGLISH_CODAS.has(coda.slice(-3))) return false;
  // Between onset and coda an English word never stacks four consonants;
  // "flights" is onset + vowel + a plural coda, "atrktzih" is not.
  const interior = letters.slice(onset.length, letters.length - coda.length);
  if (CONSONANT_RUN.test(interior)) return false;
  return true;
}

export interface SlugVerdict {
  ok: boolean;
  words: string[];
  unreadable: string[];
  reason?: string;
}

export function judgeSlug(slug: string): SlugVerdict {
  const cleaned = slug.trim().toLowerCase();
  const words = cleaned.split("-").filter(Boolean);
  if (!cleaned) return { ok: false, words, unreadable: [], reason: "The slug is empty." };
  if (!/^[a-z0-9-]+$/.test(cleaned)) {
    return { ok: false, words, unreadable: [], reason: "The slug must be lowercase Latin letters, digits and hyphens only." };
  }
  const letterWords = words.filter(w => /[a-z]/.test(w));
  if (letterWords.length < 2) {
    return { ok: false, words, unreadable: [], reason: "The slug needs at least two words." };
  }
  if (words.length > 8) {
    return { ok: false, words, unreadable: [], reason: `The slug has ${words.length} words; the maximum is 8.` };
  }
  const unreadable = letterWords.filter(w => !looksEnglish(w));
  // One odd token (a brand, an acronym) is tolerated; two or more is a pattern.
  if (unreadable.length >= 2 || (unreadable.length === 1 && letterWords.length <= 2)) {
    return {
      ok: false,
      words,
      unreadable,
      reason: `These slug words are not readable English: ${unreadable.join(", ")}. Use English keywords, not a transliteration.`,
    };
  }
  return { ok: true, words, unreadable };
}

/** Slug words that are the source's own host label (e.g. "cityherald", "dailywire"). */
export function outletWordsIn(words: string[], sourceUrls: string[]): string[] {
  const labels = new Set<string>();
  for (const url of sourceUrls) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      for (const part of host.split(".")) if (part.length >= 4) labels.add(part);
    } catch {
      // not a URL
    }
  }
  return words.filter(w => labels.has(w));
}

export function scoreSlugReadable(
  input: ArticleQualityInput,
  config: QualityGateConfig
): CriterionResult {
  if (input.slug === undefined) {
    return skipped(config, "slug-readable", LABEL, "No slug was supplied to the scorer.");
  }
  const verdict = judgeSlug(input.slug ?? "");
  // "cityherald-example-com" went live as a slug: the source outlet's domain,
  // not the story. A slug never names where the story was read.
  const outlet = outletWordsIn(verdict.words, input.sourceUrls ?? []);
  if (verdict.ok && outlet.length > 0) {
    return build(config, {
      id: "slug-readable",
      label: LABEL,
      status: "fail",
      score: 0,
      blocking: true,
      details: [`The slug names the source outlet (${outlet.join(", ")}) instead of the topic. Use English keywords for what the article is about.`],
      evidence: { slug: input.slug, outlet },
    });
  }
  return build(config, {
    id: "slug-readable",
    label: LABEL,
    status: verdict.ok ? "pass" : "fail",
    score: verdict.ok ? 1 : 0,
    blocking: true,
    details: [verdict.ok ? `Slug reads as English: ${input.slug}.` : verdict.reason!],
    evidence: { slug: input.slug, unreadable: verdict.unreadable },
  });
}
