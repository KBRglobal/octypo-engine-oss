import { describe, expect, it } from "vitest";

import { readEnvelope, SeoApiError, type SeoResponse } from "../client.js";
import {
  averageLoadSeconds,
  buildCrawlSection,
  buildFindings,
  countImagesWithoutAlt,
  countSlowPages,
  isInfrastructureLink,
  readCrawlSummary,
  readLighthouse,
  realBrokenLinks,
  type CrawlApi,
} from "./crawl.js";

/**
 * Every fixture below is a trimmed copy of what DataForSEO actually returned
 * for a 50-page crawl of acme-events.co.uk — the same site the prospect report's
 * own guards were measured against. Nothing here is invented, and the two
 * shapes that cost the most to discover (an empty-string alt, a `type` field
 * that wants the check's name) are the ones the tests pin down.
 */

const TASK_ID = "09171424-2351-0216-0000-97d9694a046b";

/** Wrap a captured `result[0]` the way the live envelope carries it. */
function reply(result: Record<string, unknown> | null, cost = 0): SeoResponse {
  return readEnvelope({
    status_code: 20000,
    status_message: "Ok.",
    cost,
    tasks: [
      {
        id: TASK_ID,
        status_code: 20000,
        status_message: "Ok.",
        result: result === null ? null : [result],
      },
    ],
  });
}

const SUMMARY_FINISHED = {
  crawl_progress: "finished",
  crawl_status: { max_crawl_pages: 50, pages_in_queue: 0, pages_crawled: 50 },
  crawl_stop_reason: "limit_exceeded",
  page_metrics: {
    links_external: 310,
    links_internal: 1367,
    duplicate_title: 0,
    duplicate_description: 0,
    broken_links: 49,
    broken_resources: 0,
    onpage_score: 90.7,
    non_indexable: 0,
    checks: {
      no_description: 0,
      no_title: 0,
      no_h1_tag: 0,
      no_image_alt: 31,
      redirect_chain: 0,
      high_loading_time: 0,
      low_content_rate: 44,
    },
  },
};

const SUMMARY_RUNNING = {
  crawl_progress: "in_progress",
  crawl_status: { max_crawl_pages: 50, pages_in_queue: 53, pages_crawled: 17 },
  crawl_stop_reason: null,
  page_metrics: { links_internal: 246, broken_links: 0, non_indexable: 0, checks: { no_title: 0 } },
};

/** Three real pages plus the real `resource_type: "broken"` item, untimed. */
const PAGES = {
  total_items_count: 4,
  items_count: 4,
  items: [
    { resource_type: "broken", url: "https://acme-events.co.uk/cdn-cgi/l/email-protection" },
    { resource_type: "html", url: "https://acme-events.co.uk/", page_timing: { dom_complete: 1566 } },
    { resource_type: "html", url: "https://acme-events.co.uk/about/", page_timing: { dom_complete: 978 } },
    { resource_type: "html", url: "https://acme-events.co.uk/projects/", page_timing: { dom_complete: 3345 } },
  ],
};

const IMAGES = {
  total_items_count: 3,
  items_count: 3,
  items: [
    { resource_type: "image", meta: { alternative_text: "Acme Events logo" } },
    { resource_type: "image", meta: { alternative_text: "" } },
    { resource_type: "image", meta: { alternative_text: "   " } },
  ],
};

const LIGHTHOUSE = {
  requestedUrl: "https://acme-events.co.uk/",
  finalUrl: "https://acme-events.co.uk/",
  categories: {
    performance: { title: "Performance", score: 1 },
    accessibility: { title: "Accessibility", score: 1 },
    "best-practices": { title: "Best Practices", score: 1 },
    seo: { title: "SEO", score: 1 },
  },
  audits: {
    "largest-contentful-paint": { numericValue: 405.9425, numericUnit: "millisecond", score: 1 },
    "cumulative-layout-shift": { numericValue: 0.007077231415812976, score: 1 },
  },
};

/** An empty list arrives as `items: null`, not as `[]`. */
const EMPTY_LIST = { total_items_count: 0, items_count: 0, items: null };
const NO_DUPLICATES = { total_pages_count: 0, pages_count: 0, items_count: 0, items: null };
const BROKEN_LINKS = { total_items_count: 49, items_count: 1, items: [{ type: "anchor", is_broken: true }] };

describe("readCrawlSummary", () => {
  it("reads the finished crawl's own counts", () => {
    expect(readCrawlSummary(SUMMARY_FINISHED)).toEqual({
      finished: true,
      stopReason: "limit_exceeded",
      pagesCrawled: 50,
      pagesWithoutDescription: 0,
      pagesWithoutTitle: 0,
      pagesWithoutH1: 0,
      redirectChains: 0,
      nonIndexablePages: 0,
      brokenLinks: 49,
      totalInternalLinks: 1367,
      duplicateTitles: 0,
      duplicateDescriptions: 0,
    });
  });

  // `checks.*` counts pages and `page_metrics.*` counts the site's totals.
  // Reading 1367 internal links as a page count is the mistake this pins.
  it("keeps the page counts and the site totals apart", () => {
    const summary = readCrawlSummary(SUMMARY_FINISHED)!;
    expect(summary.pagesWithoutDescription).toBe(0);
    expect(summary.totalInternalLinks).toBe(1367);
  });

  it("reports a missing figure as null rather than zero", () => {
    const summary = readCrawlSummary({ crawl_progress: "finished" });
    expect(summary?.pagesCrawled).toBeNull();
    expect(summary?.brokenLinks).toBeNull();
  });

  it("returns nothing for a body that is not a crawl summary", () => {
    expect(readCrawlSummary({ total_items_count: 0 })).toBeNull();
  });
});

describe("countSlowPages and averageLoadSeconds", () => {
  it("counts only the pages past the threshold", () => {
    expect(countSlowPages(PAGES.items)).toBe(1);
  });

  // The crawled 404 has no `page_timing` at all; counted as instant it would
  // pull the average down and understate how slow the site is.
  it("leaves an untimed page out of the average instead of calling it instant", () => {
    expect(averageLoadSeconds(PAGES.items)).toBe(1.96);
  });

  it("reports nothing rather than zero when no page was timed", () => {
    expect(averageLoadSeconds([{ resource_type: "broken" }])).toBeNull();
    expect(countSlowPages([])).toBeNull();
  });
});

describe("countImagesWithoutAlt", () => {
  // Measured live: 35 of 146 images had `alternative_text: ""`, and a
  // server-side `alternative_text = null` filter matched none of them.
  it("treats an empty alt as a missing one", () => {
    expect(countImagesWithoutAlt(reply(IMAGES))).toBe(2);
  });

  it("refuses to report a total from a truncated list", () => {
    expect(countImagesWithoutAlt(reply({ ...IMAGES, total_items_count: 146 }))).toBeNull();
  });
});

describe("readLighthouse", () => {
  it("turns the 0-1 scores into percentages and the vitals into seconds", () => {
    expect(readLighthouse(LIGHTHOUSE)).toEqual({
      performance: 100,
      accessibility: 100,
      bestPractices: 100,
      seo: 100,
      lcpSeconds: 0.41,
      clsScore: 0.007,
    });
  });

  it("keeps a category it did not get as null", () => {
    const scores = readLighthouse({ categories: { seo: { score: 0.92 } }, audits: {} });
    expect(scores).toMatchObject({ seo: 92, performance: null, lcpSeconds: null });
  });

  it("returns nothing when the run produced no report", () => {
    expect(readLighthouse({ requestedUrl: "https://example.com/" })).toBeNull();
  });
});

describe("buildFindings", () => {
  const nothing = {
    brokenLinks: 0,
    pagesWithoutTitle: 0,
    pagesWithoutDescription: 0,
    duplicateTitles: 0,
    duplicateDescriptions: 0,
    nonIndexablePages: 0,
    pagesWithoutH1: 0,
    redirectChains: 0,
    slowPages: 0,
    imagesWithoutAlt: 0,
  };

  it("lists nothing when nothing is wrong", () => {
    expect(buildFindings(nothing)).toEqual([]);
  });

  it("never lists a figure that was not measured", () => {
    expect(buildFindings({ ...nothing, brokenLinks: null, slowPages: null })).toEqual([]);
  });

  it("lists what the live crawl actually found, worst first", () => {
    const findings = buildFindings({ ...nothing, brokenLinks: 49, slowPages: 1, imagesWithoutAlt: 35 });
    expect(findings.map((finding) => [finding.title, finding.count])).toEqual([
      // Missing alt text is measured but deliberately not a finding: an empty
      // alt is correct for a decorative image and the crawler cannot tell.
      ["Broken links", 49],
      ["Slow pages", 1],
    ]);
  });

  it("writes for a business owner, not a developer", () => {
    const [finding] = buildFindings({ ...nothing, pagesWithoutDescription: 4 });
    expect(finding.detail).toContain("Google");
    expect(finding.detail).not.toMatch(/meta|description|tag|<|>/i);
  });
});

/** A client that replays the captured responses, and counts what was asked. */
function stubClient(overrides: Partial<Record<string, SeoResponse | Error>> = {}): {
  client: CrawlApi;
  calls: string[];
  bodies: Record<string, Record<string, unknown>>;
} {
  const calls: string[] = [];
  const bodies: Record<string, Record<string, unknown>> = {};
  let polls = 0;

  const canned: Record<string, () => SeoResponse> = {
    "/on_page/task_post": () => reply(null, 0.0225),
    "/on_page/pages": () => reply(PAGES),
    "/on_page/duplicate_tags": () => reply(NO_DUPLICATES),
    "/on_page/non_indexable": () => reply(EMPTY_LIST),
    "/on_page/links": () => reply(BROKEN_LINKS),
    "/on_page/resources": () => reply(IMAGES),
    "/on_page/lighthouse/live/json": () => reply(LIGHTHOUSE, 0.005),
  };

  const answer = (path: string): SeoResponse => {
    const override = overrides[path];
    if (override instanceof Error) throw override;
    if (override) return override;
    const make = canned[path];
    if (!make) throw new Error(`unexpected path ${path}`);
    return make();
  };

  const client: CrawlApi = {
    async post(path: string, params: Record<string, unknown>) {
      calls.push(path);
      bodies[path] = params;
      return answer(path) as never;
    },
    async get(path: string) {
      calls.push(path);
      const override = overrides["summary"];
      if (override instanceof Error) throw override;
      // The live crawl reported `in_progress` for about two minutes before it
      // reported `finished`; the poll has to survive that, not the first read.
      polls += 1;
      return reply(polls < 3 ? SUMMARY_RUNNING : SUMMARY_FINISHED) as never;
    },
  };

  return { client, calls, bodies };
}

const noWait = { sleep: async () => {}, now: () => Date.now() };

describe("buildCrawlSection", () => {
  it("reproduces the live reading of acme-events.co.uk", async () => {
    const { client, bodies } = stubClient();
    const section = await buildCrawlSection(client, { domain: "https://acme-events.co.uk/", maxPages: 50, ...noWait });

    expect(section).toMatchObject({
      domain: "acme-events.co.uk",
      taskId: TASK_ID,
      pagesCrawled: 50,
      pagesWithoutDescription: 0,
      pagesWithoutTitle: 0,
      duplicateTitles: 0,
      duplicateDescriptions: 0,
      nonIndexablePages: 0,
      brokenLinks: 49,
      redirectChains: 0,
      slowPages: 1,
      pagesWithoutH1: 0,
      imagesWithoutAlt: 2,
      totalInternalLinks: 1367,
      averageLoadSeconds: 1.96,
      lighthouse: { performance: 100, seo: 100, lcpSeconds: 0.41, clsScore: 0.007 },
    });
    // No "images without alt": measured, kept in the section, never stated to
    // a client as a fault, because an empty alt is often the correct markup.
    expect(section.findings.map((finding) => finding.title)).toEqual([
      "Broken links",
      "Slow pages",
    ]);
    // The crawl and the one Lighthouse run; the six read-backs are free.
    expect(section.costUsd).toBeCloseTo(0.0275, 6);

    expect(bodies["/on_page/task_post"]).toMatchObject({ target: "acme-events.co.uk", max_crawl_pages: 50 });
    // Not "title": the endpoint answers "Invalid Field: 'type'" for that.
    expect(bodies["/on_page/duplicate_tags"]).toMatchObject({ type: "duplicate_description" });
  });

  // The site had more than the fifty pages we paid for, so every count is a
  // count over the sample. The operator has to be told before the client is.
  it("says so when the crawl stopped at the page limit", async () => {
    const { client } = stubClient();
    const section = await buildCrawlSection(client, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(section.omitted).toContain("crawl:page-limit-reached");
  });

  it("polls until the crawl reports finished", async () => {
    const { client, calls } = stubClient();
    await buildCrawlSection(client, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(calls.filter((path) => path.startsWith("/on_page/summary/"))).toHaveLength(3);
  });

  // The live run failed here first: the summary read a second after posting
  // answers "Task In Queue", the client throws on it, and the whole section
  // came back empty for a crawl that was simply about to start.
  it("waits out the seconds the task spends in the provider's queue", async () => {
    const { client } = stubClient();
    let reads = 0;
    const queued: CrawlApi = {
      post: client.post.bind(client),
      async get() {
        reads += 1;
        if (reads === 1) throw new SeoApiError("Task In Queue.", 502, 40602);
        return reply(SUMMARY_FINISHED) as never;
      },
    };
    const section = await buildCrawlSection(queued, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(section.pagesCrawled).toBe(50);
    expect(section.omitted).not.toContain("crawl:summary");
  });

  it("stops polling when the summary fails for a reason that is not the queue", async () => {
    const { client, calls } = stubClient();
    const refused: CrawlApi = {
      post: client.post.bind(client),
      async get(): Promise<never> {
        throw new SeoApiError("Task Not Found.", 502, 40401);
      },
    };
    const section = await buildCrawlSection(refused, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(section.omitted).toEqual(expect.arrayContaining(["crawl:summary", "crawl:unreadable"]));
    // One attempt, and none of the free read-backs on a crawl we cannot read.
    expect(calls).toEqual(["/on_page/task_post"]);
  });

  it("returns what it has, named, when the crawl outlasts the wait", async () => {
    const { client } = stubClient({ summary: undefined });
    const stalled: CrawlApi = {
      post: client.post.bind(client),
      async get() {
        return reply(SUMMARY_RUNNING) as never;
      },
    };
    let clock = 0;
    const section = await buildCrawlSection(stalled, {
      domain: "acme-events.co.uk",
      maxPages: 50,
      sleep: async () => {},
      // Each read advances the clock, so the deadline is reached rather than
      // spun on forever.
      now: () => (clock += 30_000),
    });
    // Still a real reading — of the seventeen pages crawled so far, which
    // `pagesCrawled` states and `omitted` warns about.
    expect(section.omitted).toContain("crawl:timeout");
    expect(section.pagesCrawled).toBe(17);
    expect(section.totalInternalLinks).toBe(246);
    expect(section.findings.length).toBeGreaterThan(0);
  });

  it("never throws when the crawl cannot even be queued", async () => {
    const { client } = stubClient({ "/on_page/task_post": new Error("payment required") });
    const section = await buildCrawlSection(client, { domain: "acme-events.co.uk", ...noWait });
    expect(section.taskId).toBeNull();
    expect(section.pagesCrawled).toBeNull();
    expect(section.omitted).toEqual(expect.arrayContaining(["crawl:task_post", "crawl:no-task-id"]));
  });

  // One endpoint going down must cost its own field and nothing else.
  it("keeps the rest of the section when a single read-back fails", async () => {
    const { client } = stubClient({ "/on_page/lighthouse/live/json": new Error("timeout") });
    const section = await buildCrawlSection(client, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(section.lighthouse).toBeNull();
    expect(section.omitted).toContain("crawl:lighthouse");
    expect(section.brokenLinks).toBe(49);
  });

  // Losing `/on_page/links` must not silently swap in a different question:
  // the summary's own site-wide broken-link total is the same measurement.
  it("falls back to the summary's total when the links call fails", async () => {
    const { client } = stubClient({ "/on_page/links": new Error("nope") });
    const section = await buildCrawlSection(client, { domain: "acme-events.co.uk", maxPages: 50, ...noWait });
    expect(section.brokenLinks).toBe(49);
    expect(section.omitted).toContain("crawl:links");
  });

  it("refuses a request with no domain instead of crawling nothing", async () => {
    const { client, calls } = stubClient();
    const section = await buildCrawlSection(client, { domain: "   ", ...noWait });
    expect(calls).toEqual([]);
    expect(section.omitted).toContain("crawl:no-domain");
    expect(section.costUsd).toBe(0);
  });
});

describe("broken links that are not broken", () => {
  const link = (url: string) => ({ link_to: url, page_from: "https://x.co.uk/" });
  const response = (urls: string[], total: number | null) =>
    ({
      rows: urls.map(link),
      head: { total_items_count: total },
      results: [],
      costUsd: 0,
      taskId: null,
      statusMessage: "Ok.",
    }) as never;

  // Measured on a real client site: 89 reported broken links, every one of
  // them Cloudflare's email obfuscation, on a site with none. Telling a
  // prospect their site is falling apart when it is not ends the deal.
  it("does not count Cloudflare's email obfuscation", () => {
    expect(isInfrastructureLink("https://x.co.uk/cdn-cgi/l/email-protection#a1b2")).toBe(true);
    expect(isInfrastructureLink("https://x.co.uk/about")).toBe(false);

    const urls = Array.from({ length: 89 }, () => "https://x.co.uk/cdn-cgi/l/email-protection");
    expect(realBrokenLinks(response(urls, 89), 89)).toBe(0);
  });

  it("still counts the links that really are broken", () => {
    const urls = [
      "https://x.co.uk/cdn-cgi/l/email-protection",
      "https://x.co.uk/gone",
      "https://other.com/missing",
    ];
    expect(realBrokenLinks(response(urls, 3), 3)).toBe(2);
  });

  // The item list is capped; the server's total is not. Scaling the sample is
  // an estimate, so it rounds down — over-reporting a fault is the failure
  // that matters in a document we send.
  it("scales the sample down, never up, when the list was capped", () => {
    const urls = [
      ...Array.from({ length: 500 }, () => "https://x.co.uk/cdn-cgi/l/email-protection"),
      ...Array.from({ length: 500 }, (_, index) => `https://x.co.uk/gone-${index}`),
    ];
    expect(realBrokenLinks(response(urls, 4_000), 4_000)).toBe(2_000);
  });

  it("falls back to the server's total when nothing came back to inspect", () => {
    expect(realBrokenLinks(response([], 12), 12)).toBe(12);
  });
});


describe("what a client is told versus what is measured", () => {
  // Checked against a real client site: 40 images "without alt", every one of
  // them correctly decorative. A count the crawler cannot interpret must not
  // become an accusation in a document we send.
  it("never reports missing alt text as a fault", () => {
    const findings = buildFindings({
      brokenLinks: 0,
      pagesWithoutTitle: 0,
      pagesWithoutDescription: 0,
      duplicateTitles: 0,
      duplicateDescriptions: 0,
      nonIndexablePages: 0,
      pagesWithoutH1: 0,
      redirectChains: 0,
      slowPages: 0,
      imagesWithoutAlt: 40,
    });
    expect(findings).toEqual([]);
  });

  it("still reports the faults it can stand behind", () => {
    const findings = buildFindings({
      brokenLinks: 3,
      pagesWithoutTitle: 0,
      pagesWithoutDescription: 2,
      duplicateTitles: 0,
      duplicateDescriptions: 0,
      nonIndexablePages: 0,
      pagesWithoutH1: 0,
      redirectChains: 0,
      slowPages: 0,
      imagesWithoutAlt: 40,
    });
    expect(findings.map((finding) => finding.count)).toEqual([3, 2]);
  });
});
