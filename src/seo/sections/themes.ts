/**
 * The demand, grouped into things a business could actually write.
 *
 * A list of forty keywords is data; six named themes with a monthly number
 * next to each is a plan, and the plan is what a prospect buys. Nothing here
 * calls an API — it groups phrases the provider already returned, so it costs
 * nothing and cannot invent demand that was not measured.
 *
 * The grouping is deliberately simple. Anything cleverer would need a model,
 * and a model deciding what a client's business is about is the wrong risk on
 * a document we send: a wrong cluster label is a wrong claim in print.
 */

import { significantWords } from "../words.js";

export interface Theme {
  /** The shared word the group is built on, as the market writes it. */
  label: string;
  monthlySearches: number;
  keywords: { keyword: string; volume: number | null }[];
}

/**
 * Words that group nothing.
 *
 * Prepositions and the generic commerce words appear across every phrase in a
 * category, so a theme built on one of them would just be the whole list again
 * under a meaningless name. The list is English; other languages have no
 * curated vocabulary here, and the length floor in `significantWords` is what
 * filters their function words.
 */
const STOPWORDS = new Set([
  "for",
  "the",
  "and",
  "with",
  "best",
  "top",
  "how",
  "what",
  "near",
  "cost",
  "price",
  "prices",
]);

function tokens(phrase: string): string[] {
  return significantWords(phrase).filter((word) => !STOPWORDS.has(word));
}

/**
 * The form a word groups under, given every word seen in this list.
 *
 * One idea arriving as `company` and `companies` must be one theme: grouped as
 * written they become two small ones, each can fall below the minimum and
 * vanish, and the biggest topic in the category does not appear at all.
 *
 * No stemmer, because a wrong merge puts two unrelated topics under one heading
 * in a client's document. Only a Latin-script plural folds, and only when the
 * list itself contains the singular, so the data is the evidence. Every other
 * word groups exactly as written, in any language.
 */
function rootOf(word: string, seen: Set<string>): string {
  if (!/^\p{Script=Latin}+$/u.test(word)) return word;
  if (word.endsWith("ies") && seen.has(`${word.slice(0, -3)}y`)) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && seen.has(word.slice(0, -1))) return word.slice(0, -1);
  return word;
}

export interface ThemeOptions {
  /** A theme needs at least this many phrases to be worth naming. */
  minKeywords?: number;
  maxThemes?: number;
  /** Words already in the seed — they describe every phrase, so they group nothing. */
  seed?: string;
}

/**
 * Group phrases into themes, largest coherent group first.
 *
 * Each phrase joins exactly one theme, so the monthly totals add up to
 * something honest rather than counting the same searches under three
 * headings.
 *
 * Labels are chosen for the whole set at once rather than per phrase. Picking
 * a phrase's "most distinctive word" independently was tried and it shatters
 * the groups: when two candidate words are equally common the choice is
 * arbitrary, so sibling phrases scatter into different themes and each one
 * then falls below the minimum and disappears. Choosing greedily — the word
 * that covers the most phrases still unassigned, ties broken by the demand
 * behind them, then alphabetically so the output never changes between runs —
 * keeps siblings together and is deterministic.
 */
export function buildThemes(
  keywords: { keyword: string; volume: number | null }[],
  options: ThemeOptions = {}
): Theme[] {
  const minKeywords = options.minKeywords ?? 2;
  const maxThemes = options.maxThemes ?? 8;
  const seedWords = options.seed ? tokens(options.seed) : [];

  const remaining = new Set(keywords.map((_, index) => index));

  // Grouping happens on the root, but the heading has to read like something a
  // person would write, so the surface forms behind each root are kept and the
  // most frequent one becomes the label.
  const phraseWords = keywords.map((row) => tokens(row.keyword));
  const seen = new Set([...seedWords, ...phraseWords.flat()]);
  const seedRoots = new Set(seedWords.map((word) => rootOf(word, seen)));
  const surfaceForms = new Map<string, Map<string, number>>();
  const wordsOf = phraseWords.map((phrase) => {
    const roots = new Set<string>();
    for (const word of phrase) {
      const root = rootOf(word, seen);
      if (seedRoots.has(root)) continue;
      roots.add(root);
      const forms = surfaceForms.get(root) ?? new Map<string, number>();
      forms.set(word, (forms.get(word) ?? 0) + 1);
      surfaceForms.set(root, forms);
    }
    return roots;
  });

  /** The spelling to put in the heading: most frequent, then the longer form. */
  const labelFor = (root: string): string => {
    const forms = [...(surfaceForms.get(root) ?? new Map<string, number>()).entries()];
    if (forms.length === 0) return root;
    return forms.sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))[0][0];
  };

  const themes: Theme[] = [];

  while (themes.length < maxThemes) {
    const coverage = new Map<string, number[]>();
    for (const index of remaining) {
      for (const word of wordsOf[index]) {
        const bucket = coverage.get(word);
        if (bucket) bucket.push(index);
        else coverage.set(word, [index]);
      }
    }

    const volumeOf = (indexes: number[]) =>
      indexes.reduce((total, index) => total + (keywords[index].volume ?? 0), 0);

    let best: { word: string; indexes: number[] } | null = null;
    for (const [word, indexes] of coverage) {
      if (indexes.length < minKeywords) continue;
      if (
        !best ||
        indexes.length > best.indexes.length ||
        (indexes.length === best.indexes.length &&
          (volumeOf(indexes) > volumeOf(best.indexes) ||
            (volumeOf(indexes) === volumeOf(best.indexes) && word < best.word)))
      ) {
        best = { word, indexes };
      }
    }

    if (!best) break;

    for (const index of best.indexes) remaining.delete(index);
    themes.push({
      label: labelFor(best.word),
      monthlySearches: best.indexes.reduce(
        (total, index) => total + (keywords[index].volume ?? 0),
        0
      ),
      keywords: best.indexes
        .map((index) => keywords[index])
        .sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1)),
    });
  }

  return themes.sort((a, b) => b.monthlySearches - a.monthlySearches);
}
