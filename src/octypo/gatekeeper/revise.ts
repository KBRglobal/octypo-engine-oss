/**
 * Apply Gate 2's corrections to the article that exists.
 *
 * The revision job used to hand the title to the writer with
 * `contentType: "revision"` and get back a brand-new article from the English
 * template: the corrections were never read, a news piece in another language
 * came back as an English guide, and it failed the 900-word floor three times
 * in a row. On an auto-publish install every "revise" verdict
 * therefore stranded the article in review, silently.
 *
 * This module is the editor instead of the writer: it serialises the
 * editable parts of the stored article (title, meta, capsule, headings, text
 * blocks, FAQ), sends them with the corrections, and writes the edited text
 * back into the SAME blocks by id. Images and structure are untouched, the
 * language is checked, and a revision that shrank the article is refused.
 *
 * Pure except `reviseArticle`, which takes its LLM call so the whole path is
 * testable without a model.
 */

import { sanitizeHtml } from "../../lib/sanitize-html.js";
import { parseJsonLoose } from "../../lib/json-repair.js";
import { todayContextBlock } from "../../lib/today.js";
import { CONTENT_LANGUAGE, LANGUAGE_RULE } from "../../config/domain.js";
import type { CorrectionInstruction } from "./types.js";

export interface ContentBlockLike {
  type: string;
  id?: string;
  data?: Record<string, unknown> | null;
}

export interface RevisableArticle {
  title: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  answerCapsule?: string | null;
  blocks: ContentBlockLike[];
}

interface EditableSection {
  id: string;
  kind: "heading" | "text";
  text: string;
}

interface EditableFaq {
  question: string;
  answer: string;
}

export interface EditableArticle {
  title: string;
  metaTitle: string;
  metaDescription: string;
  answerCapsule: string;
  sections: EditableSection[];
  faqs: EditableFaq[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The parts an editor may change, keyed so they can be written back. */
export function toEditable(article: RevisableArticle): EditableArticle {
  const sections: EditableSection[] = [];
  let faqs: EditableFaq[] = [];
  article.blocks.forEach((block, index) => {
    const id = block.id || `block-${index}`;
    const data = block.data ?? {};
    if (block.type === "heading") sections.push({ id, kind: "heading", text: str(data.text) });
    else if (block.type === "text" || block.type === "paragraph") {
      sections.push({ id, kind: "text", text: str(data.content) || str(data.text) });
    } else if (block.type === "faq" && Array.isArray(data.items)) {
      faqs = (data.items as Array<Record<string, unknown>>).map(item => ({
        question: str(item?.question),
        answer: str(item?.answer),
      }));
    }
  });
  return {
    title: article.title,
    metaTitle: article.metaTitle ?? "",
    metaDescription: article.metaDescription ?? "",
    answerCapsule: article.answerCapsule ?? "",
    sections,
    faqs,
  };
}

export function buildRevisionPrompts(
  editable: EditableArticle,
  corrections: CorrectionInstruction[],
  reviewerNotes: string | undefined,
  now: Date = new Date(),
  linksBlock = ""
): { system: string; user: string } {
  const system = `You are the revising editor of an article that a reviewer sent back with corrections.
You EDIT the existing article. You do not write a new one.

${todayContextBlock(now)}

${LANGUAGE_RULE}
${linksBlock ? `\n${linksBlock}\n- When a correction asks for internal links, add them inside existing text sections as <a href="/path/">descriptive anchor in ${CONTENT_LANGUAGE}</a>, using only the paths listed above. At least 3, each on a different page, each anchor a descriptive phrase.\n` : ""}
Rules:
- Apply every correction listed. Change nothing the corrections do not ask for, beyond what the edit itself requires.
- Keep the language of the article (${CONTENT_LANGUAGE}). Never switch languages, never mix.
- Keep every section id exactly as given and keep the sections in the same order. You may rewrite a section's text; you may not delete a section, add a section, or change a heading into text.
- Keep the article at least as long as it is now unless a correction explicitly asks to shorten a part.
- Do not invent facts, figures, dates, names or sources. If a correction asks for a fact you do not have, rewrite the sentence so it no longer needs it.
- answerCapsule: 40-60 words, a direct answer in whole sentences.
- metaDescription: whole sentences only, never cut mid-sentence.
- Text sections may contain simple HTML (<p>, <a href="/internal/path/">, <strong>, <ul>, <li>). No markdown, no emojis.
- Return ONLY JSON with exactly this shape:
{
  "title": string,
  "metaTitle": string,
  "metaDescription": string,
  "answerCapsule": string,
  "sections": [{ "id": string, "kind": "heading" | "text", "text": string }],
  "faqs": [{ "question": string, "answer": string }]
}`;

  const list = corrections
    .map((c, i) => `${i + 1}. [${c.priority}] ${c.section}: ${c.issue} → ${c.instruction}`)
    .join("\n");
  const user = `CORRECTIONS TO APPLY:
${list || "(none listed — apply the reviewer's notes below)"}

${reviewerNotes ? `REVIEWER'S NOTES:\n${reviewerNotes}\n\n` : ""}THE ARTICLE (edit this, keep the ids):
${JSON.stringify(editable, null, 2)}`;
  return { system, user };
}

/** The scripts the language check tells apart. Kana and Han count as one. */
const SCRIPTS: Array<[string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/gu],
  ["Cyrillic", /\p{Script=Cyrillic}/gu],
  ["Greek", /\p{Script=Greek}/gu],
  ["Arabic", /\p{Script=Arabic}/gu],
  ["Hebrew", /\p{Script=Hebrew}/gu],
  ["Devanagari", /\p{Script=Devanagari}/gu],
  ["Thai", /\p{Script=Thai}/gu],
  ["Hangul", /\p{Script=Hangul}/gu],
  ["CJK", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
];

/** Share of the text's letters written in one script. */
export function scriptShare(text: string, pattern: RegExp): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 0;
  return (text.match(pattern) ?? []).length / letters.length;
}

/**
 * Why an edit left the article's language, or null when it did not. The script
 * mix is the fingerprint: it needs no vocabulary, so it works for any pair of
 * scripts. Two languages sharing a script look alike here; the prompt's
 * language rule is what holds those.
 */
export function scriptSwitch(before: string, after: string): string | null {
  for (const [name, pattern] of SCRIPTS) {
    const shareBefore = scriptShare(before, pattern);
    const shareAfter = scriptShare(after, pattern);
    if (shareBefore >= 0.3 && shareAfter < 0.3) return `editor switched the article out of ${name} script`;
    if (shareBefore < 0.05 && shareAfter > 0.3) return `editor switched the article into ${name} script`;
  }
  return null;
}

function wordCount(text: string): number {
  return text
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(t => /[\p{L}\p{N}]/u.test(t)).length;
}

function allText(e: EditableArticle): string {
  return [e.title, e.answerCapsule, ...e.sections.map(s => s.text), ...e.faqs.flatMap(f => [f.question, f.answer])].join(" ");
}

export interface RevisionOutcome {
  ok: boolean;
  reason?: string;
  article?: RevisableArticle & { wordCount: number };
}

/**
 * Parse the editor's JSON and write it back into the original blocks. Any
 * violation of the contract (missing ids, a language switch, a shrunken
 * article) refuses the revision with a reason the log can carry.
 */
export function applyRevision(original: RevisableArticle, response: string): RevisionOutcome {
  let jsonString = response.trim();
  if (jsonString.startsWith("```json")) jsonString = jsonString.slice(7);
  if (jsonString.startsWith("```")) jsonString = jsonString.slice(3);
  if (jsonString.endsWith("```")) jsonString = jsonString.slice(0, -3);
  const match = /\{[\s\S]*\}/.exec(jsonString);
  if (!match) return { ok: false, reason: "editor returned no JSON" };

  let parsed: Partial<EditableArticle>;
  try {
    parsed = parseJsonLoose<Partial<EditableArticle>>(match[0]);
  } catch (error) {
    return { ok: false, reason: `editor JSON did not parse: ${error instanceof Error ? error.message : String(error)}` };
  }

  const before = toEditable(original);
  const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const byId = new Map(sections.filter(s => s && typeof s.id === "string").map(s => [s.id, s]));
  // A long article's reply often stops short of the last sections (the
  // editor's output budget). Those sections keep their text, so nothing is
  // lost; refusing the whole revision for it left articles in review for
  // good. A reply with no section of the article is still
  // refused: that is not an edit of this article.
  const missing = before.sections.filter(s => !byId.has(s.id)).map(s => s.id);
  if (before.sections.length > 0 && missing.length === before.sections.length) {
    return { ok: false, reason: `editor dropped section(s): ${missing.join(", ")}` };
  }

  const edited: EditableArticle = {
    title: str(parsed.title).trim() || before.title,
    metaTitle: str(parsed.metaTitle).trim() || before.metaTitle,
    metaDescription: str(parsed.metaDescription).trim() || before.metaDescription,
    answerCapsule: str(parsed.answerCapsule).trim() || before.answerCapsule,
    sections: before.sections.map(s => ({ id: s.id, kind: s.kind, text: str(byId.get(s.id)?.text).trim() || s.text })),
    faqs:
      Array.isArray(parsed.faqs) && parsed.faqs.length > 0
        ? parsed.faqs.map(f => ({ question: str(f?.question).trim(), answer: str(f?.answer).trim() })).filter(f => f.question && f.answer)
        : before.faqs,
  };

  const beforeText = allText(before);
  const afterText = allText(edited);
  const switched = scriptSwitch(beforeText, afterText);
  if (switched) return { ok: false, reason: switched };

  const wordsBefore = wordCount(beforeText);
  const wordsAfter = wordCount(afterText);
  if (wordsBefore >= 200 && wordsAfter < wordsBefore * 0.7) {
    return { ok: false, reason: `editor shrank the article from ${wordsBefore} to ${wordsAfter} words` };
  }

  const sectionById = new Map(edited.sections.map(s => [s.id, s]));
  let index = -1;
  const blocks: ContentBlockLike[] = original.blocks.map(block => {
    index += 1;
    const id = block.id || `block-${index}`;
    const data = { ...(block.data ?? {}) };
    if (block.type === "heading") {
      const s = sectionById.get(id);
      return s ? { ...block, data: { ...data, text: s.text } } : block;
    }
    if (block.type === "text" || block.type === "paragraph") {
      const s = sectionById.get(id);
      if (!s) return block;
      const html = sanitizeHtml(s.text);
      return { ...block, data: { ...data, ...(block.type === "text" ? { content: html } : { text: html }) } };
    }
    if (block.type === "faq") {
      return { ...block, data: { ...data, items: edited.faqs } };
    }
    return block;
  });

  return {
    ok: true,
    article: {
      title: edited.title,
      metaTitle: edited.metaTitle,
      metaDescription: edited.metaDescription,
      answerCapsule: edited.answerCapsule,
      blocks,
      wordCount: wordsAfter,
    },
  };
}

/** `attempt` starts at 0; an implementation may pick a different engine per attempt. */
export type EditorCall = (system: string, user: string, attempt: number) => Promise<string>;

/**
 * The editor pass: prompt, call, apply — up to `attempts` times, because a
 * refused revision (language switch, dropped section) is usually one model
 * having a bad roll, and the next engine gets it right. Never throws; the
 * outcome carries the last reason.
 */
export async function reviseArticle(
  original: RevisableArticle,
  corrections: CorrectionInstruction[],
  reviewerNotes: string | undefined,
  callEditor: EditorCall,
  now: Date = new Date(),
  linksBlock = "",
  attempts = 2
): Promise<RevisionOutcome> {
  const { system, user } = buildRevisionPrompts(toEditable(original), corrections, reviewerNotes, now, linksBlock);
  let last: RevisionOutcome = { ok: false, reason: "no attempt made" };
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    let response: string;
    try {
      response = await callEditor(system, user, attempt);
    } catch (error) {
      last = { ok: false, reason: `editor call failed: ${error instanceof Error ? error.message : String(error)}` };
      continue;
    }
    last = applyRevision(original, response);
    if (last.ok) return last;
  }
  return last;
}
