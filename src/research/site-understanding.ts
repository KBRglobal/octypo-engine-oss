import { EngineRegistry, generateWithEngine } from "../services/engine-registry.js";
import { siteInventory } from "../lib/site-inventory.js";
import { logger } from "../lib/logger.js";

export interface PageSignal {
  url: string;
  title: string;
  description: string;
  heading: string;
}

export interface SiteProfile {
  siteUrl: string;
  domainDescription: string;
  pages: PageSignal[];
  seeds: string[];
}

type FetchLike = typeof fetch;
type Generate = (system: string, prompt: string) => Promise<string>;

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function match(html: string, pattern: RegExp): string {
  const value = pattern.exec(html)?.[1] ?? "";
  return decodeHtml(value.replace(/<[^>]+>/g, " "));
}

export function pageSignalFromHtml(url: string, html: string): PageSignal {
  const description =
    match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i) ||
    match(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  return {
    url,
    title: match(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    description,
    heading: match(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
  };
}

export function parseSeedResponse(raw: string): string[] {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((value) => String(value).trim()).filter((value) => value.length >= 2))]
      .slice(0, 16);
  } catch {
    return [];
  }
}

async function defaultGenerate(system: string, prompt: string): Promise<string> {
  const engine = EngineRegistry.getFastEngine() ?? EngineRegistry.getNextFromQueue(new Set());
  if (!engine?.isHealthy) throw new Error("No healthy engine can understand the site");
  return generateWithEngine(engine, system, prompt);
}

export async function discoverGrowthSeeds(options: {
  siteUrl: string;
  domainDescription?: string;
  language?: string;
  fetchImpl?: FetchLike;
  generate?: Generate;
}): Promise<SiteProfile> {
  const { siteUrl, domainDescription = "", language = "en", fetchImpl = fetch, generate = defaultGenerate } = options;
  const inventory = await siteInventory(siteUrl, fetchImpl as never);
  const selectedPaths = ["/", ...inventory.paths.filter((path) => path !== "/" && path.split("/").filter(Boolean).length <= 2)]
    .slice(0, 15);
  const origin = inventory.origin || new URL(siteUrl).origin;
  const pages = (
    await Promise.all(
      selectedPaths.map(async (path) => {
        const url = new URL(path, origin).toString();
        try {
          const response = await fetchImpl(url, {
            headers: { "user-agent": "OctypoSiteUnderstanding/1.0", accept: "text/html" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) return null;
          return pageSignalFromHtml(url, await response.text());
        } catch {
          return null;
        }
      })
    )
  ).filter((page): page is PageSignal => Boolean(page && (page.title || page.description || page.heading)));

  const evidence = pages.map((page) => `URL: ${page.url}\nTITLE: ${page.title}\nH1: ${page.heading}\nDESCRIPTION: ${page.description}`).join("\n\n");
  const system = `You identify what a website actually offers before keyword research. Return only a JSON array of 8-16 broad search seeds in the site's language (${language}). Use commercial offers, audience needs, and major editorial topics. Do not invent services that the supplied pages do not support. Do not return article titles or near-duplicate phrases.`;
  const prompt = `Declared domain: ${domainDescription || "not supplied"}\n\nObserved website pages:\n${evidence || "No page metadata was available."}`;
  let seeds: string[] = [];
  try {
    seeds = parseSeedResponse(await generate(system, prompt));
  } catch (error) {
    logger.warn({ error }, "[Growth] Site understanding failed");
  }

  return { siteUrl, domainDescription, pages, seeds };
}
