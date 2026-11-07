/**
 * Which searches are customers, and which are not.
 *
 * "event production" and "event production jobs" sit next to each other in the
 * same keyword set with similar volumes, and one of them is a customer while
 * the other is someone looking for a job. A third group is studying the trade:
 * "event production course", often with a named teacher attached.
 *
 * This matters twice over. In the work list those phrases become pages a
 * business would be mad to write. In the document they inflate the headline —
 * measured on a real prospect, 810 of 5,340 "searches in your category" were
 * job seekers and students, and a number shown to a client has to be the
 * market they can actually sell to.
 *
 * DataForSEO's own `intent` field does not separate them: a course is a
 * commercial search, just for somebody else's product. So the split is made
 * on the words people use, which is crude but checkable and never silent —
 * what was removed is reported alongside what was kept.
 *
 * The vocabulary is English. A phrase in a language with no list is treated as
 * a customer: the headline is then a little generous, which is safer than
 * dropping real demand on a guess.
 */

import { words } from "../words.js";

/** Someone looking for work, not for a supplier. */
const EMPLOYMENT = [
  "jobs",
  "job",
  "career",
  "careers",
  "salary",
  "salaries",
  "hiring",
  "vacancy",
  "vacancies",
  "intern",
  "internship",
  "resume",
  "cv",
];

/** Someone learning the trade, not buying it. */
const STUDY = [
  "course",
  "courses",
  "training",
  "diploma",
  "degree",
  "school",
  "college",
  "student",
  "students",
  "certificate",
  "certification",
  "lesson",
  "lessons",
  "tutorial",
  "guide for beginners",
];

export type NonBuyerReason = "employment" | "study";

/**
 * Why this phrase is not a customer, or null when it is one.
 *
 * Matching is on whole words, not substrings: `course` must be its own word,
 * so a phrase that merely contains those letters inside a longer word is left
 * alone. Multi-word markers are checked against the phrase itself.
 */
export function nonBuyerReason(keyword: string): NonBuyerReason | null {
  const phrase = keyword.toLowerCase();
  const tokens = new Set(words(keyword));

  const hits = (markers: string[]) =>
    markers.some((marker) =>
      marker.includes(" ") ? phrase.includes(marker) : tokens.has(marker)
    );

  if (hits(EMPLOYMENT)) return "employment";
  if (hits(STUDY)) return "study";
  return null;
}

export function isBuyerPhrase(keyword: string): boolean {
  return nonBuyerReason(keyword) === null;
}

export interface BuyerSplit<T> {
  buyers: T[];
  /** Kept rather than discarded: the operator is told what was removed. */
  removed: { keyword: string; reason: NonBuyerReason }[];
}

/** Split a keyword set into the market and the people who are not in it. */
export function splitBuyers<T extends { keyword: string }>(rows: T[]): BuyerSplit<T> {
  const buyers: T[] = [];
  const removed: { keyword: string; reason: NonBuyerReason }[] = [];

  for (const row of rows) {
    const reason = nonBuyerReason(row.keyword);
    if (reason) removed.push({ keyword: row.keyword, reason });
    else buyers.push(row);
  }

  return { buyers, removed };
}
