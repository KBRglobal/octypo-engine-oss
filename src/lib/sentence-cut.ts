/**
 * Shorten prose without ever cutting a sentence in half.
 *
 * `text.substring(0, 200)` produced a meta description that ended mid-word on
 * a live customer page. A description is either whole sentences or nothing.
 */

// Arabic, Urdu and Devanagari terminators are followed by a space like Latin
// ones; CJK terminators are not, so they end a sentence wherever they stand.
const SENTENCE_END =
  /[.!?…\u061F\u06D4\u0964](?=\s|$)|[.!?]["'”’)]?(?=\s|$)|[\u3002\uFF01\uFF1F]["'”’」』）]?/;

/** Split on sentence terminators, keeping the terminator with its sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest) {
    const m = SENTENCE_END.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    const end = m.index + m[0].length;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return out.filter(Boolean);
}

/**
 * As many whole sentences as fit in `budget` characters. When even the first
 * sentence is too long, returns "" rather than a fragment — the caller must
 * decide what to do with a text that cannot be shortened honestly.
 */
export function firstSentencesWithin(text: string, budget: number): string {
  let out = "";
  for (const sentence of splitSentences(text)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > budget) break;
    out = next;
  }
  return out;
}

/** True when the text ends the way a sentence does. */
export function endsLikeSentence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /[.!?…\u061F\u06D4\u0964\u3002\uFF01\uFF1F]["'”’)」』）]?$/.test(t);
}
