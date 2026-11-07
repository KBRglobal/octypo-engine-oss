/**
 * Criterion 5: the hero image and, more importantly, its alt text.
 *
 * "Alt text exists" is not the bar — the engine can always produce a string.
 * The bar is that the string describes this article, so the check compares it
 * against the article's own topic and rejects the three ways generated alt text
 * actually fails: empty, the filename echoed back, and boilerplate.
 */

import { normalize, significantTokens, wordCount } from "../text.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Hero image and alt text";

const GENERIC_ALT = new Set([
  "image", "images", "photo", "photos", "picture", "pictures", "hero", "hero image",
  "featured image", "article image", "cover image", "banner", "illustration", "graphic",
  "stock photo", "thumbnail", "photograph", "img", "placeholder", "untitled",
]);

/** The bare filename with separators turned back into spaces. */
function filenameWords(url: string): string {
  const path = url.split(/[?#]/)[0];
  const base = path.substring(path.lastIndexOf("/") + 1).replace(/\.[a-z0-9]+$/i, "");
  return normalize(base.replace(/[-_]+/g, " "));
}

export function scoreHeroImage(
  input: ArticleQualityInput,
  config: QualityGateConfig
): CriterionResult {
  const url = (input.heroImage ?? "").trim();
  const alt = (input.heroImageAlt ?? "").trim();
  const details: string[] = [];

  if (!/^https?:\/\//i.test(url)) {
    return build(config, {
      id: "hero-image",
      label: LABEL,
      status: "fail",
      score: 0,
      details: [url ? `Hero image URL is not http(s): "${url}".` : "No hero image."],
      evidence: { heroImage: url, heroImageAlt: alt },
    });
  }

  const checks = { present: true, altNonEmpty: true, altNotFilename: true, altNotGeneric: true, altOnTopic: true };

  if (!alt || wordCount(alt) < 3 || alt.length < 15) {
    checks.altNonEmpty = false;
    details.push(
      alt ? `Alt text "${alt}" is too thin to describe the image.` : "Hero image has no alt text."
    );
  }

  const normalisedAlt = normalize(alt);
  if (normalisedAlt && normalisedAlt === filenameWords(url)) {
    checks.altNotFilename = false;
    details.push("Alt text is just the image filename with the dashes removed.");
  }

  const altTokens = significantTokens(alt);
  if (!normalisedAlt || GENERIC_ALT.has(normalisedAlt) || altTokens.every(t => GENERIC_ALT.has(t))) {
    checks.altNotGeneric = false;
    details.push(`Alt text "${alt}" is generic boilerplate, not a description.`);
  }

  // "Describes the topic" is verified as overlap with the keyword and title.
  // It is a proxy, but it is the one a reader would apply: an alt text sharing
  // no vocabulary with the article is not describing the article.
  const topicTokens = new Set([
    ...significantTokens(input.primaryKeyword ?? ""),
    ...significantTokens(input.title ?? ""),
  ]);
  if (topicTokens.size > 0 && !altTokens.some(t => topicTokens.has(t))) {
    checks.altOnTopic = false;
    details.push(`Alt text "${alt}" shares no vocabulary with the article topic.`);
  }

  const passedCount = Object.values(checks).filter(Boolean).length;
  const allOk = passedCount === 5;
  if (allOk) details.push(`Hero image present with descriptive alt text: "${alt}".`);

  return build(config, {
    id: "hero-image",
    label: LABEL,
    status: allOk ? "pass" : "fail",
    score: passedCount / 5,
    details,
    evidence: { heroImage: url, heroImageAlt: alt, ...checks },
  });
}
