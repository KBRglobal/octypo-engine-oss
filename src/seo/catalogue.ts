/**
 * Every endpoint DataForSEO sells, discovered from DataForSEO.
 *
 * There are around seven hundred of them across eleven families, and they
 * change: engines are added, endpoints are renamed, new SERP types appear. A
 * hand-written list would be wrong within a month and wrong silently — the
 * desk would simply not offer the thing that exists.
 *
 * So the catalogue is built from two of the provider's own free calls:
 * `/<family>/endpoints` lists the paths, and `appendix/user_data` prices them.
 * Nothing here is typed out by hand except the family names and the rules that
 * read a path's shape, and both of those fail loudly rather than quietly.
 */

import { logger } from "../lib/logger.js";
import { findPrice, type PriceEstimate } from "./prices.js";
import type { SeoClient } from "./client.js";

/**
 * The eleven products. This list is the one hand-written thing, because
 * `/endpoints` has to be asked of a family by name; an unknown family is
 * logged and skipped rather than failing the whole catalogue.
 */
export const FAMILIES = [
  "serp",
  "keywords_data",
  "dataforseo_labs",
  "backlinks",
  "on_page",
  "domain_analytics",
  "content_analysis",
  "merchant",
  "app_data",
  "business_data",
  "ai_optimization",
] as const;

export type Family = (typeof FAMILIES)[number];

/**
 * What a path is for, read from its shape.
 *
 * - `live` answers in the same request, and is what the desk uses by default
 * - `task_post` starts work that is collected later
 * - `tasks_ready` lists what has finished
 * - `task_get` collects one finished task, and needs its id in the path
 * - `reference` is free supporting data: locations, languages, filters, errors
 * - `result` is the rest — endpoints that read an existing task by id in the
 *   body, which is how the whole On-Page crawl is read
 */
export type EndpointKind = "live" | "task_post" | "tasks_ready" | "task_get" | "reference" | "result";

export interface Endpoint {
  /** Path without the version prefix, ready for the client: `/serp/...`. */
  path: string;
  family: Family;
  kind: EndpointKind;
  /** A readable name built from the path — "Google / Organic / Live Advanced". */
  label: string;
  method: "GET" | "POST";
  /** True when the path carries `$id` and cannot run until one is supplied. */
  needsId: boolean;
  /** Free calls are the reference ones; the rest cost. Null when unpriced. */
  price: PriceEstimate | null;
}

const REFERENCE_LEAVES = new Set([
  "locations",
  "languages",
  "locations_and_languages",
  "available_filters",
  "errors",
  "id_list",
  "categories",
  "models",
]);

/**
 * Undo a doubling in the provider's own listing.
 *
 * Some entries come back with their tail repeated —
 * `ai_optimization/ai_keyword_data/available_filters/ai_keyword_data/available_filters`
 * — and that path 404s while the single version answers. Measured, not
 * assumed: both were called. The repeat is always a suffix that duplicates the
 * segments immediately before it, so the longest such suffix is dropped.
 */
export function undouble(segments: string[]): string[] {
  // Two segments minimum, and that floor is the whole subtlety. A single
  // repeated segment is a real naming pattern — `domain_analytics/
  // technologies/technologies` is a live endpoint, and trimming it to
  // `.../technologies` gives a 404. A repeat of two or more segments is
  // always the listing glitch. Both cases were checked against the API.
  for (let size = Math.floor(segments.length / 2); size >= 2; size--) {
    const tail = segments.slice(-size).join("/");
    const before = segments.slice(-size * 2, -size).join("/");
    if (tail === before) return segments.slice(0, -size);
  }
  return segments;
}

/** GET endpoints are the ones that take nothing but their path. */
function methodFor(kind: EndpointKind): "GET" | "POST" {
  return kind === "reference" || kind === "tasks_ready" || kind === "task_get" ? "GET" : "POST";
}

export function classify(path: string): EndpointKind {
  const segments = path.split("/").filter(Boolean);
  const leaf = segments[segments.length - 1];

  if (segments.includes("$id")) return "task_get";
  if (leaf === "tasks_ready" || leaf === "tasks_fixed") return "tasks_ready";
  if (leaf === "task_post") return "task_post";
  if (segments.includes("live")) return "live";
  if (REFERENCE_LEAVES.has(leaf)) return "reference";
  // `task_get` without `$id` still reads a task, and so does `summary`,
  // `pages`, `resources` and the rest of the On-Page family.
  return "result";
}

/** "serp/google/organic/live/advanced" → "Google · Organic · Live Advanced". */
export function labelFor(path: string, family: Family): string {
  const words = path
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== family && segment !== "$id");
  if (words.length === 0) return family;
  return words
    .map((word) =>
      word
        .split("_")
        .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
        .join(" ")
    )
    .join(" · ");
}

export interface Catalogue {
  endpoints: Endpoint[];
  /** Families that answered, so a partial catalogue is visible as partial. */
  families: Family[];
  missing: Family[];
}

let cached: { at: number; catalogue: Catalogue } | null = null;
const CACHE_MS = 6 * 3_600_000;

/**
 * Ask every family what it offers, and price the answers.
 *
 * One family failing is not the catalogue failing: eleven free calls run
 * together, and whatever came back is offered with the rest reported missing.
 * A desk that shows nothing because `merchant` timed out is worse than a desk
 * that shows ten families and says so.
 */
export async function buildCatalogue(
  client: SeoClient,
  prices: Record<string, unknown>,
  force = false
): Promise<Catalogue> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.catalogue;

  const results = await Promise.all(
    FAMILIES.map(async (family) => {
      try {
        const { results: rows } = await client.get(`/${family}/endpoints`);
        // The list arrives as result[0] — itself an array of path strings.
        const first = rows[0] as unknown;
        const paths = Array.isArray(first) ? first : rows;
        return { family, paths: paths.filter((p): p is string => typeof p === "string") };
      } catch (error) {
        logger.warn({ error, family }, "[SEO] Could not list a family's endpoints");
        return { family, paths: null };
      }
    })
  );

  const endpoints: Endpoint[] = [];
  const families: Family[] = [];
  const missing: Family[] = [];
  // Undoubling can collapse two listed entries onto one real path.
  const seen = new Set<string>();

  for (const { family, paths } of results) {
    if (!paths) {
      missing.push(family);
      continue;
    }
    families.push(family);
    for (const raw of paths) {
      // The provider lists paths as "v3/serp/..."; the client adds the version.
      const withoutVersion = raw.replace(/^v3\//, "");
      const path = `/${undouble(withoutVersion.split("/").filter(Boolean)).join("/")}`;
      if (seen.has(path)) continue;
      seen.add(path);

      const kind = classify(path);
      endpoints.push({
        path,
        family,
        kind,
        label: labelFor(path, family),
        method: methodFor(kind),
        needsId: path.includes("$id"),
        price: kind === "reference" ? { perRequestUsd: 0, perResultUsd: 0 } : findPrice(prices, path),
      });
    }
  }

  endpoints.sort((a, b) => a.path.localeCompare(b.path));
  const catalogue = { endpoints, families, missing };
  if (families.length > 0) cached = { at: Date.now(), catalogue };
  return catalogue;
}

export function resetCatalogueCache(): void {
  cached = null;
}
