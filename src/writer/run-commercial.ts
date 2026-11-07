/**
 * From a banked idea to a stored draft, in one model call.
 *
 * Flow: gather the cluster's confirmed facts → one call to the writing model →
 * parse the fixed layout → audit the numbers → store as a draft for the review
 * console. No LLM review, no revision loop: the blind judging round showed the
 * risk is invented facts, and that is caught deterministically. Editorial taste
 * stays with the human in the console, where it always ended up anyway.
 */

import { asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "../db.js";
import { clusterFacts, contents, articles, type ContentBlock } from "../schema/index.js";
import { logger } from "../lib/logger.js";
import { SITE_URL, SITE_NAME, sisterLinks } from "../config/domain.js";
import { brandFromFact } from "./brand-from-fact.js";
import { sanitizeHtml } from "../lib/sanitize-html.js";
import { findOrCreateArticleImage, findArticleBodyImages } from "../lib/image-provider.js";
import { jobQueue, type JobType } from "../job-queue.js";
import { deriveQuickFacts, ensureInternalLinks, insertBodyImages, type LinkCandidate } from "./article-finish.js";
import { topics } from "../config/topics.js";
import { DEFAULT_LOCALE, resolveLocale, type ClusterLocale } from "../config/locale.js";
import { packFor, enPack, type LanguagePack } from "../i18n/language-pack.js";
import { createLanguageWriter } from "../services/engine-registry.js";
import { serpBriefFor } from "../research/serp-brief.js";
import { englishSlug, slugStyle } from "./english-slug.js";
import { todayContextBlock } from "../lib/today.js";
import { scoreArticle } from "../quality/score-article.js";
import {
  generateMinHash,
  calculateJaccardSimilarity,
} from "../octypo/gatekeeper/deduplication/fingerprint.js";
import {
  auditLinks,
  auditNumbers,
  auditSuperlatives,
  buildInputBlock,
  numbersIn,
  commercialSystemPrompt,
  parseCommercialArticle,
  type CommercialArticle,
  type CommercialInput,
} from "./commercial.js";

/** The confirmed facts a cluster writes from: its own rows plus the site-wide '*' rows. */
export async function confirmedFactsFor(cluster: string | null): Promise<string[]> {
  const scopes = cluster && cluster !== "*" ? [cluster, "*"] : ["*"];
  const rows = await db
    .select({ fact: clusterFacts.fact })
    .from(clusterFacts)
    .where(inArray(clusterFacts.cluster, scopes))
    .orderBy(asc(clusterFacts.createdAt));
  return rows.map((row) => row.fact.trim()).filter(Boolean);
}

/**
 * Markdown body → the block structure the site renders.
 *
 * Deterministic on purpose — this is the "analog tool" half of the design:
 * arranging an article into a template is not an AI problem.
 */
/**
 * Convert the inline markdown the writer produces into HTML, then sanitise.
 *
 * Without this, published prose showed literal ** and [anchor](url) and pipe
 * tables — and every internal link the whole live_urls machinery exists to
 * create rendered as dead text. Escaping happens first so author text can
 * never inject tags; only our own generated tags survive, and sanitizeHtml is
 * the final allowlist gate.
 */
export function inlineMarkdownToHtml(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // [anchor](href) — href restricted to internal paths and http(s), so the
  // link audit's allowlist is the only thing that can appear here.
  html = html.replace(/\[([^\]]+)\]\((\/[^)\s]*|https?:\/\/[^)\s]+)\)/g,
    (_m, label, href) => `<a href="${href}">${label}</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return html;
}

/** A pipe-table block → an HTML table. Header row, separator, body rows. */
function pipeTableToHtml(lines: string[]): string | null {
  if (lines.length < 2 || !/^\s*\|?\s*-{2,}/.test(lines[1].replace(/[^|\-\s:]/g, ""))) {
    // Second line must be the --- separator to be a table.
    if (!/^[\s|:-]+$/.test(lines[1])) return null;
  }
  const cells = (line: string) =>
    line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inlineMarkdownToHtml(c.trim()));
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  const thead = `<thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}

export function markdownToBlocks(markdown: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let counter = 0;

  for (const chunk of markdown.split(/\n{2,}/)) {
    const part = chunk.trim();
    if (!part) continue;

    // A heading and its following line often arrive in ONE chunk (single
    // newline between them). Matching just the first line and discarding the
    // rest silently ate the paragraph after every heading.
    const heading = /^(#{1,4})\s+(.+)/.exec(part);
    if (heading) {
      blocks.push({
        type: "heading",
        id: `h-${counter++}`,
        data: { text: heading[2].split("\n")[0].trim(), level: Math.max(2, Math.min(heading[1].length, 4)) },
      });
      const remainder = part.slice(part.indexOf("\n") + 1).trim();
      if (part.includes("\n") && remainder) {
        blocks.push({
          type: "text",
          id: `t-${counter++}`,
          data: { content: sanitizeHtml(inlineMarkdownToHtml(remainder)) },
        });
      }
      continue;
    }

    const lines = part.split("\n");
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
      blocks.push({
        type: "list",
        id: `l-${counter++}`,
        data: { items: lines.map((line) => sanitizeHtml(inlineMarkdownToHtml(line.replace(/^\s*[-*]\s+/, "").trim()))) },
      });
      continue;
    }

    // Numbered steps. "1. Do this" is how the writer expresses a procedure, and
    // a procedure rendered as a flat paragraph loses both the reader and the
    // HowTo schema built from it at publish.
    if (lines.length >= 2 && lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
      blocks.push({
        type: "list",
        id: `l-${counter++}`,
        data: {
          ordered: true,
          items: lines.map((line) => sanitizeHtml(inlineMarkdownToHtml(line.replace(/^\s*\d+[.)]\s+/, "").trim()))),
        },
      });
      continue;
    }

    // A paragraph that is exactly one bold line is a section label the writer
    // wrote as **Heading**. Shipping it as <strong> text is why judges saw a
    // 792-word wall with zero heading architecture — promote it to a heading.
    const soloBold = /^\*\*([^*\n]+)\*\*$/.exec(part);
    if (soloBold) {
      blocks.push({
        type: "heading",
        id: `h-${counter++}`,
        data: { text: soloBold[1].trim(), level: 2 },
      });
      continue;
    }

    // A pipe table, if the second line is a separator.
    if (lines.length >= 2 && lines[0].includes("|")) {
      const table = pipeTableToHtml(lines);
      if (table) {
        blocks.push({ type: "text", id: `t-${counter++}`, data: { content: sanitizeHtml(table) } });
        continue;
      }
    }

    blocks.push({
      type: "text",
      id: `t-${counter++}`,
      data: { content: sanitizeHtml(inlineMarkdownToHtml(part)) },
    });
  }

  return blocks;
}

/**
 * Lift the FAQ section out of the body into a structured faq block.
 *
 * Readers and answer systems use the visible FAQ, and the site renders it as
 * an accordion. The writer produces
 * the section (requested through the input); this pass recognises it
 * mechanically: a FAQ heading, then question headings/bold lines each followed
 * by their answer text. Returns the remaining body blocks and the pairs.
 */
export function liftFaq(
  blocks: ContentBlock[],
  faqPattern: RegExp = enPack.faqHeadingPattern
): {
  blocks: ContentBlock[];
  faq: { question: string; answer: string }[];
} {
  const isFaqHeading = (block: ContentBlock) =>
    block.type === "heading" &&
    faqPattern.test(String((block.data as { text?: string }).text ?? ""));

  const start = blocks.findIndex(isFaqHeading);
  if (start === -1) return { blocks, faq: [] };

  const faqLevel = ((blocks[start].data as { level?: number }).level ?? 3);
  const faq: { question: string; answer: string }[] = [];
  let question: string | null = null;

  for (let i = start + 1; i < blocks.length; i++) {
    const block = blocks[i];
    const data = block.data as { text?: string; content?: string; level?: number };
    // A heading at the FAQ's own level (or shallower) that is not itself a
    // question ends the FAQ section.
    if (
      block.type === "heading" &&
      (data.level ?? 3) <= faqLevel &&
      !/[?\uFF1F\u061F]/.test(data.text ?? "")
    ) {
      // A new top-level section — FAQ is over. Keep the rest of the body.
      const rest = blocks.slice(i);
      return { blocks: [...blocks.slice(0, start), ...rest], faq };
    }
    if (block.type === "heading") {
      question = String(data.text ?? "").trim();
      continue;
    }
    // Split on <br> and newlines; a bold question may sit alone or share a
    // block with its answer, and by now bold is <strong>…</strong>.
    const raw = String(data.content ?? "").split(/<br\s*\/?>|\n/);
    for (const rawLine of raw) {
      const line = rawLine.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!line) continue;
      const strong = /^<strong>(.+?)<\/strong>\s*$/.exec(rawLine.trim());
      const bold = /^\*\*(.+?)\*\*$/.exec(line);
      if (strong || bold) {
        question = (strong ? strong[1] : bold![1]).replace(/<[^>]+>/g, "").trim();
        continue;
      }
      if (question && line) {
        faq.push({ question, answer: line });
        question = null;
      }
    }
  }

  return { blocks: blocks.slice(0, start), faq };
}

export interface CommercialRunResult {
  contentId: string;
  audit: { ok: boolean; unsupported: string[] };
  seconds: number;
}

export class CommercialWriteError extends Error {}

// ============================================================================
// Prompt builders — the exact strings the writer sends, as pure functions.
//
// Extracted so the golden test (prompt-golden.test.ts) can freeze the default
// path byte-for-byte (LANG-01). Every locale, the default included, gets the
// ENVELOPE around the prompt file (LANG-02/LANG-05): the file is the
// language-neutral writing contract; the envelope names the target language.
// ============================================================================

/**
 * The English meta-instruction wrapped around the prompt file for every
 * locale. NATIVE creation, never translation — and the country's local
 * conventions (currency, dates, units, digit grouping) come from here, not
 * from post-processing. Interpolates only the internally derived languageName
 * and a validated ISO country code — never operator-stored strings
 * (T-quick-01).
 */
export function languageEnvelope(locale: ClusterLocale): string {
  return (
    `You are a top local commercial copywriter creating this content NATIVELY in ${locale.languageName} ` +
    `for buyers in ${locale.country}. Write it from scratch the way the best local marketer would — ` +
    `never translate, and never carry over foreign phrasing, idiom or word order from any other language. ` +
    `Use the local conventions of ${locale.country} throughout: currency and its symbols, date formats, ` +
    `units of measurement, and digit grouping. ` +
    `The writing contract below governs everything; follow it exactly. It is in English, but everything ` +
    `a reader sees is written in ${locale.languageName}. Keep the input contract and the output field labels ` +
    `exactly as specified.`
  );
}

/**
 * The system prompt for a locale: the envelope, a blank line, then the prompt
 * file. One code path for every language.
 */
export function buildSystemPrompt(locale: ClusterLocale = DEFAULT_LOCALE): string {
  return languageEnvelope(locale) + "\n\n" + commercialSystemPrompt();
}

/** The judges' verdicts, folded into standing input rules — the quality rider. */
export function buildQualityRules(relatedTerms?: string, pack: LanguagePack = enPack): string {
  return pack.qualityRules(relatedTerms);
}

/** Length hint — only when a target exists; depth, not repetition. */
export function buildLengthHint(targetWords: number, pack: LanguagePack = enPack): string {
  return targetWords > 0 ? pack.lengthHint(Math.round(targetWords * 0.8), targetWords) : "";
}

/** Table nudge — only when the facts actually carry numbers. */
export function buildTableHint(numericFacts: number, pack: LanguagePack = enPack): string {
  return numericFacts >= 6 ? pack.tableHint : "";
}

/** The FAQ section request; only explicit research/operator intent opts in. */
export function buildFaqRequest(pack: LanguagePack = enPack): string {
  return (process.env.WANT_FAQ ?? "false").toLowerCase() === "true" ? pack.faqRequest : "";
}

/** The grammar-only editor-pass prompt around the serialized article. */
export function buildEditorPrompt(serialized: string, pack: LanguagePack = enPack): string {
  return pack.editorPassPrompt(serialized);
}

/** The competitive-snapshot rider around a stored SERP brief. */
export function buildSerpRider(brief: string, pack: LanguagePack = enPack): string {
  return pack.serpRider(brief);
}

/** Targeted superlative-rewrite note, naming the exact offending phrases. */
export function buildSuperlativeRetryNote(found: string[], pack: LanguagePack = enPack): string {
  return pack.superlativeRetryNote(found);
}

/** Full-retry note naming the structural defects found in the previous draft. */
export function buildStructuralRetryNote(repeatedSpans: string[], superlatives: string[], pack: LanguagePack = enPack): string {
  return pack.structuralRetryNote(repeatedSpans, superlatives);
}

/** Rewrite prompt for one FAQ answer that overlaps the body. */
export function buildFaqRewritePrompt(question: string, answer: string, pack: LanguagePack = enPack): string {
  return pack.faqRewritePrompt(question, answer);
}

/**
 * Write one article for a banked idea.
 *
 * Throws when the input is not there to write from — an idea with no confirmed
 * facts is not writable under the contract, and pretending otherwise is how
 * invented prices reach a customer's site.
 */
export async function writeCommercialArticle(idea: {
  title: string;
  targetKeyword: string;
  cluster: string | null;
  isPillar?: boolean | null;
  targetWords?: number | null;
}): Promise<CommercialRunResult> {
  const facts = await confirmedFactsFor(idea.cluster);
  if (facts.length === 0) {
    throw new CommercialWriteError(
      `No confirmed facts for cluster "${idea.cluster ?? "*"}" — add facts before writing`
    );
  }

  // The cluster's language/country. Resolved ONCE here; everything below
  // dispatches through the pack.
  const locale = await resolveLocale(idea.cluster);
  const pack = packFor(locale.language);

  // Gates with no curated vocabulary for this language do not run — and that
  // is recorded explicitly (LANG-03, T-quick-02): the operator sees skipped
  // markers in the persisted audit payload, never a silent pass. The
  // language-neutral gates (numbers, links, repetition, similarity, density
  // counting) block unconditionally for every language.
  const skippedGates: string[] = [];
  if (!pack.superlatives) skippedGates.push(`no-superlative-list:${pack.code}`);
  if (!pack.vagueNumberWords) skippedGates.push(`no-vague-quantity-words:${pack.code}`);
  if (!pack.processLeaks) skippedGates.push(`no-process-leak-list:${pack.code}`);
  if (!pack.faqDeictics) skippedGates.push(`no-faq-deictic-list:${pack.code}`);
  if (!pack.demotionNoun) skippedGates.push(`no-brand-demotion:${pack.code}`);
  if (!pack.priceMarkerPattern || !pack.vatQualifierWords) skippedGates.push(`no-vat-wordlist:${pack.code}`);
  if (!pack.promiseVerbs || !pack.ymylTopicTerms) skippedGates.push(`no-promise-verb-list:${pack.code}`);
  if (!pack.ctaContactMarkers) skippedGates.push(`no-cta-marker-list:${pack.code}`);

  // Sibling phrases from the cluster's topic — the judges flagged missing
  // commercial-term coverage; these are the real, researched variants.
  const relatedTerms = topics
    .find((topic) => topic.slug === idea.cluster)
    ?.keywords.filter((keyword) => keyword !== idea.targetKeyword)
    .slice(0, 6)
    .join(", ");

  const host = (SITE_URL ?? "").replace(/^https?:\/\//, "") || SITE_NAME;
  const input: CommercialInput = {
    host,
    buyerQuery: idea.targetKeyword,
    uniqueFact: facts.join(" "),
    liveUrls: await livePaths(),
  };

  // Money pages (SEO-G): join the allowlist BEFORE any prompt or audit sees
  // the input, so a written money link is a known link — never an "unknown"
  // hold. With MONEY_URLS unset this is a no-op and no code path differs.
  const moneyUrls = moneyUrlsFromEnv();
  if (moneyUrls.length > 0) {
    input.liveUrls = [...(input.liveUrls ?? []), ...moneyLiveUrls(moneyUrls)];
  }
  // Sister-site pages join the same allowlist, so a written sister link is a
  // known link, and the label tells the writer it is the owner's other site.
  const sister = sisterLinks();
  if (sister.length > 0) {
    const name = process.env.SISTER_SITE_NAME?.trim() || "sister site";
    input.liveUrls = [
      ...(input.liveUrls ?? []),
      ...sister.map((s) => `${s.url} — ${s.label} (${name}, same owner; one link at most)`),
    ];
  }

  const write = createLanguageWriter(locale.language);
  if (!write) throw new CommercialWriteError("No engine available");

  // Length follows the FACTS, not a quota. The judging round proved the
  // failure mode: four facts stretched to 792 words means every fact repeated
  // three times, weasel filler and invented comparisons. ~110 words is what a
  // fact honestly carries; below five facts the hint is dropped entirely and
  // the prompt's own "stop when answered" governs.
  const baseWords = idea.targetWords ?? (Number(process.env.TARGET_WORD_COUNT) || 0);
  const factCeiling = 150 + facts.length * 110;
  const targetWords =
    baseWords > 0 && facts.length >= 5
      ? Math.min(Math.round(baseWords * (idea.isPillar ? 1.5 : 1)), factCeiling)
      : 0;
  const lengthHint = buildLengthHint(targetWords, pack);

  // FAQ is requested through the input — the prompt adds it only when asked,
  // when research found useful unanswered questions. It is lifted after writing
  // into a structured FAQ block; JSON-LD stays on the current article policy.
  // Real data deserves a table — the prompt already allows one "when real data
  // justifies it"; nudge only when the facts actually carry numbers.
  const numericFacts = (facts.join(" ").match(/\p{Nd}/gu) ?? []).length;
  const tableHint = buildTableHint(numericFacts, pack);

  // The judges' verdicts, folded into standing input rules. These ride the
  // input (the prompt's sanctioned channel), so the prompt file stays a fixed
  // contract.
  const qualityRules = buildQualityRules(relatedTerms, pack);

  const faqRequest = buildFaqRequest(pack);

  // "" when MONEY_URLS is unset — appending it is then the identity, and the
  // assembled default prompt is unchanged (prompt-golden.test.ts).
  const moneyRider = buildMoneyLinkRider(moneyUrls, pack);

  const started = Date.now();
  // A malformed response is model variance, not a permanent fault — retry once
  // in place before dropping the idea back to the scheduler, which is faster
  // and stops a hard-to-titrate keyword from stalling behind a bad roll.
  const systemPrompt = buildSystemPrompt(locale);
  // The one-time competitive snapshot for this cluster, if the client bought
  // the research capability. Structure guidance only — the fact rules above
  // still forbid inventing anything about the business.
  let serpRider = "";
  try {
    const brief = await serpBriefFor(idea.cluster ?? null);
    if (brief) {
      serpRider = buildSerpRider(brief, pack);
    }
  } catch {
    serpRider = "";
  }
  // The clock rider: a model without today's date wrote a headline for a season
  // that had already ended. Appended last, after every frozen builder, so each
  // fixture in prompt-golden.test.ts is still produced unchanged.
  const todayRider = "\n\n" + todayContextBlock();
  const userPrompt =
    buildInputBlock(input) + qualityRules + serpRider + lengthHint + tableHint + faqRequest + moneyRider + todayRider;
  const first = await write(systemPrompt, userPrompt);
  let article = parseCommercialArticle(first);
  if (!article) {
    // A STOP is the prompt honestly refusing an impossible brief (usually the
    // length target vs the facts available) — retry without the length hint
    // and let "stop when answered" govern. Anything else is variance; retry
    // the same brief once.
    const wasStop = /^STOP:/m.test(first.trim());
    logger.warn(
      { keyword: idea.targetKeyword, wasStop },
      "[Commercial] Unusable output — retrying once"
    );
    const retryPrompt = wasStop
      ? buildInputBlock(input) + qualityRules + serpRider + tableHint + faqRequest + moneyRider + todayRider
      : userPrompt;
    article = parseCommercialArticle(await write(systemPrompt, retryPrompt));
  }
  if (!article) {
    throw new CommercialWriteError("Writer output did not follow the contract after retry");
  }

  let superlatives = auditSuperlatives(article, input, pack);
  let blocks: ContentBlock[] = [];
  let repeatedSpans: string[] = [];
  // Structure loop: one full retry when the finished article still carries a
  // structural defect (a sentence written twice, a section restating another,
  // a surviving boast). The retry is TOLD the defects — round-11 measurement:
  // roughly every second single-shot article repeats one sentence, and a
  // hold costs the operator more than one more call costs us.
  for (let attempt = 0; ; attempt++) {

  if (!superlatives.ok) {
    // One targeted rewrite: name the exact offending phrases. Cheaper than
    // holding every article over a single superlative the model slips in.
    logger.warn({ found: superlatives.found }, "[Commercial] Superlatives — targeted retry");
    const fixPrompt =
      buildInputBlock(input) +
      qualityRules +
      serpRider +
      buildSuperlativeRetryNote(superlatives.found, pack) +
      lengthHint +
      tableHint +
      faqRequest +
      moneyRider;
    const rewritten = parseCommercialArticle(
      await write(systemPrompt, fixPrompt)
    );
    if (rewritten) {
      const recheck = auditSuperlatives(rewritten, input, pack);
      if (recheck.ok || recheck.found.length < superlatives.found.length) {
        article = rewritten;
        superlatives = recheck;
      }
    }
  }

  // Editor pass: a second call over the FINAL text, grammar only. Round-6
  // judging showed each rewrite introduces fresh language errors the rules
  // never anticipated — a lint list can only name last round's mistakes.
  // The pass may not touch facts: it is accepted only if every deterministic
  // audit still passes and the length barely moved.
  if ((process.env.EDITOR_PASS ?? "true").toLowerCase() !== "false") {
    try {
      const serialized =
        `title: ${article.title}\nmeta: ${article.meta}\nslug: ${article.slug}\n` +
        `h1: ${article.h1}\nbody: ${article.body}\n` +
        `internal_links: ${article.internalLinks.join(", ") || "[]"}\n` +
        `facts_used: ${article.factsUsed.join("; ") || "—"}\nsources_used: ${article.sourcesUsed.join("; ") || "—"}`;
      const editPrompt = buildEditorPrompt(serialized, pack);
      const edited = parseCommercialArticle(await write(systemPrompt, editPrompt));
      if (edited) {
        const editedWords = edited.body.split(/\s+/).length;
        const originalWords = article.body.split(/\s+/).length;
        const candidate = { ...article, title: edited.title, meta: edited.meta, h1: edited.h1, body: edited.body };
        const lengthOk = Math.abs(editedWords - originalWords) <= Math.max(40, originalWords * 0.15);
        if (lengthOk && auditNumbers(candidate, input, pack).ok && auditSuperlatives(candidate, input, pack).ok) {
          article = candidate;
          logger.info({ originalWords, editedWords }, "[Commercial] Editor pass applied");
        } else {
          logger.warn({ lengthOk }, "[Commercial] Editor pass rejected — keeping original");
        }
      }
    } catch (error) {
      logger.warn({ error }, "[Commercial] Editor pass failed — keeping original");
    }
  }

  // The deterministic SEO/AEO score, same scorer as the legacy gate — but here
  // it is a grade for the operator, not a gate: the only thing that blocks is
  // an unsourced number. A 68 with honest facts beats a 90 with invented ones.
  const lifted = liftFaq(markdownToBlocks(article.body), pack.faqHeadingPattern);
  blocks = lifted.faq.length
    ? [
        ...lifted.blocks,
        {
          type: "faq",
          id: "faq-0",
          data: { items: lifted.faq.map((f) => ({ question: f.question, answer: f.answer })) },
        } as ContentBlock,
      ]
    : lifted.blocks;
  repeatedSpans = spanAuditBattery(blocks, idea.targetKeyword ?? "", input.uniqueFact, pack);

    if ((repeatedSpans.length === 0 && superlatives.ok) || attempt >= 1) break;
    logger.warn(
      { repeatedSpans, superlatives: superlatives.found },
      "[Commercial] Structural defects — full retry"
    );
    const structuralNote = buildStructuralRetryNote(repeatedSpans, superlatives.found, pack);
    const redo = parseCommercialArticle(
      await write(systemPrompt, userPrompt + structuralNote)
    );
    if (!redo) break;
    article = redo;
    superlatives = auditSuperlatives(article, input, pack);
  }

  // Brand overuse is repairable in place — no reason to burn a retry on it.
  {
    const brand = brandFromFact(input.uniqueFact);
    if (brand && pack.demotionNoun && brandDensityAudit(blocks, brand, pack).length) {
      demoteBrandMentions(blocks, brand, 8, pack);
      repeatedSpans = spanAuditBattery(blocks, idea.targetKeyword ?? "", input.uniqueFact, pack);
      logger.info({ remaining: repeatedSpans }, "[Commercial] Brand density repaired in place");
    }
  }

  // Coverage: how much of the confirmed-fact library this article actually
  // used. A piece that leaned on one fact out of six is thin by construction —
  // the operator sees the number instead of guessing why an article feels empty.
  const audit = auditNumbers(article, input, pack);
  const links = auditLinks(article, input);
  // Article-level gates (SEO-D): deterministic wordlist checks over the final
  // text. Their skip markers already ride skippedGates (collected upfront from
  // the pack), so only the named reasons are threaded from here.
  const vatQualifier = vatQualifierAudit(article, pack);
  const ymylPromises = ymylPromiseAudit(article, idea.targetKeyword ?? "", pack);
  const wordCount = article.body.split(/\s+/).length;
  const factCoverage = {
    provided: facts.length,
    used: Math.min(article.factsUsed.length, facts.length),
    // Words stretched per fact. Past ~160 the article is provably padding —
    // the judged failure was 792 words on four facts, 198 words each.
    wordsPerFact: facts.length > 0 ? Math.round(wordCount / facts.length) : wordCount,
  };

  // Cannibalisation guard: two near-identical articles on one site split their
  // own ranking. Compare against recent articles and hold a close match for
  // the operator instead of quietly publishing a twin.
  const similarTo = await findNearDuplicate(article.body);

  // A real photograph, engine-side, so the WordPress path gets a featured
  // image too (the Astro path can still override from the site's local bank).
  // Never blocking and never fatal: an article without a photo publishes; a
  // photo without an article is worthless.
  let heroImage: { url: string; altText: string } | null = null;
  try {
    // Reuse guard (SEO-E): the same stock photo on two articles reads as
    // template filler. The in-use hero/card URLs feed the provider's existing
    // excludeUrls filter, which takes the next candidate instead. A failed
    // lookup costs the guard, never the image.
    let excludeUrls: string[] = [];
    try {
      excludeUrls = await inUseImageUrls();
    } catch {
      excludeUrls = [];
    }
    heroImage = await findOrCreateArticleImage(
      idea.targetKeyword,
      idea.cluster ? [idea.cluster] : [],
      "guide",
      { excludeUrls }
    );
  } catch {
    heroImage = null;
  }

  // Two body photographs and at least one internal link: the customer site's
  // importer refuses the article without them, and both are things a script
  // can supply, so the article never waits for a person over them.
  try {
    const bodyImages = await findArticleBodyImages(
      idea.targetKeyword,
      idea.cluster ? [idea.cluster] : [],
      "guide",
      2,
      heroImage ? [heroImage.url] : []
    );
    if (bodyImages.length === 2) {
      blocks = insertBodyImages(blocks, bodyImages);
    } else {
      logger.warn({ found: bodyImages.length }, "[Commercial] Fewer than two body images available");
    }
  } catch (error) {
    logger.warn({ error }, "[Commercial] Body image lookup failed");
  }
  blocks = ensureInternalLinks(blocks, await internalLinkCandidates(), idea.targetKeyword ?? "");

  const report = scoreArticle({
    title: article.h1 || article.title,
    metaTitle: article.title,
    metaDescription: article.meta,
    primaryKeyword: idea.targetKeyword,
    blocks: blocks as never,
    heroImage: heroImage?.url ?? null,
    heroImageAlt: heroImage?.altText ?? null,
  });

  let faqOverlap = faqOverlapAudit(blocks, pack);
  if (faqOverlap.length) {
    // Targeted repair, same shape as the superlative retry: rewrite only the
    // offending answers. Each rewrite is accepted only if it stops overlapping
    // and introduces no number the input does not cover.
    logger.warn({ faqOverlap }, "[Commercial] FAQ overlap — targeted rewrite");
    const faqBlock = blocks.find((b) => b.type === "faq")?.data as
      | { items?: { question: string; answer: string }[] }
      | undefined;
    const inputNumbers = new Set(numbersIn(buildInputBlock(input)));
    for (const item of faqBlock?.items ?? []) {
      if (!faqOverlap.includes(item.question)) continue;
      try {
        const rewritten = (
          await write(systemPrompt,
            buildFaqRewritePrompt(item.question, item.answer, pack)
          )
        ).trim();
        const numbersOk = numbersIn(rewritten).every((n) => inputNumbers.has(n));
        if (rewritten.length > 40 && rewritten.length < item.answer.length * 3 && numbersOk) {
          item.answer = rewritten;
        }
      } catch {
        // keep the original answer; the hold below still protects the article
      }
    }
    faqOverlap = faqOverlapAudit(blocks, pack);
  }
  const contentId = await persist(
    article,
    {
      // The audit's own per-gate skip marker (a string) is superseded by the
      // collected skippedGates array below — drop it from the spread.
      ...(({ skipped: _numberAuditSkip, ...core }) => core)(audit),
      unknownLinks: links.unknown,
      genericAnchors: links.genericAnchors,
      vatQualifier: vatQualifier.reasons,
      ymylPromises: ymylPromises.reasons,
      factCoverage,
      similarTo,
      superlatives: superlatives.found,
      faqOverlap,
      repeatedSpans,
      // Additive field: present only when a gate was skipped, so a fully
      // audited article keeps its historical payload.
      ...(skippedGates.length ? { skipped: skippedGates } : {}),
    },
    idea,
    blocks,
    report.score,
    heroImage,
    deriveQuickFacts(blocks, facts),
    // The default locale keeps the env-driven slug behavior.
    locale.isDefault ? undefined : locale.language
  );

  logger.info(
    {
      contentId,
      seconds: Math.round((Date.now() - started) / 1000),
      numbersOk: audit.ok,
      unsupported: audit.unsupported,
      qualityScore: Math.round(report.score),
      factCoverage,
    },
    "[Commercial] Article written"
  );

  // Clean articles go to Gate 2 on their own; the reviewer approves and the
  // publish policy (AUTO_PUBLISH) decides whether that means live. Anything
  // the deterministic audits flagged — an unsourced number, an unknown link,
  // a near-twin of an existing article — stays held for a person.
  const cleanForReview = audit.ok && links.unknown.length === 0 && !similarTo;
  if (cleanForReview) {
    try {
      await jobQueue.addJob("gatekeeper_review" as JobType, { contentId, revisionCount: 0 }, { priority: 5 });
      logger.info({ contentId }, "[Commercial] Clean draft queued for Gate 2 review");
    } catch (error) {
      logger.warn({ contentId, error }, "[Commercial] Could not queue Gate 2 review — article stays in review");
    }
  } else {
    logger.info(
      { contentId, numbersOk: audit.ok, unknownLinks: links.unknown.length, similarTo: !!similarTo },
      "[Commercial] Held for a person"
    );
  }
  return { contentId, audit, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * The one span-audit battery, in one place. It was assembled twice with an
 * identical shape (post-write and post-brand-demotion) — a new audit added to
 * one copy and not the other would silently split the two verdicts. Entries
 * feed buildStructuralRetryNote (one full retry, defects named) and then the
 * hold via the persisted payload.
 */
function spanAuditBattery(
  blocks: ContentBlock[],
  keyword: string,
  uniqueFact: string,
  pack: LanguagePack
): string[] {
  const brand = brandFromFact(uniqueFact);
  return [
    ...bodyRepetitionAudit(blocks),
    ...sectionSimilarityAudit(blocks).map((p) => `sections restate each other: ${p}`),
    ...keywordHeadingAudit(blocks, keyword).map((h) => `keyword-stuffed heading: ${h}`),
    ...processLeakAudit(blocks, pack).map((l) => `process leak: ${l}`),
    ...brandDensityAudit(blocks, brand, pack).map((d) => `brand density: ${d}`),
    ...commoditySpanAudit(blocks, uniqueFact, brand).map((h) => `commodity section: ${h}`),
    ...ctaAudit(blocks, pack).map((s) => `multiple CTAs: ${s}`),
  ];
}

/**
 * MinHash the new body against the last 60 articles. 0.6 Jaccard on shingles
 * is far past normal topical overlap — it means the same article twice.
 */
async function findNearDuplicate(
  body: string
): Promise<{ id: string; title: string; similarity: number } | null> {
  const newSig = generateMinHash(body);
  const rows = await db
    .select({ id: contents.id, title: contents.title, blocks: contents.blocks })
    .from(contents)
    .orderBy(desc(contents.createdAt))
    .limit(60);

  for (const row of rows) {
    const text = JSON.stringify(row.blocks ?? []).replace(/<[^>]+>/g, " ");
    if (text.length < 200) continue;
    const similarity = calculateJaccardSimilarity(newSig, generateMinHash(text));
    if (similarity >= 0.6) {
      return { id: row.id, title: row.title, similarity: Number(similarity.toFixed(2)) };
    }
  }
  return null;
}

/**
 * Published paths the writer may link to, each carrying its title — an anchor
 * written blind ("read here") is worthless to Google; an anchor written against
 * the real title is a genuine internal link.
 */
/**
 * Pages an article may link to, with the label the site itself uses for them:
 * the operator's money pages (MONEY_URLS) first, then recently published
 * articles. Used only to add a "read also" line when the writer linked nothing.
 */
async function internalLinkCandidates(): Promise<LinkCandidate[]> {
  const money = moneyUrlsFromEnv().map((m) => ({ path: m.path, label: m.label }));
  const rows = await db
    .select({ slug: contents.slug, title: contents.title })
    .from(contents)
    .where(eq(contents.status, "published"))
    .orderBy(desc(contents.publishedAt))
    .limit(10);
  const prefix = process.env.ARTICLE_PATH_PREFIX?.trim() || "/guides";
  return [...money, ...rows.map((row) => ({ path: `${prefix}/${row.slug}/`, label: row.title }))];
}

async function livePaths(): Promise<string[]> {
  const rows = await db
    .select({ slug: contents.slug, title: contents.title })
    .from(contents)
    .where(eq(contents.status, "published"))
    .orderBy(desc(contents.publishedAt))
    .limit(15);
  const prefix = process.env.ARTICLE_PATH_PREFIX?.trim() || "/guides";
  return rows.map((row) => `${prefix}/${row.slug}/ — ${row.title}`);
}

/** One operator-declared money page: a site path and its human anchor label. */
export interface MoneyUrl {
  path: string;
  label: string;
}

/**
 * Parse MONEY_URLS: comma-separated `path=label` pairs naming the operator's
 * conversion pages ("/pricing=Pricing,/contact=Contact us").
 *
 * The env is operator-set but its labels still cross into the model input
 * (T-quick-01): paths must start with "/", labels are stripped of control
 * characters and newlines before they near a prompt, and malformed pairs are
 * skipped with a warn — never thrown, never half-parsed.
 */
export function moneyUrlsFromEnv(
  raw: string | undefined = process.env.MONEY_URLS
): MoneyUrl[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  const entries: MoneyUrl[] = [];
  for (const pair of value.split(",")) {
    const at = pair.indexOf("=");
    if (at === -1) {
      logger.warn({ pair }, "[Commercial] MONEY_URLS entry has no '=' — skipped");
      continue;
    }
    const path = pair.slice(0, at).trim();
    // eslint-disable-next-line no-control-regex
    const label = pair.slice(at + 1).replace(/[\x00-\x1f\x7f]/g, "").trim();
    if (!path.startsWith("/") || !label) {
      logger.warn({ pair }, "[Commercial] MONEY_URLS entry malformed — skipped");
      continue;
    }
    entries.push({ path, label });
  }
  return entries;
}

/** Money entries in the exact "path — label" shape livePaths produces, so the
 * auditLinks allowlist (which takes the first space-delimited token) accepts a
 * written money link for free. */
export function moneyLiveUrls(entries: MoneyUrl[]): string[] {
  return entries.map((entry) => `${entry.path} — ${entry.label}`);
}

/** The money-links rider, or "" when there are no entries — appending "" is
 * the identity that keeps the default (MONEY_URLS unset) prompt byte-exact. */
export function buildMoneyLinkRider(entries: MoneyUrl[], pack: LanguagePack = enPack): string {
  return entries.length > 0 ? pack.moneyLinkRider(entries) : "";
}

/**
 * Hero/card URLs already in use on other articles (SEO-E). Capped at the most
 * recent 500 rows — the reuse that matters is the visible recent window, and
 * an unbounded scan grows forever on a 300-article/month install.
 */
export async function inUseImageUrls(): Promise<string[]> {
  const rows = await db
    .select({ heroImage: contents.heroImage, cardImage: contents.cardImage })
    .from(contents)
    .orderBy(desc(contents.createdAt))
    .limit(500);
  const urls = new Set<string>();
  for (const row of rows) {
    if (row.heroImage) urls.add(row.heroImage);
    if (row.cardImage) urls.add(row.cardImage);
  }
  return [...urls];
}

/** The leading whole sentences of a paragraph, within a character budget. */
export function firstSentences(text: string, budget: number): string {
  // Latin-style terminators need a following space or the end, so "3.5" does
  // not split. CJK full stops take no space after them.
  const sentences =
    text.match(/.+?(?:[.!?\u061F\u06D4\u0964]+(?:\s|$)|[\u3002\uFF01\uFF1F]+\s*)/gs) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    if (out && (out + sentence).trim().length > budget) break;
    out += sentence;
  }
  return (out.trim() || text.slice(0, budget)).trim();
}

async function uniqueSlug(candidate: string, title: string, language?: string): Promise<string> {
  // English-by-default: a native-script slug turns to
  // percent-encoded gibberish in WhatsApp/email and the ranking upside is nil.
  // SLUG_STYLE=native restores the previous per-locale behavior. On any
  // failure to produce a clean English slug we fall through to the native
  // path below — an article is never lost to a slug.
  if (slugStyle() === "english") {
    const english = await englishSlug(title, candidate);
    if (english) {
      const clash = await db
        .select({ id: contents.id })
        .from(contents)
        .where(eq(contents.slug, english))
        .limit(1);
      return clash.length === 0 ? english : `${english}-${Date.now().toString(36)}`;
    }
  }
  // The prompt asks for a slug in the site's script; the model often
  // transliterates anyway ("mesachei-led-le-asakim"), which reads as gibberish
  // in the address bar and in the SERP. When the locale's pack demands a
  // script, a candidate without it is discarded and the slug derives from the
  // real title. No language passed → the OCTYPO_LOCALE env fallback, exactly
  // as before, so existing callers and tests are untouched.
  const effLang = language ?? (process.env.OCTYPO_LOCALE?.trim() || "en");
  const scriptPattern = packFor(effLang).slugScriptPattern;
  const effective =
    scriptPattern && candidate && !scriptPattern.test(candidate) ? "" : candidate;
  const base =
    (effective || title)
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "article";
  const taken = await db
    .select({ id: contents.id })
    .from(contents)
    .where(eq(contents.slug, base))
    .limit(1);
  return taken.length === 0 ? base : `${base}-${Date.now().toString(36)}`;
}

/**
 * Writing-process vocabulary leaking into reader-facing prose ("the facts
 * provided", "per the brief") cost round 10 more points than any other defect.
 * A reader must never learn the article was written from a briefing.
 * The vocabulary lives in the language pack; a language without a curated
 * list skips the gate (recorded as an explicit skipped marker upstream).
 */
export function processLeakAudit(blocks: ContentBlock[], pack: LanguagePack = enPack): string[] {
  const leaks = pack.processLeaks;
  if (!leaks) return [];
  const raw = blocks.map((b) => JSON.stringify(b.data)).join(" ");
  const text = pack.foldCase ? raw.toLowerCase() : raw;
  return leaks.filter((leak) => text.includes(leak));
}

/**
 * Deterministic repair for brand overuse: keep the first `cap` mentions (the
 * opening and price anchors come first), demote the rest to the pack's noun
 * ("the company"). Runs on prose and FAQ text only — headings and the table
 * keep their entity anchors.
 */
function demoteBrandMentions(
  blocks: ContentBlock[],
  brand: string,
  cap: number,
  pack: LanguagePack = enPack
): void {
  const noun = pack.demotionNoun;
  if (!brand || !noun) return;
  // Headings and the table keep their entity anchors and cannot be demoted —
  // spend their mentions against the cap first, then demote prose/FAQ beyond
  // what remains (never below two kept prose anchors: opening and price).
  let fixed = 0;
  for (const b of blocks) {
    if (b.type !== "text" && b.type !== "faq") {
      fixed += JSON.stringify(b.data).split(brand).length - 1;
    }
  }
  const budget = Math.max(2, cap - fixed);
  let seen = 0;
  const demote = (text: string): string => {
    let out = "";
    let rest = text;
    for (let at = rest.indexOf(brand); at !== -1; at = rest.indexOf(brand)) {
      seen++;
      out += rest.slice(0, at) + (seen <= budget ? brand : noun);
      rest = rest.slice(at + brand.length);
    }
    return out + rest;
  };
  for (const b of blocks) {
    if (b.type === "text") {
      const data = b.data as { content?: string };
      if (data.content) data.content = demote(data.content);
    }
    if (b.type === "faq") {
      const data = b.data as { items?: { question: string; answer: string }[] };
      for (const item of data.items ?? []) item.answer = demote(item.answer);
    }
  }
}

/**
 * Commodity sections (SEO-C): a heading-delimited section of ≥ 20 content
 * words that cites ZERO fact-derived tokens and never names the brand could
 * appear verbatim on any competitor's site — it is filler by construction.
 * One such section is a legitimate buyer-education block (the rider even asks
 * for one); TWO OR MORE mean the article is padding around its facts, so the
 * headings are returned only from the second qualifying section on.
 */
export function commoditySpanAudit(
  blocks: ContentBlock[],
  uniqueFact: string,
  brand: string
): string[] {
  const strip = (t: string) =>
    t.replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const factTokens = new Set(strip(uniqueFact).split(" ").filter((w) => w.length >= 4));

  const sections: { heading: string; raw: string }[] = [];
  let current: { heading: string; raw: string } | null = null;
  for (const b of blocks) {
    if (b.type === "heading") {
      current = { heading: strip(String((b.data as { text?: string }).text ?? "")), raw: "" };
      sections.push(current);
      continue;
    }
    if (!current || b.type === "faq") continue;
    current.raw += " " + JSON.stringify(b.data);
  }

  const commodity: string[] = [];
  for (const section of sections) {
    const words = strip(section.raw).split(" ").filter(Boolean);
    const contentWords = words.filter((w) => w.length >= 3);
    if (contentWords.length < 20) continue;
    const citesFact = words.some((w) => w.length >= 4 && factTokens.has(w));
    const namesBrand = brand !== "" && section.raw.includes(brand);
    if (!citesFact && !namesBrand) commodity.push(section.heading);
  }
  return commodity.length >= 2 ? commodity : [];
}

/**
 * CTA discipline (SEO-H): the rider mandates exactly ONE call to action — the
 * closing sentence with the phone. Spans are phone-number matches plus text
 * blocks that carry a contact-sentence marker WITHOUT a phone (a closing
 * sentence holding both the marker and the number is one CTA, not two).
 * More than one span holds the draft with every span named. Phone shapes are
 * country-neutral: an international "+" number, a trunk-zero national number,
 * or the 3-3-4 North American form. Bare digit runs never match, because prices
 * and dates look like them.
 */
const PHONE_RE =
  /(?<![\d+])(?:\+\d[\d\s().-]{6,17}\d|0\d{1,3}(?:[-.\s]?\d){6,8}|\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})(?!\d)/g;

export function ctaAudit(blocks: ContentBlock[], pack: LanguagePack = enPack): string[] {
  const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const markers = pack.ctaContactMarkers;
  const spans: string[] = [];

  for (const b of blocks) {
    if (b.type === "heading") continue;
    const text = strip(JSON.stringify(b.data));
    const phones = text.match(PHONE_RE) ?? [];
    if (phones.length > 0) {
      spans.push(...phones);
      continue;
    }
    if (b.type !== "text" || !markers) continue;
    const haystack = pack.foldCase ? text.toLowerCase() : text;
    if (markers.some((marker) => haystack.includes(marker))) {
      spans.push(text.slice(0, 60));
    }
  }
  return spans.length > 1 ? spans : [];
}

/** An article-level gate verdict with named reasons and an explicit skip. */
export interface ArticleGateAudit {
  ok: boolean;
  /** Named, human-readable reasons — these persist into the audit payload. */
  reasons: string[];
  /** Present when the language has no curated wordlist — gate skipped, explicitly. */
  skipped?: string;
}

/**
 * VAT qualifier (SEO-D): a price published without saying where it stands on
 * VAT is a price the customer can be held to twice. A price-like span with no
 * VAT or inclusive/exclusive token anywhere in the article is named and held.
 */
export function vatQualifierAudit(
  article: CommercialArticle,
  pack: LanguagePack = enPack
): ArticleGateAudit {
  if (!pack.priceMarkerPattern || !pack.vatQualifierWords) {
    return { ok: true, reasons: [], skipped: `no-vat-wordlist:${pack.code}` };
  }
  const text = `${article.title} ${article.meta} ${article.h1} ${article.body}`;
  const price = text.match(pack.priceMarkerPattern);
  if (!price || pack.vatQualifierWords.test(text)) return { ok: true, reasons: [] };
  return { ok: false, reasons: [`price without VAT qualifier: "${price[0].trim()}"`] };
}

/** Word-boundary for ASCII terms, substring otherwise — containsTerm's rule. */
function termIn(haystack: string, term: string): boolean {
  if (!/^[\x20-\x7F]+$/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * YMYL promises (SEO-D): on a health/money/legal topic, a promise verb
 * ("guaranteed") is a claim regulators and courts read literally. Named per
 * verb; a non-YMYL topic keeps its ordinary marketing language. The topic terms
 * mirror topic-safety.ts's shape but NOT its rules: stock-photo licensing
 * answers a different question.
 */
export function ymylPromiseAudit(
  article: CommercialArticle,
  keyword: string,
  pack: LanguagePack = enPack
): ArticleGateAudit {
  if (!pack.promiseVerbs || !pack.ymylTopicTerms) {
    return { ok: true, reasons: [], skipped: `no-promise-verb-list:${pack.code}` };
  }
  const topic = `${keyword} ${article.title}`.toLowerCase();
  if (!pack.ymylTopicTerms.some((term) => termIn(topic, term.toLowerCase()))) {
    return { ok: true, reasons: [] };
  }
  const raw = `${article.title} ${article.meta} ${article.h1} ${article.body}`;
  const text = pack.foldCase ? raw.toLowerCase() : raw;
  const reasons = pack.promiseVerbs
    .filter((verb) => termIn(text, pack.foldCase ? verb.toLowerCase() : verb))
    .map((verb) => `YMYL promise: "${verb}"`);
  return { ok: reasons.length === 0, reasons };
}

/** Brand density: past eight mentions the article reads as an advertorial. */
function brandDensityAudit(
  blocks: ContentBlock[],
  brand: string,
  pack: LanguagePack = enPack
): string[] {
  if (!brand) return [];
  const text = blocks.map((b) => JSON.stringify(b.data)).join(" ");
  const count = text.split(brand).length - 1;
  // Counting is language-neutral and runs for every language; only the
  // operator-facing message dispatches through the pack.
  return count > 8 ? [pack.brandDensityMessage(count)] : [];
}

/**
 * Two sections that restate each other share vocabulary even when every
 * 8-word span differs — the round-9 price sections were a pure paraphrase.
 * Content-word Jaccard >= 0.5 between two heading-delimited sections flags
 * the pair.
 */
function sectionSimilarityAudit(blocks: ContentBlock[]): string[] {
  const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const sections: { heading: string; words: Set<string> }[] = [];
  let current: { heading: string; words: Set<string> } | null = null;
  for (const b of blocks) {
    if (b.type === "heading") {
      current = { heading: strip(String((b.data as { text?: string }).text ?? "")), words: new Set() };
      sections.push(current);
      continue;
    }
    if (!current || b.type === "faq") continue;
    for (const w of strip(JSON.stringify(b.data)).split(" ")) {
      if (w.length >= 4) current.words.add(w);
    }
  }
  const flagged: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i].words;
      const b = sections[j].words;
      if (a.size < 8 || b.size < 8) continue;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      const jaccard = inter / (a.size + b.size - inter);
      if (jaccard >= 0.5) flagged.push(`${sections[i].heading} ~ ${sections[j].heading}`);
    }
  }
  return flagged;
}

/**
 * The exact primary keyword in more than one subheading is stuffing — a rule
 * the rider states and round 9 showed the model ignores. Enforced here.
 */
function keywordHeadingAudit(blocks: ContentBlock[], keyword: string): string[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const carrying = blocks
    .filter((b) => b.type === "heading")
    .map((b) => String((b.data as { text?: string }).text ?? ""))
    .filter((t) => t.toLowerCase().includes(kw));
  return carrying.length > 1 ? carrying : [];
}

/**
 * A full sentence repeated across sections reads as padding and was flagged by
 * five of six round-8 judges. Any 8-word span that appears twice anywhere in
 * the body (FAQ included) marks a repeated fact statement.
 */
function bodyRepetitionAudit(blocks: ContentBlock[]): string[] {
  const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = blocks
    .map((b) => strip(JSON.stringify(b.data)))
    .join(" ")
    .split(" ");
  const N = 10;
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (let i = 0; i + N <= words.length; i++) {
    const sh = words.slice(i, i + N).join(" ");
    if (seen.has(sh)) dups.add(sh);
    else seen.add(sh);
  }
  // Collapse overlapping windows: report up to three distinct spans.
  const out: string[] = [];
  for (const d of dups) {
    if (!out.some((o) => o.includes(d.slice(0, 30)) || d.includes(o.slice(0, 30)))) out.push(d);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * A FAQ answer that copies a 10-word span from the body is repetition, not a
 * new angle — the round-6 panel found 3 of 5 answers were verbatim body copy.
 */
export function faqOverlapAudit(
  blocks: ContentBlock[],
  pack: LanguagePack = enPack
): string[] {
  const faq = blocks.find((b) => b.type === "faq")?.data as
    | { items?: { question: string; answer: string }[] }
    | undefined;
  if (!faq?.items?.length) return [];
  const strip = (t: string) => t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const bodyWords = blocks
    .filter((b) => b.type !== "faq")
    .map((b) => strip(JSON.stringify(b.data)))
    .join(" ")
    .split(" ");
  // 5-word shingles with a 30% threshold: an answer paraphrased by swapping
  // one word in ten still shares most short shingles — the exact-span check
  // this replaces was defeated by exactly that.
  const N = 5;
  const shingles = new Set<string>();
  for (let i = 0; i + N <= bodyWords.length; i++) shingles.add(bodyWords.slice(i, i + N).join(" "));
  // Deictics dispatch per pack; the shingle-overlap check below is
  // language-neutral and always runs.
  const DEICTIC = pack.faqDeictics ?? [];
  const offenders: string[] = [];
  for (const item of faq.items) {
    // A FAQ answer is lifted standalone into JSON-LD: a pointer to "the
    // section above" or a bare yes/no that the rest of the answer contradicts
    // is broken exactly where an answer engine reads it.
    const answer = pack.foldCase ? item.answer.toLowerCase() : item.answer;
    if (DEICTIC.some((d) => answer.includes(d))) {
      offenders.push(item.question);
      continue;
    }
    const words = strip(item.answer).split(" ");
    if (words.length < N + 2) continue;
    let hits = 0;
    let total = 0;
    for (let i = 0; i + N <= words.length; i++) {
      total++;
      if (shingles.has(words.slice(i, i + N).join(" "))) hits++;
    }
    if (total > 0 && hits / total >= 0.2) offenders.push(item.question);
  }
  return offenders;
}

/**
 * The model occasionally writes a slug for an article it did not write — long,
 * thematic, unrelated to the final title. A slug is accepted only when it is
 * short and its words come from the title/h1; otherwise the keyword fallback
 * in uniqueSlug takes over.
 */
export function slugGate(article: CommercialArticle, keyword = ""): string {
  const slug = (article.slug ?? "").trim();
  if (!slug) return "";
  const words = slug.split("-").filter(Boolean);
  if (words.length > 6) return "";
  // A token mixing Latin with another script is a half-transliteration — junk
  // in any address bar. One bad token discards the whole candidate.
  const singleScript = /^(?:[\p{Script=Latin}\p{M}\p{N}]+|(?:(?!\p{Script=Latin})[\p{L}\p{M}\p{N}])+)$/u;
  if (!words.every((w) => singleScript.test(w))) return "";
  const source = `${article.title} ${article.h1} ${keyword}`.toLowerCase();
  const known = words.filter((w) => source.includes(w.toLowerCase())).length;
  return known >= Math.ceil(words.length / 2) ? slug : "";
}

/** The audit verdicts persist() folds into the stored seoSchema payload. */
export interface PersistAuditInput {
  ok: boolean;
  unsupported: string[];
  unknownLinks?: string[];
  genericAnchors?: string[];
  vatQualifier?: string[];
  ymylPromises?: string[];
  factCoverage?: { provided: number; used: number; wordsPerFact?: number };
  similarTo?: { id: string; title: string; similarity: number } | null;
  superlatives?: string[];
  faqOverlap?: string[];
  repeatedSpans?: string[];
  skipped?: string[];
}

/**
 * The stored audit payload, or null when every gate is clean.
 *
 * The null-vs-payload split is a compatibility contract: a fully-clean
 * default-path article has stored `seoSchema: null` since the first audit
 * shipped, and the Review UI treats null as "nothing to show". Every
 * NEW key is additive — spread in only when non-empty — so a clean article's
 * payload shape (null) and a legacy-defect article's key set are both
 * byte-identical to their historical forms.
 */
export function buildSeoSchemaPayload(audit: PersistAuditInput): Record<string, unknown> | null {
  const clean =
    audit.ok &&
    !(audit.unknownLinks && audit.unknownLinks.length) &&
    !audit.similarTo &&
    (audit.factCoverage?.wordsPerFact ?? 0) <= 160 &&
    !(audit.superlatives && audit.superlatives.length) &&
    !(audit.faqOverlap && audit.faqOverlap.length) &&
    !(audit.repeatedSpans && audit.repeatedSpans.length) &&
    !(audit.skipped && audit.skipped.length) &&
    !(audit.genericAnchors && audit.genericAnchors.length) &&
    !(audit.vatQualifier && audit.vatQualifier.length) &&
    !(audit.ymylPromises && audit.ymylPromises.length);
  if (clean) return null;
  return {
    numberAudit: { unsupported: audit.unsupported },
    linkAudit: { unknown: audit.unknownLinks ?? [] },
    factCoverage: audit.factCoverage,
    similarTo: audit.similarTo ?? null,
    superlatives: audit.superlatives ?? [],
    faqOverlap: audit.faqOverlap ?? [],
    repeatedSpans: audit.repeatedSpans ?? [],
    // Only when non-empty: a fully audited article keeps its exact historical
    // payload shape.
    ...(audit.skipped && audit.skipped.length ? { skipped: audit.skipped } : {}),
    ...(audit.genericAnchors && audit.genericAnchors.length
      ? { genericAnchors: audit.genericAnchors }
      : {}),
    ...(audit.vatQualifier && audit.vatQualifier.length
      ? { vatQualifier: audit.vatQualifier }
      : {}),
    ...(audit.ymylPromises && audit.ymylPromises.length
      ? { ymylPromises: audit.ymylPromises }
      : {}),
  };
}

async function persist(
  article: CommercialArticle,
  audit: PersistAuditInput,
  idea: { title: string; cluster: string | null; targetKeyword?: string },
  blocks: ContentBlock[],
  qualityScore: number,
  heroImage: { url: string; altText: string } | null,
  quickFacts: { label: string; value: string }[],
  slugLanguage?: string
): Promise<string> {
  const firstText = blocks.find((b) => b.type === "text")?.data as
    | { content?: string }
    | undefined;
  const firstParagraph = (firstText?.content ?? "").replace(/<[^>]+>/g, "").trim();

  const [row] = await db
    .insert(contents)
    .values({
      title: article.h1 || article.title,
      // Slug is NOT NULL and unique. The prompt supplies one; a collision or a
      // blank falls back to a time-suffixed keyword slug rather than failing
      // the whole write.
      slug: await uniqueSlug(slugGate(article), idea.targetKeyword || idea.title, slugLanguage),
      // Held for a human when a number has no source — never auto-published.
      status: "in_review",
      summary: article.meta,
      // Whole sentences only — a capsule cut mid-word reads broken in the box
      // the site renders it in, and in whatever an assistant lifts from it.
      answerCapsule: firstSentences(firstParagraph, 360),
      metaTitle: article.title,
      metaDescription: article.meta,
      blocks,
      wordCount: article.body.split(/\s+/).length,
      writerId: "commercial",
      aeoScore: Math.round(qualityScore),
      // The site importers file the article under its query and show these
      // facts beside it; both were missing and every article was refused.
      primaryKeyword: idea.targetKeyword ?? null,
      quickFacts: (quickFacts.length ? quickFacts : null) as never,
      heroImage: heroImage?.url ?? null,
      heroImageAlt: heroImage?.altText ?? null,
      cardImage: heroImage?.url ?? null,
      cardImageAlt: heroImage?.altText ?? null,
      seoSchema: buildSeoSchemaPayload(audit) as never,
    })
    .returning({ id: contents.id });

  const faqBlock = blocks.find((b) => b.type === "faq") as
    | { data: { items: { question: string; answer: string }[] } }
    | undefined;
  await db.insert(articles).values({
    contentId: row.id,
    category: "guide",
    relatedTopicIds: idea.cluster ? [idea.cluster] : [],
    // Publish keeps these questions visible without legacy FAQPage markup.
    faq: faqBlock ? faqBlock.data.items.map((i) => ({ question: i.question, answer: i.answer })) : [],
  });

  return row.id;
}
