/**
 * Text direction for a site, derived from its language tag.
 *
 * `Intl.Locale.maximize()` fills in the likely script for a bare language code
 * (CLDR data, not a list kept here), so the rule covers every right-to-left
 * language at once, and an explicit script subtag such as `az-Arab` wins over
 * the language's usual script. Only scripts are listed: they are a closed set
 * from ISO 15924, where languages are not.
 */

const RTL_SCRIPTS = new Set([
  "Adlm", "Arab", "Aran", "Armi", "Avst", "Chrs", "Cprt", "Elym", "Hatr", "Hebr",
  "Hung", "Khar", "Lydi", "Mand", "Mani", "Mend", "Merc", "Mero", "Narb", "Nbat",
  "Nkoo", "Orkh", "Palm", "Phli", "Phlp", "Phnx", "Prti", "Rohg", "Samr", "Sarb",
  "Sogd", "Sogo", "Syrc", "Thaa", "Yezi",
]);

export type TextDirection = "ltr" | "rtl";

/** An unparseable tag reads as "ltr": it is the browser default for no `dir` at all. */
export function textDirection(language: string): TextDirection {
  try {
    const { script } = new Intl.Locale(language.trim()).maximize();
    return script && RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}
