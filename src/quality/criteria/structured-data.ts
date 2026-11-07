/**
 * Criterion 4: the JSON-LD block.
 *
 * Structured data fails silently. A missing field or a stray `</script>` costs
 * the customer every rich result on the page and nothing anywhere logs an
 * error, so this is checked the way a crawler would: parse it, look for the
 * fields Google documents as required, and make sure the payload can survive
 * being embedded in a <script type="application/ld+json"> tag.
 */

import type { ArticleStructure } from "../extract.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Structured data (JSON-LD)";

const ARTICLE_TYPES = new Set(["Article", "NewsArticle", "BlogPosting", "TechArticle", "Report"]);

/** Fields Google lists as required or strongly recommended for Article. */
const ARTICLE_REQUIRED = ["headline", "description", "author", "datePublished"] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Anything that would terminate the host <script> element early, plus the HTML
 * comment delimiters, which the HTML parser also treats as special inside a
 * script block.
 */
const SCRIPT_BREAKERS = [/<\/script/i, /<!--/, /-->/, /<script/i];

/** Raw control characters and the two line separators that break JSON parsers. */
const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u2028\u2029]/;

export function scoreStructuredData(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const raw = input.structuredData;
  const fail = (details: string[], evidence?: Json): CriterionResult =>
    build(config, {
      id: "structured-data",
      label: LABEL,
      status: "fail",
      score: 0,
      blocking: true,
      details,
      evidence,
    });

  if (raw === null || raw === undefined || raw === "") {
    return fail(["No JSON-LD payload is attached to this article."]);
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (SCRIPT_BREAKERS.some(re => re.test(raw))) {
      return fail([
        "JSON-LD contains an unescaped `</script>` or HTML comment marker; the schema block would be cut short in the page source.",
      ]);
    }
    if (RAW_CONTROL.test(raw)) {
      return fail(["JSON-LD contains raw control characters that break the JSON-LD block."]);
    }
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return fail([
        `JSON-LD does not parse: ${error instanceof Error ? error.message : "unknown error"}.`,
      ]);
    }
  }

  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(isObject);
  if (entries.length === 0) {
    return fail(["JSON-LD payload contains no schema objects."]);
  }

  // Re-serialise so that an object-form payload is checked for the same
  // breakers a string-form payload is: it will be stringified before it reaches
  // the page either way.
  const serialised = JSON.stringify(entries);
  if (SCRIPT_BREAKERS.some(re => re.test(serialised))) {
    return fail([
      "JSON-LD contains an unescaped `</script>` or HTML comment marker; the schema block would be cut short in the page source.",
    ]);
  }

  const details: string[] = [];
  const checks: Array<{ ok: boolean }> = [];

  for (const entry of entries) {
    if (!entry["@context"]) details.push(`Schema entry "${String(entry["@type"] ?? "?")}" is missing @context.`);
    if (!entry["@type"]) details.push("A schema entry is missing @type.");
  }
  checks.push({ ok: entries.every(e => !!e["@context"] && !!e["@type"]) });

  const article = entries.find(e => ARTICLE_TYPES.has(String(e["@type"])));
  if (!article) {
    details.push("No Article (or NewsArticle / BlogPosting) entry in the JSON-LD.");
    checks.push({ ok: false });
  } else {
    const missing = ARTICLE_REQUIRED.filter(field => {
      const value = article[field];
      return value === undefined || value === null || value === "";
    });
    if (missing.length > 0) {
      details.push(`Article schema is missing required field(s): ${missing.join(", ")}.`);
    }
    checks.push({ ok: missing.length === 0 });
  }

  const hasFaqs = structure.faqs.length > 0;
  const legacyTypes = entries.filter(e => ["FAQPage", "HowTo"].includes(String(e["@type"])));
  if (legacyTypes.length > 0) {
    details.push(
      "FAQPage and HowTo are not emitted by the current commercial-article policy; keep the visible FAQ or steps and remove the legacy rich-result markup."
    );
  }
  checks.push({ ok: legacyTypes.length === 0 });

  const passedCount = checks.filter(c => c.ok).length;
  const allOk = passedCount === checks.length && details.length === 0;

  return build(config, {
    id: "structured-data",
    label: LABEL,
    status: allOk ? "pass" : "fail",
    score: passedCount / checks.length,
    // A malformed-but-parseable payload is a bad rich result, not a broken
    // page, so it costs points rather than holding the article outright.
    blocking: false,
    details: allOk
      ? [`Valid ${String(article?.["@type"])} schema with current supported article markup.`]
      : details,
    evidence: {
      entryTypes: entries.map(e => String(e["@type"] ?? "?")),
      hasFaqs,
      legacyTypes: legacyTypes.map(entry => String(entry["@type"])),
    },
  });
}
