/**
 * The one-time competitive snapshot.
 *
 * Before this, the writer only ever saw the client's facts; what actually
 * ranks for the money queries was invisible, and the SERP judges scored the
 * output 58-70 for exactly that blindness. This module looks at the live
 * results ONCE per cluster — at onboarding, on the owner's explicit budget
 * rule of "external research is paid for once per client" — distills what the
 * winners cover into a coverage brief, and stores it. Every article in
 * that cluster then receives the brief as part of its input.
 *
 * Deliberately not per-article: the SERP for a commercial phrase moves on the
 * scale of months, and the once-per-client rule is a pricing decision, not a
 * technical one.
 */

import { desc, eq, isNotNull, and } from "drizzle-orm";

import { db } from "../db.js";
import { contentIdeas, serpBriefs } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { searchClientFromEnv, type SearchClient } from "./brave.js";
import { resolveLocale, type ClusterLocale } from "../config/locale.js";
import { packFor } from "../i18n/language-pack.js";

/** How many of the cluster's queries to research. Once per client — so few. */
const QUERIES_PER_CLUSTER = 4;
const RESULTS_PER_QUERY = 10;

export interface SerpBriefResult {
  cluster: string;
  queries: string[];
  brief: string;
}

/** Top money queries for a cluster, drawn from the idea bank itself. */
async function clusterQueries(cluster: string): Promise<string[]> {
  const rows = await db
    .select({ keyword: contentIdeas.targetKeyword })
    .from(contentIdeas)
    .where(and(eq(contentIdeas.cluster, cluster), isNotNull(contentIdeas.targetKeyword)))
    .orderBy(desc(contentIdeas.searchVolume))
    .limit(QUERIES_PER_CLUSTER * 3);
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const row of rows) {
    const keyword = (row.keyword ?? "").trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    queries.push(keyword);
    if (queries.length >= QUERIES_PER_CLUSTER) break;
  }
  return queries;
}

/**
 * Research one cluster and store its brief. Returns null when the install has
 * no search key (the capability was not bought) or the bank has no queries.
 */
export async function buildSerpBrief(
  cluster: string,
  deps?: { search?: SearchClient | null; registry?: typeof EngineRegistry; locale?: ClusterLocale }
): Promise<SerpBriefResult | null> {
  const search = deps?.search !== undefined ? deps.search : searchClientFromEnv();
  if (!search) {
    logger.info("[SerpBrief] No search client configured — skipping");
    return null;
  }

  const queries = await clusterQueries(cluster);
  if (queries.length === 0) {
    logger.warn({ cluster }, "[SerpBrief] No queries in the bank for this cluster");
    return null;
  }

  // Research follows the cluster's language (LANG-04).
  const locale = deps?.locale ?? (await resolveLocale(cluster));

  const sections: string[] = [];
  for (const query of queries) {
    try {
      // The Brave 422 lesson, generalized: a country filter can empty or reject
      // the result set on some plans — retry once without it.
      const results = await search
        .search(query, { count: RESULTS_PER_QUERY, lang: locale.language, country: locale.country })
        .catch((error: unknown) => {
          logger.warn({ error, query }, "[SerpBrief] Country-filtered search failed — retrying without it");
          return [];
        })
        .then((filtered) =>
          filtered.length > 0
            ? filtered
            : search.search(query, { count: RESULTS_PER_QUERY, lang: locale.language })
        );
      if (results.length === 0) continue;
      sections.push(
        `Query: ${query}\n` +
          results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.description}`)
            .join("\n")
      );
    } catch (error) {
      logger.warn({ error, query }, "[SerpBrief] Search failed for query — continuing");
    }
  }
  if (sections.length === 0) {
    logger.warn({ cluster }, "[SerpBrief] No search results at all — nothing to distill");
    return null;
  }

  const registry = deps?.registry ?? EngineRegistry;
  const engine = registry.getFastEngine() ?? registry.getNextFromQueue();
  if (!engine) throw new Error("No engine available to distill the SERP brief");

  const brief = (
    await generateWithEngine(engine, packFor(locale.language).distillPrompt, sections.join("\n\n"))
  ).trim();
  if (!brief) return null;

  await db
    .insert(serpBriefs)
    .values({ cluster, queries, brief })
    .onConflictDoUpdate({
      target: serpBriefs.cluster,
      set: { queries, brief, updatedAt: new Date() },
    });

  logger.info({ cluster, queries: queries.length }, "[SerpBrief] Brief built and stored");
  return { cluster, queries, brief };
}

/** The stored brief for a cluster, falling back to the site-wide brief. */
export async function serpBriefFor(cluster: string | null): Promise<string | null> {
  const candidates = cluster ? [cluster, "*"] : ["*"];
  for (const key of candidates) {
    const [row] = await db
      .select({ brief: serpBriefs.brief })
      .from(serpBriefs)
      .where(eq(serpBriefs.cluster, key))
      .limit(1);
    if (row?.brief) return row.brief;
  }
  return null;
}

/**
 * The zero-API-cost path: a ready-to-paste research prompt for the owner's
 * own flat-rate model subscription. The owner pastes the prompt into a model
 * with web access, pastes the answer back through the paste endpoint, and the
 * writer receives exactly the same brief shape the automatic path produces.
 */
export async function serpBriefPrompt(
  cluster: string,
  deps?: { locale?: ClusterLocale }
): Promise<{ cluster: string; prompt: string } | null> {
  const queries = await clusterQueries(cluster);
  if (queries.length === 0) return null;
  const locale = deps?.locale ?? (await resolveLocale(cluster));
  return { cluster, prompt: packFor(locale.language).serpPastePrompt(queries) };
}

/** Store a brief the owner produced with their own subscription model. */
export async function storePastedBrief(cluster: string, brief: string): Promise<void> {
  await db
    .insert(serpBriefs)
    .values({ cluster, queries: [], brief: brief.trim() })
    .onConflictDoUpdate({
      target: serpBriefs.cluster,
      set: { brief: brief.trim(), updatedAt: new Date() },
    });
  logger.info({ cluster }, "[SerpBrief] Pasted brief stored");
}

/** Every cluster present in the idea bank. */
export async function bankClusters(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ cluster: contentIdeas.cluster })
    .from(contentIdeas)
    .where(isNotNull(contentIdeas.cluster));
  return rows.map((r) => r.cluster).filter((c): c is string => !!c);
}
