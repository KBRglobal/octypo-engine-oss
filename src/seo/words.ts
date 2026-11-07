/**
 * Splitting a search phrase into words, for any language.
 *
 * Word boundaries come from the runtime's Unicode segmenter rather than from a
 * list of separators. That is what keeps an apostrophe or an in-word quote
 * inside its word, and what finds the words in scripts that do not write
 * spaces between them.
 */

const segmenter = new Intl.Segmenter("und", { granularity: "word" });

/** Scripts where two characters are already a whole word. */
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Every word in the phrase, normalised and lowercased, in order. */
export function words(phrase: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(phrase.normalize("NFKC").toLowerCase())) {
    if (part.isWordLike) out.push(part.segment);
  }
  return out;
}

/**
 * The words long enough to mean something on their own.
 *
 * Shorter tokens are mostly function words, and matching on them would let
 * anything through. Dense scripts pack more into a character, so the bar is
 * lower there.
 */
export function significantWords(phrase: string): string[] {
  return words(phrase).filter((word) => word.length >= (DENSE_SCRIPT.test(word) ? 2 : 3));
}
