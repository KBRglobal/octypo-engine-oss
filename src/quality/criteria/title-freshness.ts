/**
 * Criterion 11: the title must not carry a year that is already over.
 *
 * "When does the 2025-2026 season open" went live in September 2026. The
 * writer had no clock; this criterion has one. Any year or season range in
 * the title / meta title whose LAST year is before the current year is a
 * blocking failure — a stale year in the headline tells the reader the page is
 * old before they read a word, and no other criterion can compensate for it.
 *
 * Deterministic given `input.now` (defaults to the real clock so production
 * behaves; tests pin it).
 */

import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Title freshness";

/** A season range like 2025-2026, 2025/26, 2025–2026 — or a single year. */
const RANGE_RE = /\b(19|20)(\d{2})\s*[-–—\/]\s*(?:(19|20))?(\d{2})\b/g;
const YEAR_RE = /\b(19|20)\d{2}\b/g;
/**
 * A lone four-digit number is a year only inside a plausible window: "2000
 * words" and "1200 euros" are counts, and a headline about 1998 is history,
 * not a stale edition. Ranges are always seasons.
 */
const OLDEST_LONE_YEAR = 2010;
const FURTHEST_LONE_YEAR_AHEAD = 5;

/** The years the text refers to, with a range collapsed to its last year. */
export function referencedYears(text: string, now: Date = new Date()): number[] {
  const maxLone = now.getUTCFullYear() + FURTHEST_LONE_YEAR_AHEAD;
  const years: number[] = [];
  const consumed: Array<[number, number]> = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const start = Number(`${m[1]}${m[2]}`);
    const endCentury = m[3] ?? m[1];
    const end = Number(`${endCentury}${m[4]}`);
    // "2025-2026" is a season; "2025-10" is not a range of years.
    if (end >= start && end - start <= 2) {
      years.push(end);
      consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    }
  }
  for (const m of text.matchAll(YEAR_RE)) {
    const at = m.index ?? 0;
    if (consumed.some(([a, b]) => at >= a && at < b)) continue;
    const year = Number(m[0]);
    if (year >= OLDEST_LONE_YEAR && year <= maxLone) years.push(year);
  }
  return years;
}

export function scoreTitleFreshness(
  input: ArticleQualityInput,
  config: QualityGateConfig
): CriterionResult {
  const now = input.now ?? new Date();
  const currentYear = now.getUTCFullYear();
  const fields: Array<[string, string]> = [
    ["title", input.title ?? ""],
    ["h1", input.h1 ?? ""],
    ["metaTitle", input.metaTitle ?? ""],
  ];

  const stale: string[] = [];
  let mentioned = 0;
  for (const [name, text] of fields) {
    if (!text) continue;
    const years = referencedYears(text, now);
    mentioned += years.length;
    const old = years.filter(y => y < currentYear);
    if (old.length > 0) stale.push(`${name} refers to ${[...new Set(old)].join(", ")} but the current year is ${currentYear}`);
  }

  if (stale.length > 0) {
    return build(config, {
      id: "title-freshness",
      label: LABEL,
      status: "fail",
      score: 0,
      blocking: true,
      details: stale.map(s => `${s} — a past year in the headline reads as an old page.`),
      evidence: { currentYear, stale },
    });
  }

  return build(config, {
    id: "title-freshness",
    label: LABEL,
    status: "pass",
    score: 1,
    details: [mentioned > 0 ? `Every year in the title is ${currentYear} or later.` : "The title carries no year."],
    evidence: { currentYear },
  });
}
