/**
 * DataForSEO rows, flattened into what a table actually shows.
 *
 * Every endpoint nests the same keyword facts differently — `keyword_info` on
 * one, `keyword_data.keyword_info` on the next, `ranked_serp_element` on a
 * third — and a UI that reads those shapes directly ends up re-learning them in
 * five places. They are read once, here, and every field is optional on the way
 * in: a missing number stays null rather than becoming zero, because on this
 * desk a zero is a claim ("no searches") and a null is the truth ("not sold").
 */

export interface KeywordRow {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
}

export interface RankedKeywordRow extends KeywordRow {
  position: number | null;
  url: string | null;
  /** DataForSEO's estimated monthly traffic from this one position. */
  trafficEstimate: number | null;
}

/**
 * One row of `domain_intersection`, still in the endpoint's own terms.
 *
 * Which of the two domains is "mine" is the caller's decision, and it is not
 * the obvious one: asking for the keywords a rival has and we do not means
 * sending the *rival* as `target1`, so first and second arrive the other way
 * round. Naming them here would bake that inversion into the wrong file.
 */
export interface IntersectionRow extends KeywordRow {
  firstPosition: number | null;
  firstUrl: string | null;
  secondPosition: number | null;
  secondUrl: string | null;
}

export interface DomainOverviewRow {
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicTrafficCost: number | null;
  paidKeywords: number | null;
  top3: number | null;
  top10: number | null;
}

export interface BacklinkSummaryRow {
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  /** Of the referring domains, how many link with nofollow. */
  nofollowDomains: number | null;
  brokenBacklinks: number | null;
  spamScore: number | null;
}

export interface ReferringDomainRow {
  domain: string;
  rank: number | null;
  backlinks: number | null;
  firstSeen: string | null;
  lostDate: string | null;
  spamScore: number | null;
}

export interface AnchorRow {
  anchor: string;
  backlinks: number | null;
  referringDomains: number | null;
}

export interface CompetitorRow {
  domain: string;
  /** Keywords both domains rank for. */
  intersections: number | null;
  avgPosition: number | null;
  organicKeywords: number | null;
  organicTraffic: number | null;
}

export interface SerpRow {
  position: number | null;
  domain: string | null;
  url: string | null;
  title: string | null;
  description: string | null;
}

type Bag = Record<string, unknown>;

const bag = (value: unknown): Bag => (value && typeof value === "object" ? (value as Bag) : {});

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** `keyword_data` when the endpoint wraps it, the row itself when it does not. */
function keywordCore(row: Bag): Bag {
  return row.keyword_data && typeof row.keyword_data === "object" ? bag(row.keyword_data) : row;
}

export function toKeywordRow(raw: unknown): KeywordRow | null {
  const core = keywordCore(bag(raw));
  const keyword = str(core.keyword);
  if (!keyword) return null;

  const info = bag(core.keyword_info);
  const properties = bag(core.keyword_properties);
  const intent = bag(core.search_intent_info);

  return {
    keyword,
    volume: num(info.search_volume) ?? num(core.search_volume),
    difficulty: num(properties.keyword_difficulty),
    cpc: num(info.cpc) ?? num(core.cpc),
    competition: num(info.competition) ?? num(core.competition),
    intent: str(intent.main_intent),
  };
}

export function toRankedKeywordRow(raw: unknown): RankedKeywordRow | null {
  const row = bag(raw);
  const base = toKeywordRow(row);
  if (!base) return null;

  const element = bag(bag(row.ranked_serp_element).serp_item);
  return {
    ...base,
    position: num(element.rank_absolute) ?? num(element.rank_group),
    url: str(element.url),
    trafficEstimate: num(element.etv),
  };
}

export function toIntersectionRow(raw: unknown): IntersectionRow | null {
  const row = bag(raw);
  const base = toKeywordRow(row);
  if (!base) return null;

  const first = bag(row.first_domain_serp_element);
  const second = bag(row.second_domain_serp_element);
  return {
    ...base,
    firstPosition: num(first.rank_absolute) ?? num(first.rank_group),
    firstUrl: str(first.url),
    secondPosition: num(second.rank_absolute) ?? num(second.rank_group),
    secondUrl: str(second.url),
  };
}

/**
 * `domain_rank_overview` answers with one item per search engine and locale,
 * and the numbers live under `metrics.organic`. Position buckets (`pos_1`,
 * `pos_2_3`, `pos_4_10`) are what "top 3" and "top 10" are built from — the
 * endpoint has no such field of its own.
 */
export function toDomainOverviewRow(items: unknown[]): DomainOverviewRow | null {
  const first = items.find((item) => bag(item).metrics);
  if (!first) return null;

  const metrics = bag(bag(first).metrics);
  const organic = bag(metrics.organic);
  const paid = bag(metrics.paid);

  const pos1 = num(organic.pos_1);
  const pos23 = num(organic.pos_2_3);
  const pos410 = num(organic.pos_4_10);
  const top3 = pos1 === null && pos23 === null ? null : (pos1 ?? 0) + (pos23 ?? 0);
  const top10 = top3 === null && pos410 === null ? null : (top3 ?? 0) + (pos410 ?? 0);

  return {
    organicKeywords: num(organic.count),
    organicTraffic: num(organic.etv),
    organicTrafficCost: num(organic.estimated_paid_traffic_cost),
    paidKeywords: num(paid.count),
    top3,
    top10,
  };
}

export function toBacklinkSummaryRow(raw: unknown): BacklinkSummaryRow | null {
  const row = bag(raw);
  if (row.backlinks === undefined && row.referring_domains === undefined) return null;

  // There is no dofollow count in this response. `referring_links_attributes`
  // holds whatever rel attributes were seen (`noopener`, and so on), which is
  // not the same question, and subtracting nofollow from the total would be a
  // number we made up. Only nofollow is reported, because only it is measured.
  return {
    rank: num(row.rank),
    backlinks: num(row.backlinks),
    referringDomains: num(row.referring_domains),
    referringMainDomains: num(row.referring_main_domains),
    nofollowDomains: num(row.referring_domains_nofollow),
    brokenBacklinks: num(row.broken_backlinks),
    spamScore: num(row.backlinks_spam_score),
  };
}

export function toReferringDomainRow(raw: unknown): ReferringDomainRow | null {
  const row = bag(raw);
  const domain = str(row.domain);
  if (!domain) return null;
  return {
    domain,
    rank: num(row.rank),
    backlinks: num(row.backlinks),
    firstSeen: str(row.first_seen),
    lostDate: str(row.lost_date),
    spamScore: num(row.backlinks_spam_score),
  };
}

export function toAnchorRow(raw: unknown): AnchorRow | null {
  const row = bag(raw);
  const anchor = str(row.anchor);
  if (!anchor) return null;
  return {
    anchor,
    backlinks: num(row.backlinks),
    referringDomains: num(row.referring_domains),
  };
}

export function toCompetitorRow(raw: unknown): CompetitorRow | null {
  const row = bag(raw);
  const domain = str(row.domain);
  if (!domain) return null;

  const organic = bag(bag(row.metrics).organic);
  const fullOrganic = bag(bag(row.full_domain_metrics).organic);
  return {
    domain,
    intersections: num(row.intersections),
    avgPosition: num(row.avg_position),
    organicKeywords: num(fullOrganic.count) ?? num(organic.count),
    organicTraffic: num(fullOrganic.etv) ?? num(organic.etv),
  };
}

/** Organic results only: the ads and the boxes are a different question. */
export function toSerpRow(raw: unknown): SerpRow | null {
  const row = bag(raw);
  if (row.type !== "organic") return null;
  return {
    position: num(row.rank_absolute) ?? num(row.rank_group),
    domain: str(row.domain),
    url: str(row.url),
    title: str(row.title),
    description: str(row.description),
  };
}

/** Map, drop what did not parse, and keep the provider's order. */
export function mapRows<T>(rows: unknown[], shape: (raw: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const shaped = shape(row);
    if (shaped) out.push(shaped);
  }
  return out;
}
