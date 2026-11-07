import type { LivePage } from "./types.js";

function decode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function text(value: string): string {
  return decode(value.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

function first(html: string, pattern: RegExp): string {
  return text(pattern.exec(html)?.[1] ?? "");
}

function attr(html: string, tagPattern: RegExp, name: string): string {
  const tag = tagPattern.exec(html)?.[0] ?? "";
  return decode(new RegExp(`${name}=["']([^"']+)["']`, "i").exec(tag)?.[1] ?? "");
}

function links(html: string, pageUrl: string): { internal: string[]; external: string[] } {
  const origin = new URL(pageUrl).origin;
  const internal = new Set<string>();
  const external = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    try {
      const target = new URL(match[1], pageUrl);
      if (!/^https?:$/.test(target.protocol)) continue;
      target.hash = "";
      (target.origin === origin ? internal : external).add(target.toString());
    } catch {
      // Invalid links are caught by the truth check when represented in markup.
    }
  }
  return { internal: [...internal], external: [...external] };
}

function faqQuestions(html: string): string[] {
  const questions = new Set<string>();
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(block[1]);
      const nodes = Array.isArray(parsed) ? parsed : parsed?.["@graph"] ?? [parsed];
      for (const node of nodes) {
        if (node?.["@type"] !== "FAQPage" || !Array.isArray(node.mainEntity)) continue;
        for (const item of node.mainEntity) if (typeof item?.name === "string") questions.add(text(item.name));
      }
    } catch {
      // Invalid JSON-LD is handled as a technical incident by the live runner.
    }
  }
  return [...questions];
}

export function parseLivePage(url: string, status: number, html: string): LivePage {
  const body = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => text(match[1])).filter(Boolean);
  const robots = attr(html, /<meta\b[^>]+name=["']robots["'][^>]*>/i, "content").toLowerCase();
  const canonical = attr(html, /<link\b[^>]+rel=["']canonical["'][^>]*>/i, "href");
  const foundLinks = links(body, url);
  return {
    url,
    path: new URL(url).pathname,
    status,
    title: first(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: first(body, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    opening: paragraphs[0] ?? "",
    text: text(body),
    canonical,
    noindex: robots.split(/[\s,]+/).includes("noindex"),
    internalLinks: foundLinks.internal,
    externalLinks: foundLinks.external,
    faqQuestions: faqQuestions(html),
  };
}
