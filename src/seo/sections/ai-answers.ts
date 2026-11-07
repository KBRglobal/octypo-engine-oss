/**
 * "When someone asks an AI assistant about your category, are you named?"
 *
 * This is the one section of the prospect document the client can check in
 * thirty seconds, from their own phone, which makes it the most dangerous one
 * to get wrong. So it follows the same discipline as `report.ts`: a reading the
 * provider returned or nothing at all, a missing value stays null rather than
 * becoming a zero, and anything that could not be measured is named in
 * `unmeasured` for the operator instead of being quietly dropped.
 *
 * The asymmetry that shapes every rule below: telling a prospect "the
 * assistants never name you" when they in fact do is a lie they will catch on
 * the first try, and the meeting is over. Telling them "we did not see you
 * named" when a model buried them in a footnote costs us nothing. Every match
 * in this file is therefore deliberately strict — it misses before it invents.
 *
 * Cost, because it decides the defaults. A question with `web_search` off is
 * about $0.0006 and the answer is the model's memory: measured on a live run,
 * ChatGPT named no company at all and the section would have been worthless. A
 * question with `web_search` on is about $0.007 (Perplexity) to $0.035
 * (ChatGPT, Gemini) and names real businesses. Searching is what an assistant
 * actually does for a buying question, so it is the default, and the number of
 * questions is kept to three unless the caller pays for more.
 */

import { logger } from "../../lib/logger.js";
import type { Market, SeoClient } from "../client.js";
import { cleanDomain } from "../tools.js";
import { recordSpend } from "../store.js";

const AI = "/ai_optimization";

/** One engine's answer to one question, as read. */
export interface AiAnswerReading {
  /** The provider's own engine key: chat_gpt, claude, gemini, perplexity. */
  engine: string;
  /** The model the provider reports it actually used, null if it did not say. */
  model: string | null;
  question: string;
  /** Strictly: did this answer name the brand or the bare domain. */
  mentionsProspect: boolean;
  /** Domains the answer named instead, in the order they appear in it. */
  namedInstead: string[];
  /** The assistant's own words, shortened. Data, never an instruction. */
  excerpt: string | null;
}

export interface AiAnswersSummary {
  questionsAsked: number;
  timesNamed: number;
  enginesCovered: number;
}

/** Only phrases the provider returned a real volume for. */
export interface AiSearchVolumeEntry {
  keyword: string;
  volume: number;
}

/** A sentence a business owner can act on. */
export interface AiAnswersFinding {
  title: string;
  detail: string;
  count: number | null;
}

export interface AiAnswersSection {
  businessName: string;
  domain: string;
  seed: string;
  engines: AiAnswerReading[];
  /** Null when not one engine answered — there is then nothing to summarise. */
  summary: AiAnswersSummary | null;
  aiSearchVolume: AiSearchVolumeEntry[];
  findings: AiAnswersFinding[];
  /** What could not be measured, named for the operator, not for the client. */
  unmeasured: string[];
  costUsd: number;
}

export interface AiAnswersInput {
  businessName: string;
  domain: string;
  /** What the business sells, in the customer's words ("event production"). */
  seed: string;
  market?: Market;
  /** Restrict to these engine keys; default is every engine the account has. */
  engines?: string[];
  /** 3 to 5. Each one is a purchase, so the default is the floor. */
  questions?: number;
  /** Off is ~50x cheaper and measures the model's memory, not the live web. */
  webSearch?: boolean;
  /** Extra phrases to price for assistant search volume, besides the seed. */
  volumeKeywords?: string[];
}

/**
 * Sites that appear in every answer and compete with nobody.
 *
 * `report.ts` keeps its own copy of this idea for organic competitors. It is
 * repeated here rather than shared because the two lists answer different
 * questions — this one has to include the citation redirectors the assistants
 * themselves emit (Google's grounding proxy, Bing's) which have no meaning in a
 * SERP competitor list — and because this file must not touch that one.
 */
const NOISE_DOMAINS = new Set([
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
  "google.com",
  "googleapis.com",
  "vertexaisearch.cloud.google.com",
  "bing.com",
  "openai.com",
  "apple.com",
  "microsoft.com",
  "yelp.com",
  "tripadvisor.com",
  "medium.com",
  "quora.com",
  "wordpress.com",
  "blogspot.com",
  "wix.com",
]);

function isNoise(host: string): boolean {
  if (NOISE_DOMAINS.has(host)) return true;
  // Country editions of the same platforms: facebook.fr, amazon.de, …
  const stem = host.split(".")[0];
  return [...NOISE_DOMAINS].some((noise) => noise.split(".")[0] === stem);
}

/** Last labels that look like a domain and are a file name. */
const FILE_SUFFIXES = new Set([
  "html",
  "htm",
  "php",
  "aspx",
  "js",
  "ts",
  "json",
  "xml",
  "css",
  "md",
  "txt",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "svg",
]);

/**
 * Buying questions around the seed.
 *
 * A question has to be one a customer would really type, because that is the
 * claim being made about it in the document. The frame is English and the seed
 * stays in whatever language the operator gave it; the assistants read both.
 */
export function buyingQuestions(seed: string): string[] {
  const phrase = seed.trim();
  if (!phrase) return [];

  return [
    `What are the best ${phrase} options available today?`,
    `Which ${phrase} do you recommend? Please name specific ones.`,
    `I am choosing a ${phrase}, which are the leading names?`,
    `Top ${phrase} recommendations, with names.`,
    `Who are the best-known providers of ${phrase}?`,
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Did this answer actually name the prospect?
 *
 * Two independent tests, and a match on either is enough:
 *
 * 1. The bare host, with its suffix, as a plain substring: `acme-events.com`.
 *    Requiring the suffix is what makes it safe — `acme-events` on its own would
 *    match "acme-eventstore", and a link written `https://www.acme-events.com/x`
 *    still contains the bare host, so nothing is lost by being strict.
 *
 * 2. The brand name, on a real word boundary. `\b` cannot be used: letters
 *    outside ASCII are not `\w`, so `\b` matches in places it should not and
 *    fails in places it should. The boundary is therefore written against
 *    `\p{L}\p{N}`, which behaves the same in every script. A letter attached
 *    to the brand is deliberately *not* allowed, even in a language that glues
 *    prepositions onto words: missing that form is the cheap error, and
 *    claiming a match is not.
 *
 * Two guards keep test 2 from producing the expensive error:
 *
 * - A brand that is a word of the category it sells in ("Events" for an events
 *   company) is skipped entirely, because every answer would contain it. The
 *   domain test still applies, and it is the trustworthy one.
 * - A Latin-script brand must appear capitalised in the original text. "Notion"
 *   the product is written Notion; "notion" the English noun is not. Scripts
 *   with no case do not need the rule, and the boundary carries it there.
 */
export function namesTarget(
  text: string,
  target: { brand?: string; domain?: string; seed?: string }
): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  const host = cleanDomain(target.domain ?? "");
  if (host && host.includes(".") && lower.includes(host)) return true;

  const brand = (target.brand ?? "").trim();
  if (brand.length < 3) return false;

  // A brand made of category words would match every single answer.
  const seedWords = new Set(
    (target.seed ?? "")
      .toLowerCase()
      .split(/[\s,.\-–—/|()"'?!]+/)
      .filter(Boolean)
  );
  const brandWords = brand.toLowerCase().split(/\s+/).filter(Boolean);
  if (brandWords.length > 0 && brandWords.every((word) => seedWords.has(word))) return false;

  // No `i` flag, on purpose. For a Latin brand that makes the test
  // case-sensitive: "Notion" the product is written Notion, "notion" the
  // English noun is not. A script with no case loses nothing by it.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(brand)}(?![\\p{L}\\p{N}])`, "u");
  return pattern.test(text);
}

/**
 * The domains an answer named, in the order it named them.
 *
 * Only domains, never names pulled out of prose. A company name is not
 * delimited in text — picking "Harbor Productions" out of a sentence means guessing
 * where it ends, and a half-right competitor name in a document sent to a
 * prospect is exactly the mistake that ends a sale. A domain has a shape, so it
 * can be read rather than guessed, and the owner recognises it just as well.
 *
 * Directories (Yellow Pages, review aggregators) are left in on purpose: the
 * claim made in the document is "this is what the assistant pointed at", and
 * that is true of a directory too. Only the global platforms are dropped,
 * because they appear in every answer and mean nothing.
 */
export function domainsNamed(
  text: string,
  annotations: { url?: unknown; direct_url?: unknown; title?: unknown }[],
  ownDomain: string
): string[] {
  const own = cleanDomain(ownDomain);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (candidate: string | null) => {
    if (!candidate) return;
    const host = cleanDomain(candidate);
    if (!host || !host.includes(".")) return;
    if (FILE_SUFFIXES.has(host.split(".").pop() ?? "")) return;
    if (host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`)) return;
    if (isNoise(host)) return;
    if (seen.has(host)) return;
    seen.add(host);
    ordered.push(host);
  };

  // Bare hosts written in the answer itself. The lookarounds keep the match off
  // e-mail addresses and off the middle of a longer host.
  const bare = /(?<![a-z0-9@._-])((?:[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?\.)+[a-z]{2,10})(?![a-z0-9-])/gi;
  for (const match of text.matchAll(bare)) add(match[1]);

  // Then the citations. Google returns a redirect URL and keeps the real host
  // in `direct_url`; reading `url` alone would credit every Gemini answer to
  // vertexaisearch.cloud.google.com.
  for (const annotation of annotations) {
    const direct = typeof annotation.direct_url === "string" ? annotation.direct_url : null;
    const url = typeof annotation.url === "string" ? annotation.url : null;
    const title = typeof annotation.title === "string" ? annotation.title : null;
    add(direct ?? url);
    // Gemini writes the bare host as the citation title; a human title has
    // spaces and will simply fail the host shape above.
    if (title && !/\s/.test(title)) add(title);
  }

  return ordered;
}

/** The message text an engine returned, with reasoning traces left out. */
export function answerText(items: unknown[]): string {
  const parts: string[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "message") continue;
    for (const section of Array.isArray(item.sections) ? item.sections : []) {
      if (!section || typeof section !== "object") continue;
      const part = section as Record<string, unknown>;
      if (typeof part.text === "string" && part.text.trim()) parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** The citation objects hanging off the message sections. */
export function answerAnnotations(items: unknown[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== "message") continue;
    for (const section of Array.isArray(item.sections) ? item.sections : []) {
      if (!section || typeof section !== "object") continue;
      const list = (section as Record<string, unknown>).annotations;
      for (const entry of Array.isArray(list) ? list : []) {
        if (entry && typeof entry === "object") found.push(entry as Record<string, unknown>);
      }
    }
  }
  return found;
}

const EXCERPT_LIMIT = 300;

/**
 * A quotable piece of the answer.
 *
 * The words are the assistant's, unchanged; what is removed is markup the
 * renderer would show raw — `**bold**` fences and `[3]` citation markers — and
 * line breaks, which are collapsed so the quote fits one card. When the
 * prospect *is* named, the window is centred on that mention: the client wants
 * to see the sentence they appear in, not the model's preamble.
 */
export function excerptFrom(text: string, target: { brand?: string; domain?: string }): string | null {
  const flat = text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  if (flat.length <= EXCERPT_LIMIT) return flat;

  const lower = flat.toLowerCase();
  const host = cleanDomain(target.domain ?? "");
  const brand = (target.brand ?? "").trim().toLowerCase();
  let at = host ? lower.indexOf(host) : -1;
  if (at < 0 && brand.length >= 3) at = lower.indexOf(brand);

  let start = at < 0 ? 0 : Math.max(0, at - Math.floor(EXCERPT_LIMIT / 3));
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    start = space < 0 ? start : space + 1;
  }

  let slice = flat.slice(start, start + EXCERPT_LIMIT);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > EXCERPT_LIMIT * 0.6) slice = slice.slice(0, lastSpace);
  return `${start > 0 ? "…" : ""}${slice.trim()}…`;
}

/**
 * The engine keys this account can actually send a prompt to.
 *
 * Read from the provider's own index rather than hard-coded, because the family
 * gains engines and an account's access is not ours to assume.
 */
export function enginesFromIndex(paths: unknown): string[] {
  const list = Array.isArray(paths) ? paths : [];
  const engines: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const match = entry.match(/^v3\/ai_optimization\/([a-z0-9_]+)\/llm_responses\/live$/);
    if (match && !engines.includes(match[1])) engines.push(match[1]);
  }
  return engines;
}

/**
 * Which model to ask with.
 *
 * The models list carries no prices, so the choice is made on the vendors' own
 * size words — a "mini"/"lite"/"nano"/"haiku"/"sonar" build answers a "name
 * some companies" question as well as its big sibling and costs a fraction of
 * it. Ties keep the provider's order, which is newest first. When web search is
 * wanted, a model that cannot search is not a candidate at all: it would answer
 * from memory and we would report its memory as the live web.
 */
export function chooseModel(models: Record<string, unknown>[], webSearch: boolean): string | null {
  const SMALL = ["sonar", "nano", "lite", "mini", "haiku", "flash"];
  // The vendors' words for "the expensive one". Measured: Perplexity's list is
  // ordered `sonar-reasoning-pro`, `sonar-pro`, `sonar` — all three contain
  // "sonar", so without this penalty the first and dearest wins the tie and a
  // three-question run costs $0.064 instead of about $0.02.
  const LARGE = ["reasoning", "pro", "opus", "ultra", "max", "thinking"];
  let bestName: string | null = null;
  let bestScore = -1;

  for (const model of models) {
    const name = typeof model.model_name === "string" ? model.model_name : null;
    if (!name) continue;
    // A dated snapshot ("…-2026-03-17") is the same model pinned; prefer the
    // rolling alias so this does not quietly age out.
    if (/-\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (webSearch && model.web_search_supported === false) continue;

    const lower = name.toLowerCase();
    const hit = SMALL.findIndex((word) => lower.includes(word));
    const penalty = LARGE.filter((word) => lower.includes(word)).length;
    const score = (hit < 0 ? 0 : SMALL.length - hit) - penalty * SMALL.length;
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

/** The sentences the client reads. Built only from what was measured. */
export function findingsFrom(
  readings: AiAnswerReading[],
  summary: AiAnswersSummary | null,
  volumes: AiSearchVolumeEntry[],
  businessName: string
): AiAnswersFinding[] {
  const findings: AiAnswersFinding[] = [];
  if (!summary || summary.questionsAsked === 0) return findings;

  // One is spelled out; anything else keeps the digit.
  const assistants =
    summary.enginesCovered === 1 ? "one AI assistant" : `${summary.enginesCovered} AI assistants`;

  if (summary.timesNamed === 0) {
    findings.push({
      title: "Your business did not appear in any answer",
      detail: `We asked ${assistants} ${summary.questionsAsked} real buying questions. Neither the name ${businessName} nor the site address appeared in any of the answers.`,
      count: summary.questionsAsked,
    });
  } else if (summary.timesNamed === summary.questionsAsked) {
    findings.push({
      title: "Your business appeared in every answer",
      detail: `We asked ${assistants} ${summary.questionsAsked} real buying questions, and the name or address of ${businessName} appeared in all of them.`,
      count: summary.timesNamed,
    });
  } else {
    findings.push({
      title: "Your business appeared in some of the answers",
      detail: `Of ${summary.questionsAsked} buying questions put to ${assistants}, the name or address of ${businessName} appeared in only ${summary.timesNamed} answers.`,
      count: summary.timesNamed,
    });
  }

  // Who the assistants sent the customer to instead, by how often they said it.
  const tally = new Map<string, number>();
  for (const reading of readings) {
    for (const rival of reading.namedInstead) tally.set(rival, (tally.get(rival) ?? 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0) {
    findings.push({
      title: "These are the sites the assistants did send people to",
      detail: `${ranked.length} other sites appeared in the answers. The most common: ${ranked
        .slice(0, 5)
        .map(([host]) => host)
        .join(", ")}`,
      count: ranked.length,
    });
  }

  if (volumes.length > 0) {
    const total = volumes.reduce((sum, entry) => sum + entry.volume, 0);
    findings.push({
      title: "How many people ask the assistants about your field",
      detail: `The assistants receive ${total} questions a month on the phrases in your field.`,
      count: total,
    });
  }

  return findings;
}

/**
 * Ask every engine, read every answer, and never throw.
 *
 * A prospect report is built from a dozen independent calls and this is one of
 * them: an engine that is down, a model the account lost access to or a quota
 * that ran out has to cost this section and nothing else. Every failure lands
 * in `unmeasured` with its own name, so the operator can see that Gemini was
 * missing from a document before the client asks why.
 */
export async function buildAiAnswersSection(
  client: SeoClient,
  input: AiAnswersInput
): Promise<AiAnswersSection> {
  const domain = cleanDomain(input.domain ?? "");
  const businessName = (input.businessName ?? "").trim() || domain;
  const seed = (input.seed ?? "").trim();
  const market = input.market ?? {};
  const webSearch = input.webSearch ?? true;
  const unmeasured: string[] = [];
  let costUsd = 0;

  const section = (
    engines: AiAnswerReading[],
    summary: AiAnswersSummary | null,
    aiSearchVolume: AiSearchVolumeEntry[]
  ): AiAnswersSection => ({
    businessName,
    domain,
    seed,
    engines,
    summary,
    aiSearchVolume,
    findings: findingsFrom(engines, summary, aiSearchVolume, businessName),
    unmeasured: [...new Set(unmeasured)],
    costUsd: Number(costUsd.toFixed(6)),
  });

  async function attempt<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      logger.warn({ error, domain, section: name }, "[SEO] AI answers step unavailable");
      unmeasured.push(name);
      return null;
    }
  }

  if (!seed) {
    // The category is the only thing here a person has to supply. Guessing it
    // from the site produced an unrelated category for an events company once
    // already; the section is omitted instead.
    unmeasured.push("seed");
    return section([], null, []);
  }

  const questions = buyingQuestions(seed).slice(
    0,
    Math.max(3, Math.min(input.questions ?? 3, 5))
  );

  // Which engines exist is a free read, and it is read rather than assumed:
  // guessing wrong here spends money on a 404 path.
  const index = await attempt("engines", () => client.get(`${AI}/endpoints`));
  const discovered = enginesFromIndex(index?.results?.[0]);
  const wanted = input.engines?.length
    ? discovered.filter((engine) => input.engines!.includes(engine))
    : discovered;

  if (wanted.length === 0) {
    unmeasured.push("engines:none-available");
    return section([], null, []);
  }

  // Free per engine, and the only honest way to name a model in the document.
  const chosen: { engine: string; model: string }[] = [];
  const modelLists = await Promise.all(
    wanted.map((engine) => attempt(`models:${engine}`, () => client.get(`${AI}/${engine}/llm_responses/models`)))
  );
  wanted.forEach((engine, position) => {
    const models = modelLists[position]?.results ?? [];
    const model = chooseModel(models, webSearch);
    if (!model) {
      unmeasured.push(`models:${engine}`);
      return;
    }
    chosen.push({ engine, model });
  });

  if (chosen.length === 0) return section([], null, []);

  // Every engine × every question, in parallel. They are independent purchases
  // and one slow model must not hold up the rest of the document.
  const calls = chosen.flatMap(({ engine, model }) =>
    questions.map((question) => ({ engine, model, question }))
  );

  const responses = await Promise.all(
    calls.map((call) =>
      attempt(`ask:${call.engine}`, () =>
        client.post(
          `${AI}/${call.engine}/llm_responses/live`,
          { user_prompt: call.question, model_name: call.model, web_search: webSearch },
          market
        )
      )
    )
  );

  const readings: AiAnswerReading[] = [];
  responses.forEach((response, position) => {
    costUsd += response?.costUsd ?? 0;
    if (!response) return;

    const call = calls[position];
    const text = answerText(response.rows);
    if (!text.trim()) {
      // An empty answer is not a "you were not mentioned" reading. It is a
      // missing measurement, and counting it as a miss would overstate the
      // problem to the client.
      unmeasured.push(`empty:${call.engine}`);
      return;
    }

    const head = response.head ?? {};
    readings.push({
      engine: call.engine,
      model: typeof head.model_name === "string" ? head.model_name : call.model,
      question: call.question,
      mentionsProspect: namesTarget(text, { brand: businessName, domain, seed }),
      namedInstead: domainsNamed(text, answerAnnotations(response.rows), domain),
      excerpt: excerptFrom(text, { brand: businessName, domain }),
    });
  });

  // How often the category itself is asked about inside assistants. Separate
  // purchase, separate failure: the questions above stand without it.
  const volumeKeywords = [...new Set([seed, ...(input.volumeKeywords ?? [])])]
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);

  const volumeResponse = await attempt("aiSearchVolume", () =>
    client.post(`${AI}/ai_keyword_data/keywords_search_volume/live`, { keywords: volumeKeywords }, market)
  );
  costUsd += volumeResponse?.costUsd ?? 0;

  const aiSearchVolume: AiSearchVolumeEntry[] = (volumeResponse?.rows ?? [])
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        keyword: typeof row.keyword === "string" ? row.keyword : "",
        // A null volume means "not sold for this phrase", not "nobody asks".
        volume: typeof row.ai_search_volume === "number" ? row.ai_search_volume : 0,
      };
    })
    .filter((entry) => entry.keyword && entry.volume > 0)
    .sort((a, b) => b.volume - a.volume);

  if (volumeResponse && aiSearchVolume.length === 0) unmeasured.push("aiSearchVolume:empty");

  const summary: AiAnswersSummary | null =
    readings.length > 0
      ? {
          questionsAsked: readings.length,
          timesNamed: readings.filter((reading) => reading.mentionsProspect).length,
          enginesCovered: new Set(readings.map((reading) => reading.engine)).size,
        }
      : null;
  if (!summary) unmeasured.push("engines:no-answer");

  recordSpend("ai-answers", costUsd);
  return section(readings, summary, aiSearchVolume);
}
