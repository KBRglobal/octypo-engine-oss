/**
 * The prospect report: one domain in, one document out, sent to a client.
 *
 * This is the only thing on the desk a stranger ever reads, which changes the
 * rules. A wrong claim in a sales document is worse than no document — the
 * prospect finds the one mistake, and stops believing the other nine pages. So
 * the discipline from the scan tool applies here: a section with no data is
 * *omitted and named*, never rendered as a zero, and every number shown is one
 * the provider returned rather than one we derived to fill a slot.
 *
 * The two estimates that are not measurements — what the traffic would be
 * worth, and how much demand the domain is invisible for — are computed from
 * returned volume and cost-per-click and labelled as estimates in the
 * document. Everything else is a reading.
 */

import { logger } from "../lib/logger.js";
import type { Market, SeoClient } from "./client.js";
import {
  mapRows,
  toBacklinkSummaryRow,
  toCompetitorRow,
  toDomainOverviewRow,
  toIntersectionRow,
  toKeywordRow,
  toRankedKeywordRow,
  type BacklinkSummaryRow,
  type CompetitorRow,
  type DomainOverviewRow,
  type KeywordRow,
  type RankedKeywordRow,
} from "./rows.js";
import { cleanDomain } from "./tools.js";
import { recordSpend } from "./store.js";
import { buildSerpOwnersSection, type SerpOwnersSection } from "./sections/serp-owners.js";
import { buildLocalSection, type LocalSection } from "./sections/local.js";
import { buildCrawlSection, type CrawlSection } from "./sections/crawl.js";
import { buildAiAnswersSection, type AiAnswersSection } from "./sections/ai-answers.js";
import { buildThemes, type Theme } from "./sections/themes.js";
import { significantWords } from "./words.js";
import { splitBuyers, type NonBuyerReason } from "./sections/intent.js";

const LABS = "/dataforseo_labs/google";

export interface GapEntry {
  rival: string;
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  theirPosition: number | null;
}

export interface SiteCheck {
  url: string;
  statusCode: number | null;
  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
  h1Count: number | null;
  internalLinks: number | null;
  loadSeconds: number | null;
  sizeKb: number | null;
  /** DataForSEO's own on-page checks, as a list of what failed. */
  problems: string[];
}

export interface Opportunity {
  /** Monthly searches on phrases a rival ranks for and this domain does not. */
  missedMonthlySearches: number;
  /** Those searches priced at their own cost-per-click. An estimate, labelled. */
  missedMonthlyValueUsd: number;
  /** How many of those phrases were counted. */
  keywordCount: number;
}

/**
 * The category, and how much of it this domain catches.
 *
 * The strongest honest number in the document, and the only one that does not
 * depend on finding a comparable rival: how many people search this business's
 * own category each month, set against the traffic the provider estimates the
 * domain actually receives. Both sides are returned figures.
 */
export interface CategoryDemand {
  seed: string;
  monthlySearches: number;
  keywordCount: number;
  /**
   * Phrases removed before the total was taken: people looking for a job in
   * this trade, or for a course in it. They are real searches and they are
   * not this business's market, so counting them would overstate the number
   * the whole document rests on.
   */
  excluded: { keyword: string; reason: NonBuyerReason }[];
}

export interface ProspectReport {
  domain: string;
  clientName: string;
  generatedAt: string;
  market: { locationCode: number | null; languageCode: string | null };
  visibility: DomainOverviewRow | null;
  links: BacklinkSummaryRow | null;
  topKeywords: RankedKeywordRow[];
  competitors: CompetitorRow[];
  gaps: GapEntry[];
  demand: KeywordRow[];
  categoryDemand: CategoryDemand | null;
  /** The demand, grouped into things the business could actually write. */
  themes: Theme[];
  /**
   * Who Google actually shows for the category's money terms.
   *
   * The one section that works on a prospect with no visibility at all, which
   * is precisely the prospect worth calling — and the reason a thin report
   * stopped being thin.
   */
  serpOwners: SerpOwnersSection | null;
  /**
   * Their Google profile and reviews against the others in their category.
   * Only ever filled when the profile Google returned is provably theirs —
   * a near-miss once matched a different company entirely.
   */
  local: LocalSection | null;
  /**
   * The whole site, not just the home page: how many pages, and what is broken
   * across them. The section that always has something to say, because it is
   * about their own site rather than about their standing in a market.
   */
  crawl: CrawlSection | null;
  /** Whether an assistant names them when someone asks for a recommendation. */
  aiAnswers: AiAnswersSection | null;
  /** How often the brand's own phrases are searched inside AI assistants. */
  aiDemand: { keyword: string; aiSearchVolume: number | null }[];
  site: SiteCheck | null;
  opportunity: Opportunity | null;
  /** Sections that could not be measured. Named here, absent from the document. */
  omitted: string[];
  costUsd: number;
}

/** Sum only what is actually there; null volumes contribute nothing. */
function sum(values: (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/**
 * Platforms that rank for everything, and compete with nobody.
 *
 * `competitors_domain` answers "who else appears for these phrases", and for a
 * small site the honest answer is Facebook and Wikipedia. Measured on a real
 * prospect: the raw call named facebook, instagram, wikipedia and youtube, and
 * the gap against them came out at eighty million monthly searches worth $54M.
 * A number like that in a sales document ends the conversation.
 */
const PLATFORMS = new Set([
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "wikipedia.org",
  "tiktok.com",
  "linkedin.com",
  "pinterest.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "amazon.com",
  "ebay.com",
  "google.com",
  "apple.com",
  "microsoft.com",
  "yelp.com",
  "tripadvisor.com",
  "booking.com",
  "wikiwand.com",
  "quora.com",
  "medium.com",
  "wordpress.com",
  "blogspot.com",
  "wix.com",
]);

function isPlatform(domain: string): boolean {
  if (PLATFORMS.has(domain)) return true;
  // Country editions of the same platforms: facebook.fr, amazon.de, …
  const stem = domain.split(".")[0];
  return [...PLATFORMS].some((platform) => platform.split(".")[0] === stem);
}

/**
 * Which of the returned domains are actually comparable.
 *
 * Two mechanical tests, both from numbers the provider returned. A platform is
 * dropped outright. Then a rival has to be within reach: a site with 156
 * million ranked keywords is not a competitor to one with five, and a gap
 * measured against it is a list of head terms nobody here could win. The
 * ceiling scales with the prospect so it stays right for a large client too,
 * and a floor of a few thousand keeps it from being absurdly tight for a
 * prospect that currently ranks for almost nothing.
 *
 * When nothing survives, that is the finding — the report omits the gap rather
 * than inventing an opponent.
 */
export function qualifyCompetitors(
  competitors: CompetitorRow[],
  prospectKeywords: number | null
): CompetitorRow[] {
  const ceiling = Math.max((prospectKeywords ?? 0) * 300, 5_000);
  return competitors.filter((rival) => {
    if (isPlatform(rival.domain)) return false;
    if ((rival.intersections ?? 0) < 3) return false;
    if (rival.organicKeywords === null) return false;
    return rival.organicKeywords <= ceiling;
  });
}

/**
 * Drop a gap phrase that no one in this market is really competing for.
 *
 * Qualifying the rivals removes most of the nonsense, but a national head term
 * ("the weather") can still ride in on an otherwise reasonable domain. A
 * phrase an order of magnitude beyond anything the prospect already ranks for
 * is not an opportunity, it is a different business — so it is held to a
 * ceiling set by the prospect's own best-performing keyword.
 */
export function plausibleGap(volume: number | null, bestOwnVolume: number | null): boolean {
  if (volume === null) return false;
  if (bestOwnVolume === null || bestOwnVolume <= 0) return volume <= 50_000;
  return volume <= bestOwnVolume * 100;
}

/**
 * The words this business is actually about.
 *
 * Built from the seed the operator typed plus the phrases the provider
 * returned for it. Short tokens are dropped because they are mostly function
 * words, and matching on them would let anything through.
 */
export function categoryVocabulary(seed: string, demand: KeywordRow[]): Set<string> {
  const tokens = new Set<string>();
  const add = (phrase: string) => {
    for (const word of significantWords(phrase)) tokens.add(word);
  };
  add(seed);
  for (const row of demand.slice(0, 40)) add(row.keyword);
  return tokens;
}

/**
 * Is this gap phrase even about their business?
 *
 * Qualifying the rival by size is not enough. Measured on a real prospect: an
 * events company came back with a same-sized rival that sells stickers, and
 * the gap table filled with sticker phrases. Technically true, and useless —
 * worse than useless in a document meant to show we understand the business.
 * So a gap phrase has to share a word with the category the operator named.
 */
export function onTopic(keyword: string, vocabulary: Set<string>): boolean {
  if (vocabulary.size === 0) return false;
  return significantWords(keyword).some((word) => vocabulary.has(word));
}

/**
 * What the domain is invisible for, in searches and in money.
 *
 * Deliberately conservative: only phrases where a rival ranks and this domain
 * does not, only phrases with a volume the provider actually returned, and the
 * money figure is those searches at their own cost-per-click — the price the
 * same clicks would carry in ads. No click-through curve is applied, because
 * we would be inventing the curve.
 */
export function opportunityFrom(gaps: GapEntry[]): Opportunity | null {
  const measured = gaps.filter((gap) => gap.volume !== null);
  if (measured.length === 0) return null;

  return {
    missedMonthlySearches: Math.round(sum(measured.map((gap) => gap.volume))),
    missedMonthlyValueUsd:
      Math.round(sum(measured.map((gap) => (gap.volume ?? 0) * (gap.cpc ?? 0))) * 100) / 100,
    keywordCount: measured.length,
  };
}

/** The on-page reading, flattened out of DataForSEO's nested page item. */
export function toSiteCheck(raw: unknown): SiteCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const meta = (row.meta ?? {}) as Record<string, unknown>;
  const checks = (row.checks ?? {}) as Record<string, unknown>;
  const timing = (row.page_timing ?? {}) as Record<string, unknown>;
  const url = typeof row.url === "string" ? row.url : null;
  if (!url) return null;

  const num = (value: unknown) => (typeof value === "number" ? value : null);
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

  // Only the checks that a non-technical reader can act on, in their words.
  const NAMED: [string, string][] = [
    ["no_title", "The page has no title"],
    ["title_too_long", "The title is too long for Google"],
    ["title_too_short", "The title is too short"],
    ["no_description", "The page has no description in search results"],
    ["no_h1_tag", "The page has no main heading"],
    ["no_image_alt", "Images have no description"],
    ["is_http", "The page is not secure"],
    ["canonical_to_broken", "Broken canonical link"],
    ["has_render_blocking_resources", "Files that hold up loading"],
    ["low_content_rate", "Very little text on the page"],
    ["no_favicon", "No site icon in the browser tab"],
    ["seo_friendly_url", "The page address is not search friendly"],
  ];
  const problems = NAMED.filter(([key]) =>
    // `seo_friendly_url` reads the other way round: true means it is fine.
    key === "seo_friendly_url" ? checks[key] === false : checks[key] === true
  ).map(([, label]) => label);

  const title = text(meta.title);
  const description = text(meta.description);

  return {
    url,
    statusCode: num(row.status_code),
    title,
    titleLength: title ? title.length : null,
    metaDescription: description,
    metaDescriptionLength: description ? description.length : null,
    h1Count: Array.isArray((meta.htags as Record<string, unknown>)?.h1)
      ? ((meta.htags as Record<string, unknown>).h1 as unknown[]).length
      : null,
    internalLinks: num(meta.internal_links_count),
    loadSeconds: num(timing.dom_complete) === null ? null : Number((num(timing.dom_complete)! / 1000).toFixed(2)),
    sizeKb: num(row.size) === null ? null : Math.round(num(row.size)! / 1024),
    problems,
  };
}

export interface ReportInput {
  domain: string;
  clientName?: string;
  market?: Market;
  /** How many rival domains to measure the gap against. */
  rivals?: number;
  /**
   * What the business sells, in the customer's words ("event production").
   * The one field only a person can supply; without it the demand section is
   * left out rather than guessed at from a thin site.
   */
  seed?: string;
}

/**
 * Build the whole document's data in one pass.
 *
 * Every call runs in parallel and every one is allowed to fail on its own: a
 * prospect with no backlinks at all, or a site that refuses our crawler, must
 * still produce the rest of the report rather than an error page. What failed
 * is collected in `omitted`, which the operator sees and the client does not.
 */
export async function buildProspectReport(
  client: SeoClient,
  input: ReportInput
): Promise<ProspectReport> {
  const domain = cleanDomain(input.domain);
  const market = input.market ?? {};
  const omitted: string[] = [];
  let costUsd = 0;

  async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      logger.warn({ error, domain, section: name }, "[SEO] Report section unavailable");
      omitted.push(name);
      return null;
    }
  }

  const [overview, links, ranked, rivals, demandSeed, site] = await Promise.all([
    attempt("visibility", () => client.post(`${LABS}/domain_rank_overview/live`, { target: domain }, market)),
    attempt("links", () => client.post("/backlinks/summary/live", { target: domain, internal_list_limit: 1 })),
    attempt("topKeywords", () =>
      client.post(
        `${LABS}/ranked_keywords/live`,
        { target: domain, limit: 25, order_by: ["ranked_serp_element.serp_item.etv,desc"] },
        market
      )
    ),
    attempt("competitors", () =>
      client.post(
        `${LABS}/competitors_domain/live`,
        { target: domain, limit: 10, order_by: ["intersections,desc"] },
        market
      )
    ),
    // Only when the operator says what the business sells. `keywords_for_site`
    // was tried here and is not a substitute: on a prospect with five ranked
    // keywords it returned an unrelated category for an events company. A seed the
    // operator types is the one thing in this report that needs a human, and
    // without it the section is omitted rather than filled with noise.
    input.seed?.trim()
      ? attempt("demand", () =>
          client.post(
            `${LABS}/keyword_suggestions/live`,
            { keyword: input.seed!.trim().toLowerCase(), limit: 40 },
            market
          )
        )
      : Promise.resolve(null),
    attempt("site", () => client.post("/on_page/instant_pages", { url: `https://${domain}/` })),
  ]);

  for (const response of [overview, links, ranked, rivals, demandSeed, site]) {
    costUsd += response?.costUsd ?? 0;
  }

  const visibility = overview
    ? toDomainOverviewRow(overview.rows.length ? overview.rows : overview.results)
    : null;

  const allCompetitors = rivals
    ? mapRows(rivals.rows, toCompetitorRow).filter((row) => row.domain !== domain)
    : [];
  const competitors = qualifyCompetitors(allCompetitors, visibility?.organicKeywords ?? null);
  if (allCompetitors.length > 0 && competitors.length === 0) {
    omitted.push("competitors:none-comparable");
  }

  // The gap is measured against the domains that actually compete, not against
  // a name someone typed: the top rivals by shared keywords, in their order.
  const chosen = competitors.slice(0, Math.max(1, Math.min(input.rivals ?? 3, 5)));
  const gapResponses = await Promise.all(
    chosen.map((rival) =>
      attempt(`gap:${rival.domain}`, () =>
        client.post(
          `${LABS}/domain_intersection/live`,
          {
            target1: rival.domain,
            target2: domain,
            intersections: false,
            limit: 50,
            order_by: ["keyword_data.keyword_info.search_volume,desc"],
          },
          market
        )
      )
    )
  );

  const topKeywordsRaw = ranked ? mapRows(ranked.rows, toRankedKeywordRow) : [];
  const bestOwnVolume = topKeywordsRaw.reduce<number | null>(
    (best, row) => (row.volume !== null && (best === null || row.volume > best) ? row.volume : best),
    null
  );

  const gaps: GapEntry[] = [];
  const seenGap = new Set<string>();
  gapResponses.forEach((response, index) => {
    costUsd += response?.costUsd ?? 0;
    if (!response) return;
    for (const row of mapRows(response.rows, toIntersectionRow)) {
      if (row.secondPosition !== null || row.firstPosition === null) continue;
      if (!plausibleGap(row.volume, bestOwnVolume)) continue;
      if (seenGap.has(row.keyword)) continue;
      seenGap.add(row.keyword);
      gaps.push({
        rival: chosen[index].domain,
        keyword: row.keyword,
        volume: row.volume,
        difficulty: row.difficulty,
        cpc: row.cpc,
        theirPosition: row.firstPosition,
      });
    }
  });
  gaps.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));

  const demandAll = demandSeed ? mapRows(demandSeed.rows, toKeywordRow) : [];
  // Job seekers and students are removed before anything is totalled. On the
  // first real prospect they were 810 of 5,340 "searches in your category".
  const { buyers: demand, removed: excludedDemand } = splitBuyers(demandAll);

  // Without a named category there is nothing to judge relevance against, and
  // an off-topic gap table is the one thing in this document a prospect would
  // notice immediately. No seed, no gap section.
  const vocabulary = input.seed?.trim() ? categoryVocabulary(input.seed.trim(), demand) : new Set<string>();
  const onTopicGaps = gaps.filter((gap) => onTopic(gap.keyword, vocabulary));
  if (gaps.length > 0 && onTopicGaps.length === 0) omitted.push("gaps:off-topic");

  // What people ask assistants, not only search engines. Priced per keyword,
  // so it runs on the handful of phrases the domain already ranks best for.
  const topKeywords = topKeywordsRaw;
  const aiSeeds = [...new Set(topKeywords.slice(0, 10).map((row) => row.keyword))];
  const aiResponse =
    aiSeeds.length > 0
      ? await attempt("aiDemand", () =>
          client.post(
            "/ai_optimization/ai_keyword_data/keywords_search_volume/live",
            { keywords: aiSeeds },
            market
          )
        )
      : null;
  costUsd += aiResponse?.costUsd ?? 0;

  const aiDemand = (aiResponse?.rows ?? [])
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        keyword: typeof row.keyword === "string" ? row.keyword : "",
        aiSearchVolume: typeof row.ai_search_volume === "number" ? row.ai_search_volume : null,
      };
    })
    .filter((row) => row.keyword && (row.aiSearchVolume ?? 0) > 0)
    .sort((a, b) => (b.aiSearchVolume ?? 0) - (a.aiSearchVolume ?? 0));

  // Their whole site. Cheap, always has something to say, and independent of
  // whether they rank for anything — which is why it carries a thin report.
  const crawl = await attempt("crawl", () =>
    buildCrawlSection(client, { domain, maxPages: 100, market })
  );
  costUsd += crawl?.costUsd ?? 0;

  /**
   * What an assistant says when asked for a recommendation in this category.
   *
   * One engine and the floor of three questions, deliberately. Web search is
   * what makes the answer about the real market rather than the model's
   * memory, and it is priced accordingly — about $0.03 a question against
   * $0.0006 without. Three questions on one engine is roughly a tenth of a
   * dollar, which is the whole rest of the report; more engines would make
   * this section cost more than everything else together.
   */
  const aiAnswers = input.seed?.trim()
    ? await attempt("aiAnswers", () =>
        buildAiAnswersSection(client, {
          businessName: input.clientName?.trim() || domain,
          domain,
          seed: input.seed!.trim(),
          market,
          engines: ["perplexity"],
          questions: 3,
          webSearch: true,
        })
      )
    : null;
  costUsd += aiAnswers?.costUsd ?? 0;

  // The local half. Needs a business name to ask Google Maps about, and the
  // name guard inside will refuse a profile that is not provably theirs.
  const local = input.clientName?.trim()
    ? await attempt("local", () =>
        buildLocalSection(client, {
          businessName: input.clientName!.trim(),
          domain,
          market,
        })
      )
    : null;
  costUsd += local?.costUsd ?? 0;

  // Who holds page one for the phrases their customers type. Bought last,
  // because it needs the demand set the seed produced.
  const serpOwners =
    demand.length > 0
      ? await attempt("serpOwners", () =>
          buildSerpOwnersSection(client, {
            domain,
            keywords: demand.map((row) => ({ keyword: row.keyword, volume: row.volume })),
            limit: 8,
            market,
          })
        )
      : null;
  costUsd += serpOwners?.costUsd ?? 0;

  recordSpend("prospect-report", costUsd);

  const categoryDemand: CategoryDemand | null =
    input.seed?.trim() && demand.length > 0
      ? {
          seed: input.seed.trim(),
          monthlySearches: Math.round(sum(demand.map((row) => row.volume))),
          keywordCount: demand.filter((row) => row.volume !== null).length,
          excluded: excludedDemand,
        }
      : null;

  const report: ProspectReport = {
    domain,
    clientName: input.clientName?.trim() || domain,
    generatedAt: new Date().toISOString(),
    market: { locationCode: market.locationCode ?? null, languageCode: market.languageCode ?? null },
    visibility,
    links: links ? toBacklinkSummaryRow(links.head) : null,
    topKeywords,
    competitors,
    gaps: onTopicGaps.slice(0, 40),
    demand,
    categoryDemand,
    themes: input.seed?.trim() ? buildThemes(demand, { seed: input.seed.trim() }) : [],
    serpOwners,
    local,
    crawl,
    aiAnswers,
    aiDemand,
    site: site ? toSiteCheck(site.rows[0]) : null,
    opportunity: opportunityFrom(gaps),
    omitted: [...new Set(omitted)],
    costUsd: Number(costUsd.toFixed(6)),
  };

  return auditReport(report);
}

/**
 * The pre-send pass: strip anything we cannot stand behind.
 *
 * Mechanical only, and deliberately so — this is not a judgement about whether
 * a finding is interesting, it is a check that each one rests on a number the
 * provider returned. A section that empties out here is added to `omitted`,
 * which is how the operator learns the document is thin before the client does.
 */
export function auditReport(report: ProspectReport): ProspectReport {
  const audited: ProspectReport = { ...report };
  const omitted = new Set(report.omitted);

  // A domain overview of all-nulls is not a measurement of zero visibility —
  // it is the provider having nothing, and it would read as an insult.
  if (
    audited.visibility &&
    audited.visibility.organicKeywords === null &&
    audited.visibility.organicTraffic === null
  ) {
    audited.visibility = null;
    omitted.add("visibility");
  }

  if (audited.links && audited.links.backlinks === null && audited.links.referringDomains === null) {
    audited.links = null;
    omitted.add("links");
  }

  // A keyword with no volume proves nothing to a prospect, and a table of
  // dashes reads as a tool that does not work.
  audited.topKeywords = audited.topKeywords.filter((row) => row.position !== null);
  audited.demand = audited.demand.filter((row) => row.volume !== null);
  audited.gaps = audited.gaps.filter((row) => row.volume !== null && row.theirPosition !== null);
  audited.competitors = audited.competitors.filter((row) => row.intersections !== null);

  for (const [name, empty] of [
    ["themes", audited.themes.length === 0],
    ["serpOwners", (audited.serpOwners?.keywords.length ?? 0) === 0],
    ["local", audited.local === null || audited.local.profile.found === false],
    ["crawl", audited.crawl === null || audited.crawl.pagesCrawled === null],
    ["aiAnswers", (audited.aiAnswers?.engines.length ?? 0) === 0],
    ["topKeywords", audited.topKeywords.length === 0],
    ["demand", audited.demand.length === 0],
    ["gaps", audited.gaps.length === 0],
    ["competitors", audited.competitors.length === 0],
    ["aiDemand", audited.aiDemand.length === 0],
    ["site", audited.site === null],
  ] as const) {
    if (empty) omitted.add(name);
  }

  // Both totals are recomputed from the surviving rows, never carried over
  // from the unfiltered set — that is exactly how an inflated number ships.
  audited.opportunity = opportunityFrom(audited.gaps);
  audited.themes =
    audited.themes.length > 0 && audited.demand.length > 0
      ? buildThemes(audited.demand, { seed: audited.categoryDemand?.seed })
      : [];
  audited.categoryDemand =
    audited.categoryDemand && audited.demand.length > 0
      ? {
          ...audited.categoryDemand,
          monthlySearches: Math.round(sum(audited.demand.map((row) => row.volume))),
          keywordCount: audited.demand.length,
        }
      : null;
  audited.omitted = [...omitted];
  return audited;
}
