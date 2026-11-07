/**
 * The whole-site crawl section of a prospect report.
 *
 * `on_page/instant_pages` — what the report already uses — reads one URL. It is
 * enough to say "your homepage has no description", which a prospect shrugs at.
 * This section reads the site: how many pages are missing a description, how
 * many links go nowhere, how many images nobody can search for. A count across
 * fifty pages is the difference between a remark and a finding.
 *
 * The same discipline as `report.ts` applies, and harder, because a crawl
 * produces dozens of plausible-looking integers: a figure we could not measure
 * stays null and is named in `omitted`, never rendered as a comfortable zero,
 * and this builder never throws — a prospect report must survive a crawl that
 * times out, a site that blocks the crawler, or an endpoint that changes shape.
 *
 * Money: the crawl itself is the only meaningful cost. Measured against the
 * account's own rate card, `task_post` is $0.00015 per page, tripled to
 * $0.00045 by `load_resources` (50 pages came to $0.0225), the six read-back
 * endpoints are free, and the one Lighthouse run is $0.005.
 */

import { logger } from "../../lib/logger.js";
import { SeoApiError, type Market, type SeoClient, type SeoResponse } from "../client.js";
import { cleanDomain } from "../tools.js";

/**
 * Only the two methods this section uses, so a test can hand over fixtures
 * without constructing a client or reaching the network.
 */
export type CrawlApi = Pick<SeoClient, "post" | "get">;

/**
 * A page the crawler needed longer than this to finish building.
 *
 * Derived, not returned: DataForSEO has its own `high_loading_time` flag and it
 * is far looser than anything a visitor would recognise — on the live run it
 * read 0 across fifty pages while one of them took 3.35 seconds. Three seconds
 * measured on `page_timing.dom_complete` is the line drawn here instead,
 * because it is the point past which a business owner would agree the page is
 * slow. Changing this number changes `slowPages` and nothing else.
 */
const SLOW_PAGE_MS = 3_000;

/**
 * `/on_page/pages` and `/on_page/resources` return at most 1000 items per call
 * and paginate with `search_after_token`. Rather than page through them, the
 * crawl is capped so one call always covers it — a prospect report is built
 * from a sample of the site, and a sample that needs paging is too big to be
 * worth its crawl price.
 */
const MAX_ITEMS_PER_CALL = 1_000;

const DEFAULT_MAX_PAGES = 100;

/** Roughly three minutes: past that the crawl is slower than the meeting. */
const POLL_TIMEOUT_MS = 180_000;
const POLL_FIRST_WAIT_MS = 3_000;
const POLL_MAX_WAIT_MS = 15_000;

/**
 * "Task Handed" and "Task In Queue" — the job exists but no crawler has it yet.
 *
 * Found by running this section live: the summary read a second after
 * `task_post` answered 40602, and the client turns any task code that is not
 * 20000 into a throw, so the first attempt aborted the whole section on a crawl
 * that was merely about to start. Ten seconds later the same read was a normal
 * in-progress summary. These two codes mean "wait", not "failed".
 */
const QUEUED_CODES = new Set([40601, 40602]);

/** Lighthouse reports every category on 0–1; a person reads it out of 100. */
export interface LighthouseScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  /** Largest Contentful Paint, in seconds — when the main thing appears. */
  lcpSeconds: number | null;
  /** Cumulative Layout Shift: how much the page jumps while it loads. */
  clsScore: number | null;
}

/** One problem, in the words of the person paying for the site. */
export interface CrawlFinding {
  title: string;
  detail: string;
  count: number;
}

export interface CrawlSection {
  domain: string;
  /** The crawl's own id, so a later call can re-read it for free. */
  taskId: string | null;
  pagesCrawled: number | null;
  pagesWithoutDescription: number | null;
  pagesWithoutTitle: number | null;
  duplicateTitles: number | null;
  duplicateDescriptions: number | null;
  nonIndexablePages: number | null;
  brokenLinks: number | null;
  redirectChains: number | null;
  /** Pages slower than `SLOW_PAGE_MS`. Counted here, not flagged by the API. */
  slowPages: number | null;
  pagesWithoutH1: number | null;
  imagesWithoutAlt: number | null;
  totalInternalLinks: number | null;
  averageLoadSeconds: number | null;
  lighthouse: LighthouseScores | null;
  /** Problems that actually occurred, worst first. */
  findings: CrawlFinding[];
  /** What could not be measured, and why. For the operator, not the client. */
  omitted: string[];
  costUsd: number;
}

export interface CrawlInput {
  domain: string;
  /** How much of the site to read. Clamped to what one page of results holds. */
  maxPages?: number;
  market?: Market;
  /** Test seam: the poll's wait, so a fixture run does not take three minutes. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the poll's clock. */
  now?: () => number;
}

type Bag = Record<string, unknown>;

const bag = (value: unknown): Bag => (value && typeof value === "object" ? (value as Bag) : {});

const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The counts DataForSEO keeps in the crawl summary.
 *
 * Two different places, and the distinction matters. `page_metrics.checks.*`
 * counts *pages* that failed a check, so `no_description: 4` means four pages.
 * `page_metrics.*` holds the site-wide totals — 1367 internal links, 49 broken
 * ones — which are not page counts at all. Reading one as the other is the
 * easiest way to put a wrong number in front of a prospect.
 */
export interface CrawlSummary {
  finished: boolean;
  /** Why the crawler stopped — `limit_exceeded` means the site is larger. */
  stopReason: string | null;
  pagesCrawled: number | null;
  pagesWithoutDescription: number | null;
  pagesWithoutTitle: number | null;
  pagesWithoutH1: number | null;
  redirectChains: number | null;
  nonIndexablePages: number | null;
  brokenLinks: number | null;
  totalInternalLinks: number | null;
  duplicateTitles: number | null;
  duplicateDescriptions: number | null;
}

export function readCrawlSummary(raw: unknown): CrawlSummary | null {
  const head = bag(raw);
  if (typeof head.crawl_progress !== "string") return null;

  const status = bag(head.crawl_status);
  const metrics = bag(head.page_metrics);
  const checks = bag(metrics.checks);

  return {
    finished: head.crawl_progress === "finished",
    stopReason: typeof head.crawl_stop_reason === "string" ? head.crawl_stop_reason : null,
    pagesCrawled: num(status.pages_crawled),
    pagesWithoutDescription: num(checks.no_description),
    pagesWithoutTitle: num(checks.no_title),
    pagesWithoutH1: num(checks.no_h1_tag),
    // `redirect_chain` counts the pages sitting inside a chain. The dedicated
    // `/on_page/redirect_chains` endpoint counts the chains themselves, which
    // is a different unit from every other figure in this section.
    redirectChains: num(checks.redirect_chain),
    nonIndexablePages: num(metrics.non_indexable),
    brokenLinks: num(metrics.broken_links),
    totalInternalLinks: num(metrics.links_internal),
    duplicateTitles: num(metrics.duplicate_title),
    duplicateDescriptions: num(metrics.duplicate_description),
  };
}

/** Pages slower than the threshold. Null when no page reported a timing. */
export function countSlowPages(pages: unknown[]): number | null {
  const timings = pageTimings(pages);
  return timings.length === 0 ? null : timings.filter((ms) => ms > SLOW_PAGE_MS).length;
}

/**
 * The mean of what the crawler measured, to two decimals.
 *
 * Derived from `page_timing.dom_complete` over the pages that reported one —
 * a page the crawler could not time (a 404 among the crawled URLs, for
 * instance) is left out of the mean rather than counted as instant.
 */
export function averageLoadSeconds(pages: unknown[]): number | null {
  const timings = pageTimings(pages);
  if (timings.length === 0) return null;
  const mean = timings.reduce((total, ms) => total + ms, 0) / timings.length;
  return Number((mean / 1000).toFixed(2));
}

function pageTimings(pages: unknown[]): number[] {
  const out: number[] = [];
  for (const page of pages) {
    const ms = num(bag(bag(page).page_timing).dom_complete);
    if (ms !== null) out.push(ms);
  }
  return out;
}

/**
 * Images the crawler saw with no alternative text.
 *
 * Missing alt arrives as `""`, not as an absent key, so a server-side
 * `alternative_text = null` filter returns nothing — it was tried against the
 * live crawl and answered 0 while 35 images had an empty string. The count is
 * therefore made here, over the items, which is exact only while the response
 * holds them all; a truncated list returns null rather than an undercount.
 */
export function countImagesWithoutAlt(response: SeoResponse): number | null {
  const total = num(bag(response.head).total_items_count);
  const images = response.rows.filter((row) => bag(row).resource_type === "image");
  if (total !== null && total > response.rows.length) return null;

  return images.filter((row) => {
    const alt = bag(bag(row).meta).alternative_text;
    return typeof alt !== "string" || alt.trim() === "";
  }).length;
}

/**
 * Lighthouse's own report, reduced to the six numbers a person recognises.
 *
 * Category scores arrive as 0–1 floats and become whole percentages; the two
 * Core Web Vitals come out of `audits`, where LCP is in milliseconds and CLS
 * is already the unitless score Google publishes.
 */
export function readLighthouse(raw: unknown): LighthouseScores | null {
  const head = bag(raw);
  const categories = bag(head.categories);
  const audits = bag(head.audits);
  if (Object.keys(categories).length === 0 && Object.keys(audits).length === 0) return null;

  const percent = (key: string): number | null => {
    const score = num(bag(categories[key]).score);
    return score === null ? null : Math.round(score * 100);
  };
  const metric = (key: string): number | null => num(bag(audits[key]).numericValue);

  const lcpMs = metric("largest-contentful-paint");
  const cls = metric("cumulative-layout-shift");

  return {
    performance: percent("performance"),
    accessibility: percent("accessibility"),
    bestPractices: percent("best-practices"),
    seo: percent("seo"),
    lcpSeconds: lcpMs === null ? null : Number((lcpMs / 1000).toFixed(2)),
    clsScore: cls === null ? null : Number(cls.toFixed(3)),
  };
}

/**
 * The problem list, in the order a business owner would care about it.
 *
 * A broken link costs a visitor today; a missing image description costs a
 * little search traffic. Only a problem that actually occurred is listed — a
 * count of zero is a good result, and a report that lists good results as
 * findings teaches the reader to skim past the real ones. A null count is not
 * a zero: it means the figure was never measured, and it is left out too.
 */
export function buildFindings(section: Pick<CrawlSection,
  | "brokenLinks"
  | "pagesWithoutTitle"
  | "pagesWithoutDescription"
  | "duplicateTitles"
  | "duplicateDescriptions"
  | "nonIndexablePages"
  | "pagesWithoutH1"
  | "redirectChains"
  | "slowPages"
  | "imagesWithoutAlt"
>): CrawlFinding[] {
  const catalogue: [number | null, string, string][] = [
    [
      section.brokenLinks,
      "Broken links",
      "Links on the site that lead to a page that no longer exists. Anyone who clicks them gets an error message instead of what they were looking for.",
    ],
    [
      section.nonIndexablePages,
      "Pages kept out of Google",
      "Pages that block Google from adding them to search results, so nobody will reach them through search.",
    ],
    [
      section.pagesWithoutTitle,
      "Pages without a title",
      "Without a title Google does not know what the page is about, and it shows the page address in search results instead.",
    ],
    [
      section.pagesWithoutDescription,
      "Pages without a search result description",
      "The two lines shown under the page name on Google are missing, so Google picks a random piece of text from the page instead.",
    ],
    [
      section.duplicateTitles,
      "Pages with the same title",
      "Several pages carry an identical title, and Google struggles to decide which one to show.",
    ],
    [
      section.duplicateDescriptions,
      "Pages with the same description",
      "The same description repeats across several pages, so they all look alike in search results.",
    ],
    [
      section.slowPages,
      "Slow pages",
      "Pages that took more than three seconds to open. Some visitors leave before they see anything.",
    ],
    [
      section.redirectChains,
      "Pages behind several redirects",
      "Addresses that send the visitor through intermediate stops before the destination. This slows loading.",
    ],
    [
      section.pagesWithoutH1,
      "Pages without a main heading",
      "There is no large heading at the top of the page explaining what it is about, which makes things harder for visitors and for Google.",
    ],
  ];

  return catalogue
    .filter(([count]) => count !== null && count > 0)
    .map(([count, title, detail]) => ({ title, detail, count: count as number }));
}

/**
 * Why missing alt text is measured but never stated as a fault.
 *
 * An empty `alt` is the *correct* markup for an image that adds nothing a
 * screen reader needs — a background photograph, a logo printed next to its
 * own name, a video thumbnail inside a link that already carries a label. The
 * crawler cannot see intent, so it reports all of them the same way.
 *
 * Checked against a real client site: forty images came back "without alt",
 * and every single one was deliberate and right. Put in a client's document
 * that is forty accusations against a site that was built properly, which is
 * exactly the kind of wrong claim that ends a sales conversation.
 *
 * So the number stays in `CrawlSection` — it is a true count, and the work
 * list uses it to ask a person to look — and it stays out of the findings a
 * client reads.
 */
export const IMAGES_WITHOUT_ALT_IS_NOT_A_FINDING = true;

/**
 * Run a whole crawl and read it back.
 *
 * Four phases, and each one degrades on its own: queue the crawl, wait for it,
 * read the free endpoints, measure the homepage. A failure anywhere leaves the
 * fields it would have filled at null and puts its name in `omitted`, so the
 * operator can see the report is thin before the client does.
 */
/**
 * Paths that are never a real broken link.
 *
 * Cloudflare rewrites every `mailto:` on a proxied site into
 * `/cdn-cgi/l/email-protection#<hash>` and decodes it again with JavaScript in
 * the visitor's browser. A crawler does not run that script, so the bare path
 * answers 404 and every email link on the site is reported broken.
 *
 * Measured on a real client: 89 "broken links", all of them this, on a site
 * with no broken links at all. Counting them would have told a prospect their
 * site was falling apart — the single worst thing a sales document can get
 * wrong, and the reason this list exists rather than a nicer-looking total.
 */
const INFRASTRUCTURE_PATHS = [/\/cdn-cgi\//i, /\/_next\/image\?/i, /\/__vercel\//i];

export function isInfrastructureLink(url: string): boolean {
  return INFRASTRUCTURE_PATHS.some((pattern) => pattern.test(url));
}

/**
 * Broken links the site's owner could actually fix.
 *
 * When the item list came back whole, the infrastructure stubs are subtracted
 * from it. When the server reported more than it returned, the ratio in the
 * sample is applied to the total rather than pretending the sample is the
 * whole — and the result is rounded down, because over-reporting a fault is
 * the failure that matters here.
 */
export function realBrokenLinks(response: SeoResponse, total: number | null): number | null {
  const rows = response.rows as Record<string, unknown>[];
  if (rows.length === 0) return total;

  const target = (row: Record<string, unknown>): string =>
    [row.link_to, row.url, row.domain_to].find((value) => typeof value === "string") as string ?? "";

  const real = rows.filter((row) => !isInfrastructureLink(target(row))).length;
  if (total === null || total <= rows.length) return real;

  return Math.floor((real / rows.length) * total);
}

export async function buildCrawlSection(
  client: CrawlApi,
  input: CrawlInput
): Promise<CrawlSection> {
  const domain = cleanDomain(input.domain);
  const market = input.market ?? {};
  const sleep = input.sleep ?? wait;
  const clock = input.now ?? Date.now;
  const maxPages = Math.max(1, Math.min(Math.round(input.maxPages ?? DEFAULT_MAX_PAGES), MAX_ITEMS_PER_CALL));

  const omitted: string[] = [];
  let costUsd = 0;

  const empty = (): CrawlSection => ({
    domain,
    taskId: null,
    pagesCrawled: null,
    pagesWithoutDescription: null,
    pagesWithoutTitle: null,
    duplicateTitles: null,
    duplicateDescriptions: null,
    nonIndexablePages: null,
    brokenLinks: null,
    redirectChains: null,
    slowPages: null,
    pagesWithoutH1: null,
    imagesWithoutAlt: null,
    totalInternalLinks: null,
    averageLoadSeconds: null,
    lighthouse: null,
    findings: [],
    omitted: [...new Set(omitted)],
    costUsd: Number(costUsd.toFixed(6)),
  });

  async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      logger.warn({ error, domain, section: name }, "[SEO] Crawl section unavailable");
      omitted.push(name);
      return null;
    }
  }

  function charge(response: SeoResponse | null): void {
    costUsd += response?.costUsd ?? 0;
  }

  if (!domain) {
    omitted.push("crawl:no-domain");
    return empty();
  }

  // `load_resources` is what makes the images visible to `/on_page/resources`,
  // and it triples the per-page price. Worth it: "your images cannot be found
  // in image search" is a finding a business owner acts on, and the whole
  // fifty-page crawl still costs about two cents.
  const posted = await attempt("crawl:task_post", () =>
    client.post(
      "/on_page/task_post",
      { target: domain, max_crawl_pages: maxPages, load_resources: true },
      market
    )
  );
  charge(posted);

  const taskId = posted?.taskId ?? null;
  if (!taskId) {
    omitted.push("crawl:no-task-id");
    return { ...empty(), taskId: null };
  }

  // The crawl runs on DataForSEO's side; the summary is free, so polling it
  // costs only time. Backing off keeps a three-minute wait to a dozen calls
  // instead of sixty.
  let summary: CrawlSummary | null = null;
  const deadline = clock() + POLL_TIMEOUT_MS;
  let interval = POLL_FIRST_WAIT_MS;
  while (clock() < deadline) {
    let response: SeoResponse | null = null;
    try {
      response = await client.get(`/on_page/summary/${taskId}`);
    } catch (error) {
      const queued = error instanceof SeoApiError && QUEUED_CODES.has(error.providerCode ?? 0);
      if (!queued) {
        // A summary that will not load at all is not worth sixty more
        // attempts: the crawl is running, but nothing here can read it.
        logger.warn({ error, domain, section: "crawl:summary" }, "[SEO] Crawl section unavailable");
        omitted.push("crawl:summary");
        break;
      }
    }

    if (response) {
      charge(response);
      const reading = readCrawlSummary(response.head);
      if (reading) summary = reading;
      if (reading?.finished) break;
    }

    await sleep(interval);
    interval = Math.min(interval * 2, POLL_MAX_WAIT_MS);
  }

  if (!summary) {
    omitted.push("crawl:unreadable");
    return { ...empty(), taskId };
  }
  if (!summary.finished) {
    // Every count below is still a real reading — of the pages crawled so far,
    // which `pagesCrawled` states. Named so the operator knows it is partial.
    omitted.push("crawl:timeout");
  }
  if (summary.stopReason === "limit_exceeded") {
    // The site has more pages than we paid to read. The counts are true of the
    // sample, not of the whole site, and a reader must be told which.
    omitted.push("crawl:page-limit-reached");
  }

  const body = { id: taskId, limit: MAX_ITEMS_PER_CALL };
  const [pages, duplicateTitles, duplicateDescriptions, nonIndexable, brokenLinks, images, lighthouse] =
    await Promise.all([
      attempt("crawl:pages", () => client.post("/on_page/pages", body, market)),
      // The endpoint rejects `type: "title"` with "Invalid Field: 'type'" — it
      // wants the name of the check, not the name of the tag.
      attempt("crawl:duplicate_titles", () =>
        client.post("/on_page/duplicate_tags", { id: taskId, type: "duplicate_title", limit: 1 }, market)
      ),
      attempt("crawl:duplicate_descriptions", () =>
        client.post(
          "/on_page/duplicate_tags",
          { id: taskId, type: "duplicate_description", limit: 1 },
          market
        )
      ),
      attempt("crawl:non_indexable", () =>
        client.post("/on_page/non_indexable", { id: taskId, limit: 1 }, market)
      ),
      // `/on_page/links` caps its item list at 1000, so the server's
      // `total_items_count` is the exact figure. The items are pulled as well
      // rather than just the count, because some of what it calls broken is
      // not — see `realBrokenLinks`.
      attempt("crawl:links", () =>
        client.post(
          "/on_page/links",
          { id: taskId, limit: MAX_ITEMS_PER_CALL, filters: [["is_broken", "=", true]] },
          market
        )
      ),
      attempt("crawl:resources", () =>
        client.post(
          "/on_page/resources",
          { id: taskId, limit: MAX_ITEMS_PER_CALL, filters: [["resource_type", "=", "image"]] },
          market
        )
      ),
      attempt("crawl:lighthouse", () =>
        client.post("/on_page/lighthouse/live/json", { url: `https://${domain}/`, for_mobile: false }, market)
      ),
    ]);

  for (const response of [
    pages,
    duplicateTitles,
    duplicateDescriptions,
    nonIndexable,
    brokenLinks,
    images,
    lighthouse,
  ]) {
    charge(response);
  }

  const totalItems = (response: SeoResponse | null): number | null =>
    response ? num(bag(response.head).total_items_count) : null;
    /** `duplicate_tags` answers in pages, under its own key. */
  const totalPages = (response: SeoResponse | null): number | null =>
    response ? num(bag(response.head).total_pages_count) : null;

  const imagesWithoutAlt = images ? countImagesWithoutAlt(images) : null;
  if (images && imagesWithoutAlt === null) omitted.push("crawl:images-truncated");

  const measured = {
    pagesCrawled: summary.pagesCrawled,
    pagesWithoutDescription: summary.pagesWithoutDescription,
    pagesWithoutTitle: summary.pagesWithoutTitle,
    // The dedicated endpoint is the one whose job this is; the summary carries
    // the same total and stands in when the call fails. Verified equal on the
    // live crawl, both 0.
    duplicateTitles: totalPages(duplicateTitles) ?? summary.duplicateTitles,
    duplicateDescriptions: totalPages(duplicateDescriptions) ?? summary.duplicateDescriptions,
    nonIndexablePages: totalItems(nonIndexable) ?? summary.nonIndexablePages,
    brokenLinks: brokenLinks
      ? realBrokenLinks(brokenLinks, totalItems(brokenLinks))
      : summary.brokenLinks,
    redirectChains: summary.redirectChains,
    slowPages: pages ? countSlowPages(pages.rows) : null,
    pagesWithoutH1: summary.pagesWithoutH1,
    imagesWithoutAlt,
    totalInternalLinks: summary.totalInternalLinks,
    averageLoadSeconds: pages ? averageLoadSeconds(pages.rows) : null,
  };

  return {
    domain,
    taskId,
    ...measured,
    lighthouse: lighthouse ? readLighthouse(lighthouse.head) : null,
    findings: buildFindings(measured),
    omitted: [...new Set(omitted)],
    costUsd: Number(costUsd.toFixed(6)),
  };
}
