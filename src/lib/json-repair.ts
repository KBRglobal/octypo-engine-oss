/**
 * Makes a model's near-JSON parseable.
 *
 * A writer producing a 2,000-word article inside a JSON object hits the same
 * wall every time: prose contains literal newlines, and a literal newline
 * inside a JSON string is invalid. The model is not wrong about the article —
 * it is wrong about one escape — and throwing the whole article away over it
 * costs a full regeneration.
 *
 * The repair is deliberately narrow. It walks the text once, tracking whether
 * it is inside a string, and escapes only the control characters that JSON
 * forbids there. It never rewrites structure, never guesses at missing braces,
 * and never touches anything outside a string literal — a repair that invents
 * structure would turn a parse error into silently wrong content, which is far
 * worse than a retry.
 */

/** JSON forbids raw control characters (U+0000–U+001F) inside a string. */
const ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }

    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      out += char;
      continue;
    }

    const replacement = ESCAPES[char];
    if (replacement) {
      out += replacement;
    } else if (char < " ") {
      out += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }

  return out;
}

/**
 * Escape a double quote that a model left unescaped inside a string.
 *
 * Prose in many languages uses straight quotes constantly, and a model writing
 * a long article inside a JSON string forgets to escape them. The rule that
 * makes this safe: inside a string, a `"` genuinely closes it only when the
 * next non-whitespace character is one of `,` `}` `]` `:` — anything else means
 * the quote was part of the sentence.
 *
 * Applied only after the plainer repairs fail, because it is a heuristic and a
 * heuristic that runs on healthy input eventually corrupts something.
 */
export function escapeInnerQuotes(text: string): string {
  const CLOSERS = new Set([",", "}", "]", ":"]);
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }

    if (escaped) {
      escaped = false;
      out += char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (next === undefined || CLOSERS.has(next)) {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += char;
  }

  return out;
}

/**
 * Parse, repairing only if the first attempt fails.
 *
 * Clean output is never touched, so a well-behaved model costs nothing and
 * cannot be corrupted by the repair.
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (firstError) {
    const escaped = escapeControlCharsInStrings(text);
    try {
      return JSON.parse(escaped) as T;
    } catch {
      try {
        return JSON.parse(escapeInnerQuotes(escaped)) as T;
      } catch {
        // Report the original failure: it points at the real position in the
        // text the caller actually has.
        throw firstError;
      }
    }
  }
}
