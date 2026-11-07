import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { siteInventory } from "../lib/site-inventory.js";
import { logger } from "../lib/logger.js";
import { parseLivePage } from "./html.js";
import { auditPage } from "./rules.js";
import type { LivePage, OctyGateReport } from "./types.js";

const USER_AGENT = "OctyGate/1.0 post-publish emergency inspector";
const OUTPUT = path.resolve(process.cwd(), "data/octygate/latest.json");

async function fetchPage(url: string): Promise<LivePage> {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "user-agent": USER_AGENT, accept: "text/html" } });
    return parseLivePage(url, response.status, await response.text());
  } catch {
    return parseLivePage(url, 0, "");
  }
}

async function deadExternalLinks(pages: LivePage[]): Promise<Set<string>> {
  const urls = [...new Set(pages.flatMap((page) => page.externalLinks))];
  const dead = new Set<string>();
  await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": USER_AGENT } });
      if (!response.ok) {
        const fallback = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" } });
        if (!fallback.ok) dead.add(url);
      }
    } catch {
      dead.add(url);
    }
  }));
  return dead;
}

export async function runOctyGate(siteUrl: string): Promise<OctyGateReport> {
  const startedAt = new Date().toISOString();
  const inventory = await siteInventory(siteUrl);
  if (inventory.error || inventory.paths.length === 0) throw new Error(`OctyGate cannot inspect a site without a live sitemap: ${inventory.error}`);
  const pages = await Promise.all(inventory.paths.map((pagePath) => fetchPage(new URL(pagePath, inventory.origin).toString())));
  const sitemapUrls = new Set(pages.map((page) => page.url));
  const dead = await deadExternalLinks(pages);
  const incidents = pages.flatMap((page) => auditPage(page, pages, sitemapUrls, dead));
  const report: OctyGateReport = {
    runId: randomUUID(), siteUrl: inventory.origin, startedAt, completedAt: new Date().toISOString(),
    pagesChecked: pages.length, incidents, clean: incidents.length === 0,
  };
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify(report, null, 2));
  logger[report.clean ? "info" : "error"]({ pages: pages.length, incidents: incidents.length }, "[OctyGate] Live patrol complete");
  return report;
}

export async function latestOctyGateReport(): Promise<OctyGateReport | null> {
  try { return JSON.parse(await fs.readFile(OUTPUT, "utf8")); } catch { return null; }
}
