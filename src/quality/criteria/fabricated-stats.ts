/**
 * Criterion 8: statistics and authorities the source material never contained.
 *
 * The writer prompts forbid invented figures in capital letters ("NEVER invent
 * statistics, percentages, study results, survey figures") and nothing in the
 * pipeline checks whether the model obeyed. A model that is asked to sound
 * authoritative and has no number to hand will supply one; it reads perfectly
 * and it is false. That is the defect that turns "the plumbing works" into a
 * refund, so it is checked hardest and it blocks publication.
 *
 * The method is deliberately conservative: only figures that read as *claims*
 * are extracted — percentages, money, scaled magnitudes, ratios, multipliers,
 * comma-grouped counts — and each one must trace back to the source text.
 * Ordinary prose numbers ("3 steps", "10 minutes") are left alone, because a
 * detector that cries wolf gets switched off.
 */

import type { ArticleStructure } from "../extract.js";
import { normalize } from "../text.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Fabricated statistics";

type ClaimKind = "percentage" | "money" | "magnitude" | "ratio" | "multiplier" | "count" | "attribution";

interface Claim {
  kind: ClaimKind;
  /** Exactly as it appears in the article, for quoting back to the editor. */
  text: string;
  /** The number or entity that has to be found in the source. */
  needle: string;
  index: number;
  end: number;
}

const NUMERIC_PATTERNS: Array<{ kind: ClaimKind; re: RegExp }> = [
  { kind: "percentage", re: /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b|per cent\b|percentage points?\b)/gi },
  { kind: "money", re: /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|euros|pounds|usd|eur|gbp)\b)/gi },
  { kind: "magnitude", re: /\b\d[\d,]*(?:\.\d+)?\s?(?:million|billion|trillion|thousand)\b/gi },
  { kind: "ratio", re: /\b\d{1,4}\s+(?:out of|in)\s+\d{1,4}\b/gi },
  { kind: "multiplier", re: /\b\d{1,3}(?:\.\d+)?x\b/gi },
  // Comma-grouped numbers only. A bare four-digit number is usually a year.
  { kind: "count", re: /\b\d{1,3}(?:,\d{3})+\b/g },
];

/**
 * Attribution to something nameable. The entity is captured so it can be looked
 * for in the source — "according to the Tenancy Deposit Scheme" is fine if the
 * source says so, and an invented institute is not.
 */
const NAMED_ATTRIBUTION =
  /\baccording to\s+((?:the\s+)?[A-Z][\w&.'’-]*(?:\s+(?:of|for|and|the)?\s*[A-Z][\w&.'’-]*)*)/g;

/**
 * Authority with nobody's name on it. These are unverifiable by construction,
 * which is exactly why the writer prompts ban them outright — so they are
 * flagged whether or not source material is available to check against.
 */
const UNNAMED_AUTHORITY =
  /\b(?:studies show|studies have shown|studies suggest|research shows|research suggests|researchers found|a study found|a study showed|surveys show|a survey found|survey found|data shows|statistics show|figures show|experts say|experts agree|experts recommend|reports suggest|it is widely reported)\b/gi;

function sourceText(input: ArticleQualityInput): string {
  const raw = input.sourceMaterial;
  if (!raw) return "";
  return Array.isArray(raw) ? raw.join("\n") : raw;
}

/** Strip grouping separators and trailing zeros so "1,240" and "1240.00" match. */
function canonicalNumber(value: string): string {
  const digits = value.replace(/[^\d.]/g, "");
  if (!digits) return "";
  const asNumber = Number(digits);
  return Number.isFinite(asNumber) ? String(asNumber) : digits;
}

function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const canonical = canonicalNumber(match);
    if (canonical) found.add(canonical);
  }
  return found;
}

function excerpt(prose: string, index: number): string {
  const start = Math.max(0, prose.lastIndexOf(".", index - 1) + 1);
  const endMark = prose.indexOf(".", index);
  const end = endMark === -1 ? Math.min(prose.length, index + 120) : endMark + 1;
  return prose.slice(start, end).trim();
}

function collectClaims(prose: string): Claim[] {
  const claims: Claim[] = [];

  for (const { kind, re } of NUMERIC_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(prose)) !== null) {
      const needle = canonicalNumber(match[0]);
      if (needle) {
        claims.push({ kind, text: match[0], needle, index: match.index, end: match.index + match[0].length });
      }
    }
  }

  NAMED_ATTRIBUTION.lastIndex = 0;
  let named: RegExpExecArray | null;
  while ((named = NAMED_ATTRIBUTION.exec(prose)) !== null) {
    const entity = named[1].trim().replace(/^the\s+/i, "");
    claims.push({
      kind: "attribution",
      text: entity,
      needle: normalize(entity),
      index: named.index,
      end: named.index + named[0].length,
    });
  }

  // One figure can satisfy several patterns — "£1,240" is money and also a
  // comma-grouped count. Keep the widest match covering each span so the editor
  // reads one finding, not three restatements of it.
  const ordered = [...claims].sort((a, b) => a.index - b.index || b.end - a.end);
  const kept: Claim[] = [];
  for (const claim of ordered) {
    const covered = kept.some(k => k.index <= claim.index && k.end >= claim.end);
    if (!covered) kept.push(claim);
  }
  return kept;
}

export function scoreFabricatedStats(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const prose = structure.prose;
  const source = sourceText(input);
  const hasSource = source.trim().length > 0;

  const details: string[] = [];
  const fabricated: Array<{ kind: ClaimKind; text: string; where: string }> = [];
  const unverifiable: string[] = [];

  UNNAMED_AUTHORITY.lastIndex = 0;
  let vague: RegExpExecArray | null;
  while ((vague = UNNAMED_AUTHORITY.exec(prose)) !== null) {
    fabricated.push({
      kind: "attribution",
      text: vague[0],
      where: excerpt(prose, vague.index),
    });
    details.push(
      `Unattributed authority claim "${vague[0]}" — no source is named, so the reader cannot check it: "${excerpt(prose, vague.index)}"`
    );
  }

  const claims = collectClaims(prose);
  const sourceNumbers = hasSource ? numbersIn(source) : new Set<string>();
  const normalisedSource = hasSource ? normalize(source) : "";

  for (const claim of claims) {
    if (!hasSource) {
      unverifiable.push(claim.text);
      continue;
    }
    const found =
      claim.kind === "attribution"
        ? claim.needle.length > 0 && normalisedSource.includes(claim.needle)
        : sourceNumbers.has(claim.needle);
    if (!found) {
      const where = excerpt(prose, claim.index);
      fabricated.push({ kind: claim.kind, text: claim.text, where });
      details.push(
        claim.kind === "attribution"
          ? `"${claim.text}" is cited as a source but appears nowhere in the source material: "${where}"`
          : `The figure "${claim.text}" appears nowhere in the source material: "${where}"`
      );
    }
  }

  if (unverifiable.length > 0) {
    details.push(
      `${unverifiable.length} numeric claim(s) could not be verified because no source material was supplied: ${unverifiable.join(", ")}.`
    );
  }

  const checked = claims.length + fabricated.filter(f => f.kind === "attribution").length;
  const score = fabricated.length === 0 ? 1 : Math.max(0, 1 - fabricated.length / Math.max(1, checked));

  if (fabricated.length === 0 && unverifiable.length === 0) {
    details.push(
      claims.length === 0
        ? "No statistics or cited authorities in the article."
        : `All ${claims.length} numeric or attributed claim(s) trace back to the source material.`
    );
  }

  return build(config, {
    id: "fabricated-stats",
    label: LABEL,
    status: fabricated.length === 0 ? "pass" : "fail",
    score,
    // An invented figure is published misinformation on a customer's domain.
    // No amount of SEO polish elsewhere makes that publishable.
    blocking: true,
    details,
    evidence: {
      hasSourceMaterial: hasSource,
      claimsChecked: claims.length,
      fabricated,
      unverifiable,
    },
  });
}
