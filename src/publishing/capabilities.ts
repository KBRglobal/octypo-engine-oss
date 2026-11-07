/**
 * Explicit degradation.
 *
 * The failure mode this file exists to prevent: a customer's CMS has no tag
 * taxonomy, the adapter quietly drops `tags`, and six months later somebody
 * notices that none of the 400 articles on their site are categorised. Nothing
 * ever errored, so nothing was ever reported.
 *
 * So a target declares what it can take, and anything the article carries that
 * the target cannot becomes a `Degradation` on the outcome — logged by the
 * caller, and optionally treated as a hard failure by a customer who would
 * rather not publish at all than publish incomplete.
 *
 * `hostsMedia: false` deliberately does NOT degrade: the hero image URL still
 * travels in the payload, the target simply hot-links it instead of copying the
 * bytes. Reporting that as loss would train everyone to ignore the warnings.
 */

import type { Degradation, NormalisedArticle, TargetCapabilities } from "./types.js";

export function describeDegradation(
  caps: TargetCapabilities,
  article: NormalisedArticle
): Degradation[] {
  const degraded: Degradation[] = [];

  if (article.category && !caps.categories) {
    degraded.push({
      feature: "categories",
      detail: `category "${article.category.slug}" not delivered — target has no categories`,
    });
  }

  if (article.tags.length > 0 && !caps.tags) {
    degraded.push({
      feature: "tags",
      detail: `${article.tags.length} tag(s) not delivered — target has no tags`,
    });
  }

  if (article.excerpt && !caps.excerpt) {
    degraded.push({
      feature: "excerpt",
      detail: "excerpt not delivered — target has no excerpt field",
    });
  }

  if (article.structuredData.length > 0 && !caps.structuredData) {
    degraded.push({
      feature: "structuredData",
      detail: `${article.structuredData.length} JSON-LD object(s) not delivered — target cannot carry structured data`,
    });
  }

  // Only a *future* date is lost information. A target that ignores scheduling
  // publishes a back-dated article immediately, which is what we wanted anyway.
  if (!caps.scheduling && article.publishedAt && article.publishedAt.getTime() > Date.now()) {
    degraded.push({
      feature: "scheduling",
      detail: `publish date ${article.publishedAt.toISOString()} not honoured — target publishes immediately`,
    });
  }

  return degraded;
}

/** True when any loss was reported. Used by the strict delivery mode. */
export function hasDegradation(degraded: Degradation[]): boolean {
  return degraded.length > 0;
}

export function formatDegradation(degraded: Degradation[]): string {
  return degraded.map(entry => `${entry.feature}: ${entry.detail}`).join("; ");
}
