import { and, isNull, ne } from "drizzle-orm";

import { contents } from "../schema/index.js";

type Block = { type?: unknown; data?: Record<string, unknown> | null };

export interface ContentQualityIssue {
  code:
    | "INTENT_COST"
    | "INTENT_TIMELINE"
    | "TEXT_JOIN"
    | "HEADING_STUFFING"
    | "CORPUS_DUPLICATE"
    | "CORPUS_STRUCTURE";
  message: string;
  matchedSlugs?: string[];
}

export interface ContentQualityInput {
  id?: string | null;
  title: string;
  primaryKeyword?: string | null;
  answerCapsule?: string | null;
  blocks?: Block[] | null;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function plain(value: unknown): string {
  return decodeBasicEntities(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'$€£¥₪%]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editorialUnits(blocks: Block[] | null | undefined): string[] {
  const units: string[] = [];
  let skipNextText = false;

  for (const block of blocks ?? []) {
    const type = String(block?.type ?? "");
    if (type === "heading") {
      const heading = plain(block.data?.text ?? block.data?.content);
      skipNextText = /^(?:sources(?: and further reading)?|references|further reading)$/i.test(heading);
      continue;
    }
    if (type !== "text") continue;
    if (skipNextText) {
      skipNextText = false;
      continue;
    }

    const html = String(block.data?.content ?? "");
    const tagged = [...html.matchAll(/<(p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map(match => plain(match[2]))
      .filter(Boolean);
    const candidates = tagged.length > 0 ? tagged : [plain(html)];
    for (const candidate of candidates) {
      const words = candidate.split(/\s+/).filter(Boolean).length;
      if (words >= 14 && candidate.length >= 90) units.push(normalise(candidate));
    }
  }

  return [...new Set(units)];
}

function editorialStructure(blocks: Block[] | null | undefined): string {
  const generic = new Set([
    "sources and further reading",
    "frequently asked questions",
    "related decisions and next steps",
    "turn the decision into a clear brief",
  ]);
  return (blocks ?? [])
    .filter(block => block.type === "heading")
    .map(block => normalise(plain(block.data?.text ?? block.data?.content)))
    .filter(heading => heading && !generic.has(heading))
    .join("|");
}

export function intentAnswerIssues(input: ContentQualityInput): ContentQualityIssue[] {
  const query = `${input.title} ${input.primaryKeyword ?? ""}`.toLowerCase();
  const firstText = plain((input.blocks ?? []).find(block => block.type === "text")?.data?.content);
  const answer = `${plain(input.answerCapsule)} ${firstText}`.trim().slice(0, 1600);
  const issues: ContentQualityIssue[] = [];

  if (/\b(?:how much|cost|price|pricing)\b/.test(query)) {
    const hasPrice = /(?:[$€£¥₪]\s?\d|\d[\d,.]*\s?(?:usd|eur|gbp|aed|nis|ils)|\b(?:fixed price|fixed estimate|quote|proposal|estimate|scope|depends on)\b)/i.test(answer);
    const hasDrivers = /\b(?:scope|tier|starter|custom|build|maintenance|usage|integration|deliverable|ownership)\b/i.test(answer);
    if (!hasPrice || !hasDrivers) {
      issues.push({
        code: "INTENT_COST",
        message: "A cost or price page must answer with a verified range or a clear scope-and-quote mechanism near the opening.",
      });
    }
  }

  if (/\b(?:how long|timeline|duration|time to)\b/.test(query)) {
    const timeUnits = new Set(answer.toLowerCase().match(/\b(?:hours?|days?|weeks?|months?|years?)\b/g) ?? []);
    const hasCondition = /\b(?:if|when|provided|depends|varies|scope|ready|approval|integration|migration|complexity)\b/i.test(answer);
    if (timeUnits.size < 2 || !hasCondition) {
      issues.push({
        code: "INTENT_TIMELINE",
        message: "A timeline page must give a bounded duration using at least two time units and state the conditions that change it near the opening.",
      });
    }
  }

  return issues;
}

export function editorialStyleIssues(input: ContentQualityInput): ContentQualityIssue[] {
  const issues: ContentQualityIssue[] = [];
  const bodyText = (input.blocks ?? [])
    .map(block => {
      if (block.type === "text") return plain(block.data?.content);
      if (block.type === "heading") return plain(block.data?.text ?? block.data?.content);
      if (block.type === "faq" && Array.isArray(block.data?.items)) {
        return (block.data.items as Array<{ question?: unknown; answer?: unknown }>)
          .map(item => `${plain(item.question)} ${plain(item.answer)}`)
          .join(" ");
      }
      return "";
    })
    .join(" ");
  const joinedArticleWord = /\b(?:Abusiness|Awebsite|Aservice|Aproject|Apage|Avisitor|Areader|Ateam|Acompany|Anarticle|Anagency|Anexample|Anestimate|Anoffer|Thebusiness|Thewebsite|Theservice|Theproject|Thepage|Thevisitor|Thereader|Theteam|Thecompany)\b/;
  if (joinedArticleWord.test(bodyText)) {
    issues.push({
      code: "TEXT_JOIN",
      message: "Body copy contains a joined article and noun (for example, 'Abusiness'). Restore the missing space before publication.",
    });
  }

  const keyword = normalise(String(input.primaryKeyword ?? ""));
  if (keyword) {
    const carryingHeadings = (input.blocks ?? [])
      .filter(block => block.type === "heading")
      .map(block => plain(block.data?.text ?? block.data?.content))
      .filter(heading => normalise(heading).includes(keyword));
    if (carryingHeadings.length > 1) {
      issues.push({
        code: "HEADING_STUFFING",
        message: `The exact primary keyword appears in ${carryingHeadings.length} subheadings. Keep it in at most one and make the remaining headings concise and specific.`,
      });
    }
  }
  return issues;
}

export function corpusDuplicateIssues(
  candidate: ContentQualityInput,
  corpus: Array<{ id: string; slug: string; blocks: unknown }>
): ContentQualityIssue[] {
  const candidateUnits = editorialUnits(candidate.blocks);
  const candidateStructure = editorialStructure(candidate.blocks);
  const issues: ContentQualityIssue[] = [];

  const matches = new Map<string, Set<string>>();
  const structureMatches = new Set<string>();
  for (const row of corpus) {
    if (candidate.id && row.id === candidate.id) continue;
    const otherBlocks = Array.isArray(row.blocks) ? (row.blocks as Block[]) : [];
    const otherUnits = new Set(editorialUnits(otherBlocks));
    for (const unit of candidateUnits) {
      if (!otherUnits.has(unit)) continue;
      const slugs = matches.get(unit) ?? new Set<string>();
      slugs.add(row.slug);
      matches.set(unit, slugs);
    }
    if (
      candidateStructure.split("|").filter(Boolean).length >= 3 &&
      candidateStructure === editorialStructure(otherBlocks)
    ) {
      structureMatches.add(row.slug);
    }
  }

  if (matches.size > 0) {
    const matchedSlugs = [...new Set([...matches.values()].flatMap(slugs => [...slugs]))].sort();
    issues.push({
      code: "CORPUS_DUPLICATE",
      message: `${matches.size} long editorial passage(s) are duplicated from another article. Rewrite or remove the boilerplate before publication.`,
      matchedSlugs,
    });
  }
  if (structureMatches.size > 0) {
    issues.push({
      code: "CORPUS_STRUCTURE",
      message: "The meaningful heading sequence duplicates another article. Give this article a topic-specific structure before publication.",
      matchedSlugs: [...structureMatches].sort(),
    });
  }
  return issues;
}

export async function auditContentAgainstCorpus(input: ContentQualityInput): Promise<ContentQualityIssue[]> {
  const { db } = await import("../db.js");
  const rows = await db
    .select({ id: contents.id, slug: contents.slug, blocks: contents.blocks })
    .from(contents)
    .where(
      input.id
        ? and(isNull(contents.deletedAt), ne(contents.id, input.id))
        : isNull(contents.deletedAt)
    );
  return [
    ...intentAnswerIssues(input),
    ...editorialStyleIssues(input),
    ...corpusDuplicateIssues(input, rows),
  ];
}
