/**
 * Criterion 6: internal links that actually resolve.
 *
 * The link processor picks targets from the database, but nothing re-checks
 * them at approval time, and an article can be approved before, or instead of,
 * the piece it links to. A 404 inside a paid customer's own site is worse than
 * no link, so the target slug is verified against the published set rather than
 * merely counted.
 */

import type { ArticleStructure } from "../extract.js";
import type { ArticleQualityInput, CriterionResult, QualityGateConfig } from "../types.js";
import { build } from "./result.js";

const LABEL = "Internal links";

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The last meaningful path segment, which is how every article URL here ends. */
function slugOf(href: string): string {
  const withoutHash = href.split("#")[0].split("?")[0];
  const segments = withoutHash.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return last.toLowerCase();
}

export function scoreInternalLinks(
  input: ArticleQualityInput,
  structure: ArticleStructure,
  config: QualityGateConfig
): CriterionResult {
  const siteHost = input.siteUrl ? hostOf(input.siteUrl) : null;

  const internal = structure.links.filter(link => {
    const href = link.href.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return false;
    if (href.startsWith("//")) return siteHost !== null && hostOf(`https:${href}`) === siteHost;
    if (/^https?:\/\//i.test(href)) return siteHost !== null && hostOf(href) === siteHost;
    return href.startsWith("/") || !href.includes(":");
  });

  const slugs = internal.map(link => slugOf(link.href)).filter(Boolean);
  const known = input.publishedSlugs ? new Set(input.publishedSlugs.map(s => s.toLowerCase())) : null;
  const required = config.minInternalLinks;

  const details: string[] = [];
  let verified: number;
  let unknownSlugs: string[] = [];

  if (known) {
    unknownSlugs = [...new Set(slugs.filter(slug => !known.has(slug)))];
    verified = slugs.filter(slug => known.has(slug)).length;
    if (unknownSlugs.length > 0) {
      details.push(`Links point at slug(s) that are not published: ${unknownSlugs.join(", ")}.`);
    }
  } else {
    // Without the published set the targets cannot be checked. Counting the
    // links is still worth doing; claiming they resolve is not.
    verified = slugs.length;
    details.push("Link targets could not be verified — no list of published slugs was supplied.");
  }

  const ok = verified >= required && unknownSlugs.length === 0;
  if (verified < required) {
    details.push(`Only ${verified} internal link(s) resolve to a published article; ${required} are required.`);
  } else if (ok) {
    details.push(`${verified} internal links resolve to published articles.`);
  }

  return build(config, {
    id: "internal-links",
    label: LABEL,
    status: ok ? "pass" : "fail",
    // With the site's real page list in hand the rule is hard: fewer than
    // the required links to pages that exist holds the article. Without the
    // list it stays a grade — the gap is the caller's, not the writer's.
    blocking: known !== null && !ok,
    score: Math.min(1, verified / required) * (unknownSlugs.length > 0 ? 0.5 : 1),
    details,
    evidence: {
      total: structure.links.length,
      internal: internal.length,
      verified,
      unknownSlugs,
      verifiedAgainstSlugList: known !== null,
    },
  });
}
