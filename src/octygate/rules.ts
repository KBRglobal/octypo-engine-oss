import { createHash } from "node:crypto";
import { CONTENT_LANGUAGE } from "../config/domain.js";
import { normaliseText } from "../lib/topic-terms.js";
import type { LivePage, OctyGateIncident, OctyGateRule } from "./types.js";

const STOP_WORDS = new Set(["the", "and", "for", "with"]);
const MODEL_PHRASES = ["in today's fast-paced world", "the ultimate guide", "everything you need to know", "it is important to note that", "in conclusion"];
/** The money-link check reads English page text; other languages skip it. */
const READS_MONEY_TOPIC = /^english$/i.test(CONTENT_LANGUAGE.trim());

function words(value: string): string[] {
  return normaliseText(value).split(" ").filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function overlap(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}

function incident(rule: OctyGateRule, page: LivePage, message: string, evidence: Record<string, unknown>, repair: string): OctyGateIncident {
  const id = createHash("sha256").update(`${rule}|${page.url}|${message}`).digest("hex").slice(0, 16);
  return { id, rule, status: "emergency", url: page.url, message, evidence, repair };
}

export function auditPage(page: LivePage, allPages: LivePage[], sitemapUrls: Set<string>, deadExternal: Set<string>): OctyGateIncident[] {
  const out: OctyGateIncident[] = [];
  const capsuleWords = words(page.opening).length;
  const editorial = page.path.startsWith("/articles/");

  if (editorial && (!page.title || !page.h1 || overlap(page.title, page.h1) < 0.5 || overlap(page.h1, page.opening) < 0.35)) {
    out.push(incident("intent", page, "Title, H1 and opening do not express one search intent", { title: page.title, h1: page.h1, opening: page.opening, titleH1: overlap(page.title, page.h1), h1Opening: overlap(page.h1, page.opening) }, "Align Title, H1 and the first paragraph to one locked query and reader task."));
  }

  const modelPhrase = MODEL_PHRASES.find((phrase) => page.opening.toLowerCase().includes(phrase));
  if (editorial && (capsuleWords < 40 || capsuleWords > 60 || modelPhrase || /--|—/.test(page.opening))) {
    out.push(incident("capsule", page, "Opening answer capsule failed", { wordCount: capsuleWords, modelPhrase: modelPhrase ?? null, opening: page.opening }, "Rewrite the first paragraph to 40–60 direct words with no filler or model-like phrasing."));
  }

  const dead = page.externalLinks.filter((url) => deadExternal.has(url));
  if (editorial && dead.length > 0) {
    out.push(incident("truth", page, "One or more cited external sources are not live", { dead }, "Replace each dead source with a live primary source and re-check the factual claim."));
  }

  const siteOrigin = new URL(page.url).origin;
  const linkedPaths = new Set(page.internalLinks.map((url) => new URL(url).pathname));
  const depth = page.path.split("/").filter(Boolean).length;
  const hasHub = depth <= 1 || [...linkedPaths].some((path) => path !== page.path && path.split("/").filter(Boolean).length <= 1);
  const incoming = allPages.filter((candidate) => candidate.url !== page.url && candidate.internalLinks.some((url) => new URL(url).pathname === page.path));
  const unrelatedMoneyLink = page.internalLinks.find((url) => {
    const path = new URL(url).pathname;
    return READS_MONEY_TOPIC && /\/real-estate/.test(path) && !/real estate|invest|propert|apartment/i.test(page.text);
  });
  if (editorial && (!hasHub || incoming.length === 0 || unrelatedMoneyLink)) {
    out.push(incident("links", page, "Internal-link graph failed", { hasHub, incoming: incoming.map((item) => item.url), unrelatedMoneyLink: unrelatedMoneyLink ?? null }, "Link to the correct hub and cluster, add one relevant incoming link, and remove unrelated money-page CTAs."));
  }

  for (const other of editorial ? allPages.filter((candidate) => candidate.path.startsWith("/articles/")) : []) {
    if (other.url <= page.url) continue;
    const similarity = overlap(`${page.title} ${page.h1}`, `${other.title} ${other.h1}`);
    const connected = page.internalLinks.includes(other.url) || other.internalLinks.includes(page.url);
    if (similarity >= 0.8 && !connected) {
      out.push(incident("duplicates", page, "A live page appears to own the same intent without an explicit relationship", { otherUrl: other.url, similarity }, "Assign distinct query ownership and link the pages, or merge and redirect one URL."));
    }
  }

  const faqMissing = page.faqQuestions.filter((question) => !page.text.includes(question));
  const canonicalOk = page.canonical === page.url || page.canonical === `${page.url.replace(/\/$/, "")}/`;
  if (page.status !== 200 || !sitemapUrls.has(page.url) || page.noindex || !canonicalOk || faqMissing.length > 0) {
    out.push(incident("technical", page, "Live technical baseline failed", { status: page.status, inSitemap: sitemapUrls.has(page.url), noindex: page.noindex, canonical: page.canonical, expectedCanonical: page.url, faqMissing }, "Restore HTTP 200, sitemap membership, self-canonical, indexability, and remove unsupported FAQ markup."));
  }

  // Prevent unused variable removal from hiding an origin mismatch in future rules.
  void siteOrigin;
  return out;
}
