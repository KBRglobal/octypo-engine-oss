/**
 * What this customer bought.
 *
 * Octypo installs one deployment per customer, and not every customer buys the
 * same thing: image optimisation and CDN delivery are a paid add-on, so a
 * customer who did not pay for storage must not silently receive it. Capability
 * is therefore a first-class setting rather than an accident of which API keys
 * happen to be present — a missing key means "cannot", an entitlement means
 * "may", and the two failures need different answers when a customer asks why
 * their articles have no images.
 *
 * One list, one env var, one function. A capability that is checked in three
 * places and configured in three ways is how a customer ends up half-entitled.
 */

import { logger } from "../lib/logger.js";

export const CAPABILITIES = [
  /** Pull real photography from stock providers. */
  "stock-images",
  /** Generate imagery with a model when stock has no relevant match. */
  "generated-images",
  /** Compress and convert to WebP before storing. Billed as storage. */
  "image-optimisation",
  /** Serve images through a transforming CDN instead of the plain bucket. */
  "cdn-delivery",
  /** Render a short promo video for an article. */
  "article-video",
  /** Insert internal links between the customer's own articles. */
  "internal-links",
  /** Use live search results for topic, keyword and competitor research. */
  "search-research",
  /** Ping IndexNow on publish. */
  "indexnow",
  /** Turn uploaded documents into articles. */
  "document-library",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL = new Set<Capability>(CAPABILITIES);

function isCapability(value: string): value is Capability {
  return (ALL as Set<string>).has(value);
}

/**
 * Parse `OCTYPO_ENTITLEMENTS`.
 *
 * - unset or empty → everything, so an existing install does not silently lose
 *   features the day this shipped
 * - `all` → everything
 * - `none` → nothing
 * - a comma-separated list → exactly those
 * - a `-` prefix subtracts, so `all,-image-optimisation` reads the way the
 *   decision is actually made: this customer gets the product minus the add-on
 *   they did not buy
 *
 * An unknown name is ignored with a warning rather than throwing. A typo in one
 * capability must not stop a customer's engine from booting.
 */
export function parseEntitlements(raw: string | undefined): Set<Capability> {
  const tokens = (raw ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) return new Set(ALL);

  // A list that opens with a subtraction is read as "the product, minus these".
  // Anything else builds up from nothing, so a short list cannot accidentally
  // grant an add-on nobody named.
  const granted = tokens[0].startsWith("-") ? new Set(ALL) : new Set<Capability>();

  for (const token of tokens) {
    const negated = token.startsWith("-");
    const name = negated ? token.slice(1).trim() : token;

    if (name === "all") {
      if (negated) granted.clear();
      else for (const capability of ALL) granted.add(capability);
      continue;
    }
    if (name === "none") {
      if (!negated) granted.clear();
      continue;
    }
    if (!isCapability(name)) {
      logger.warn({ capability: name }, "[Entitlements] Unknown capability ignored");
      continue;
    }

    if (negated) granted.delete(name);
    else granted.add(name);
  }

  return granted;
}

let cached: Set<Capability> | null = null;

function current(): Set<Capability> {
  if (!cached) cached = parseEntitlements(process.env.OCTYPO_ENTITLEMENTS);
  return cached;
}

/** True when this deployment's customer is entitled to `capability`. */
export function entitled(capability: Capability): boolean {
  return current().has(capability);
}

/** Everything this customer has, for the status endpoints and the logs. */
export function grantedCapabilities(): Capability[] {
  return CAPABILITIES.filter((c) => current().has(c));
}

/** Re-read the environment. Tests and a config reload; nothing else. */
export function resetEntitlements(): void {
  cached = null;
}
