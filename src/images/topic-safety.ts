/**
 * Subjects that must never be auto-illustrated with stock photography.
 *
 * This is a licence requirement, not a style preference. Pixabay's Prohibited
 * Uses forbid using their content "in a political context (such as the
 * promotion, advertisement or endorsement of any party, candidate, or elected
 * official or in connection with any political party or viewpoint)" and in any
 * way "which portrays someone as suffering from, or medicating for, a physical
 * or mental ailment". Pexels forbids showing identifiable people "in a bad
 * light".
 *
 * With no human reviewing images before they publish on a customer's site, the
 * only way to honour those clauses is to refuse automatically. When a topic
 * trips this check the pipeline falls back to generation (an image we own, with
 * no third-party licence attached) or publishes with no image at all — either
 * is preferable to a licence breach on a client's domain.
 *
 * The term list is English. A non-Latin topic is judged here too but only
 * matches once translated: the stock provider re-checks the English query it
 * gets for such a topic before searching.
 */

export type ImageSafetyVerdict =
  | { safe: true }
  | { safe: false; reason: string; category: SensitiveCategory };

export type SensitiveCategory = "political" | "medical" | "adult" | "dating" | "tragedy";

interface Rule {
  category: SensitiveCategory;
  reason: string;
  // Word-boundary matched, so "election" does not fire on "selection" and
  // "drug" does not fire on "drugstore chain" — false positives here silently
  // cost the customer an image on a legitimate article.
  terms: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    category: "political",
    reason: "Pixabay forbids use in a political context — party, candidate, elected official or viewpoint",
    terms: [
      "election", "elections", "electoral", "candidate", "candidates",
      "political", "politics", "politician", "politicians", "parliament",
      "senate", "congress", "campaign trail", "ballot", "voting", "voter",
      "referendum", "coalition", "minister", "president",
      "prime minister", "mayor", "protest", "demonstration",
    ],
  },
  {
    category: "medical",
    reason: "Pixabay forbids portraying a person as suffering from or medicating for an ailment",
    terms: [
      "disease", "illness", "diagnosis", "symptom", "symptoms", "patient",
      "patients", "cancer", "diabetes", "depression", "anxiety disorder",
      "mental illness", "medication", "prescription", "therapy", "treatment",
      "surgery", "hospital ward", "addiction", "rehab", "disability",
    ],
  },
  {
    category: "adult",
    reason: "Stock licences prohibit adult, obscene or offensive contexts",
    terms: [
      "pornography", "porn", "adult entertainment", "escort", "strip club",
      "nudity", "sexual", "erotic",
    ],
  },
  {
    category: "dating",
    reason: "Stock licences call out dating services as a prohibited context",
    terms: ["dating service", "dating app", "hookup", "matchmaking service"],
  },
  {
    category: "tragedy",
    reason: "Identifiable people must not appear in a bad light; disaster coverage risks exactly that",
    terms: [
      "funeral", "death toll", "fatality", "fatalities", "casualty", "casualties",
      "terror attack", "shooting", "massacre", "war crime", "genocide",
      "disaster victim", "refugee crisis",
    ],
  },
];

function containsTerm(haystack: string, term: string): boolean {
  // \b is ASCII-only, so a term in another script falls back to a plain
  // substring test.
  if (!/^[\x20-\x7F]+$/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Judges the ARTICLE's subject, not the image. Pass whatever identifies the
 * topic — title, primary keyword, tags — since the decision is about the
 * context the image will appear in.
 */
export function checkImageTopicSafety(...parts: (string | null | undefined)[]): ImageSafetyVerdict {
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  if (!haystack.trim()) return { safe: true };

  for (const rule of RULES) {
    for (const term of rule.terms) {
      if (containsTerm(haystack, term.toLowerCase())) {
        return { safe: false, reason: rule.reason, category: rule.category };
      }
    }
  }
  return { safe: true };
}

export { RULES as SENSITIVE_TOPIC_RULES };
