/**
 * A starting point for an endpoint's parameters.
 *
 * DataForSEO publishes no parameter schema — the shapes live in prose in the
 * docs — so nothing here can be authoritative, and this file does not pretend
 * to be. It produces a *template*: the fields an endpoint of this shape almost
 * always takes, prefilled with the desk's market, so the common case is one
 * word away from running instead of a blank JSON box.
 *
 * The provider itself is the authority, and it is unusually good at saying so
 * ("Invalid Field: 'target'.", "Field 'keyword' is required."). The explorer
 * shows those messages verbatim, which makes a wrong template self-correcting
 * rather than a dead end — and is why guessing here is safe, as long as the
 * guess is never presented as the specification.
 */

import type { Endpoint } from "./catalogue.js";
import type { Market } from "./client.js";

export type ParamTemplate = Record<string, unknown>;

/**
 * Path fragment → the fields that fragment implies. First match wins, so the
 * list runs from most specific to least.
 */
const RULES: { match: RegExp; params: ParamTemplate }[] = [
  // ── On-Page: a crawl, then reads of the crawl by its task id ──────────────
  { match: /^\/on_page\/task_post$/, params: { target: "example.com", max_crawl_pages: 100 } },
  { match: /^\/on_page\/instant_pages$/, params: { url: "https://example.com/" } },
  { match: /^\/on_page\/content_parsing/, params: { url: "https://example.com/", id: "" } },
  { match: /^\/on_page\/lighthouse\/live/, params: { url: "https://example.com/", for_mobile: false } },
  { match: /^\/on_page\/lighthouse\/task_post$/, params: { url: "https://example.com/" } },
  { match: /^\/on_page\/(page_screenshot)/, params: { url: "https://example.com/" } },
  { match: /^\/on_page\//, params: { id: "", limit: 100 } },

  // ── Keywords Data ─────────────────────────────────────────────────────────
  { match: /\/keywords_for_site/, params: { target: "example.com", limit: 100 } },
  { match: /\/keywords_for_categories/, params: { category_codes: [], limit: 100 } },
  { match: /\/search_volume/, params: { keywords: ["example keyword"] } },
  { match: /\/keywords_for_keywords/, params: { keywords: ["example keyword"] } },
  { match: /\/ad_traffic_by_keywords/, params: { keywords: ["example keyword"], bid: 2, match: "exact" } },
  { match: /^\/keywords_data\/google_trends/, params: { keywords: ["example keyword"] } },
  { match: /^\/keywords_data\/dataforseo_trends/, params: { keywords: ["example keyword"] } },

  // ── Labs: keyword-shaped and domain-shaped ────────────────────────────────
  { match: /\/(domain_intersection|page_intersection)/, params: { target1: "example.com", target2: "competitor.com", limit: 100 } },
  { match: /\/(bulk_keyword_difficulty|bulk_search_volume|search_intent|categories_for_keywords)/, params: { keywords: ["example keyword"] } },
  { match: /\/(bulk_traffic_estimation|bulk_app_metrics|bulk_ranks|bulk_backlinks|bulk_spam_score|bulk_referring_domains|bulk_pages_summary|bulk_new_lost_backlinks|bulk_new_lost_referring_domains)/, params: { targets: ["example.com"] } },
  { match: /\/keyword_overview/, params: { keywords: ["example keyword"] } },
  { match: /\/(keyword_suggestions|related_keywords|keyword_ideas|serp_competitors|historical_serps|historical_keyword_data)/, params: { keyword: "example keyword", limit: 100 } },
  { match: /\/(ranked_keywords|competitors_domain|relevant_pages|subdomains|domain_rank_overview|historical_rank_overview|categories_for_domain|domain_whois_overview|top_searches)/, params: { target: "example.com", limit: 100 } },
  { match: /\/(app_competitors|app_intersection|keywords_for_app|product_competitors|product_keyword_intersections|product_rank_overview)/, params: { limit: 100 } },

  // ── Backlinks: everything is a target plus a window ───────────────────────
  { match: /^\/backlinks\/(summary|history|timeseries_summary|timeseries_new_lost_summary)/, params: { target: "example.com" } },
  { match: /^\/backlinks\//, params: { target: "example.com", limit: 100 } },

  // ── Domain analytics, content analysis ────────────────────────────────────
  { match: /^\/domain_analytics\/technologies\/(domain_technologies|aggregation_technologies)/, params: { target: "example.com" } },
  { match: /^\/domain_analytics\/technologies\/domains_by_technology/, params: { technologies: ["shopify"], limit: 100 } },
  { match: /^\/domain_analytics\/whois/, params: { limit: 100 } },
  { match: /^\/content_analysis\/(search|summary|sentiment_analysis|rating_distribution|phrase_trends|category_trends)/, params: { keyword: "example brand", limit: 100 } },
  { match: /^\/content_analysis\//, params: { keyword: "example brand" } },

  // ── Merchant, app data, business data ─────────────────────────────────────
  { match: /^\/merchant\/.*\/(products|sellers)\//, params: { keyword: "example product", depth: 100 } },
  { match: /^\/merchant\/.*\/product_info\//, params: { product_id: "", se_type: "organic" } },
  { match: /^\/merchant\//, params: { keyword: "example product" } },
  { match: /^\/app_data\/.*\/app_info\//, params: { app_id: "" } },
  { match: /^\/app_data\/.*\/app_searches\//, params: { keyword: "example app", depth: 100 } },
  { match: /^\/app_data\//, params: { keyword: "example app" } },
  { match: /^\/business_data\/business_listings\/search/, params: { categories: [], limit: 100 } },
  { match: /^\/business_data\/.*\/reviews\//, params: { keyword: "example business", depth: 100 } },
  { match: /^\/business_data\//, params: { keyword: "example business" } },

  // ── AI optimization: the LLM visibility family ────────────────────────────
  { match: /^\/ai_optimization\/.*\/llm_responses\//, params: { user_prompt: "what is the best example?", model_name: "" } },
  { match: /^\/ai_optimization\//, params: { keyword: "example keyword" } },

  // ── SERP: a query against an engine ───────────────────────────────────────
  { match: /^\/serp\/.*\/(organic|maps|local_finder|news|images|videos|jobs|events|shopping|ai_mode|finance)\//, params: { keyword: "example keyword", depth: 20 } },
  { match: /^\/serp\//, params: { keyword: "example keyword" } },
];

/** Endpoints that take no market: a global index, or a pure lookup. */
const MARKETLESS = /^\/(backlinks|on_page|domain_analytics\/whois|appendix)\//;

/**
 * A plausible body for this endpoint, with the desk's market filled in.
 *
 * Returns an empty object when no rule matches, which is the honest answer:
 * the explorer then shows a blank body and the provider explains what it
 * wanted. Reference and task-listing endpoints take no body at all.
 */
export function templateFor(endpoint: Endpoint, market: Market = {}): ParamTemplate {
  if (endpoint.method === "GET") return {};

  const rule = RULES.find((entry) => entry.match.test(endpoint.path));
  const params: ParamTemplate = { ...(rule?.params ?? {}) };

  if (!MARKETLESS.test(endpoint.path)) {
    if (market.locationCode) params.location_code = market.locationCode;
    if (market.languageCode) params.language_code = market.languageCode;
  }

  // A task read is addressed by id and takes nothing else worth guessing.
  if (endpoint.kind === "task_get") return {};

  return params;
}

/** Fill `$id` in a path, so a finished task can be collected. */
export function withTaskId(path: string, id: string): string {
  return path.replace("$id", encodeURIComponent(id));
}
