/**
 * Read a keyword export out of whatever tool the operator already pays for.
 *
 * Volume, difficulty and the suggestions around a seed are what a paid keyword
 * tool sells, and no free source replaces them.
 *
 * What it does NOT need is an API key or a subscription we control. Every
 * one of those tools exports a table, so the desk reads the table. That
 * works with Semrush, Ahrefs, Keyword Planner or a sheet somebody typed by
 * hand, and it keeps working when a tool changes its pricing.
 *
 * Columns are matched by their English names, because every export spells them
 * differently and the operator should not have to rename anything before
 * pasting. A table headed in another language is read by what its columns
 * contain instead, in `columnsByContent`.
 */

import { words } from "../seo/words.js";

export type Intent = "brand" | "local" | "commercial" | "informational";

const LOCAL_WORDS = /\bnear me\b|\bnearby\b/;
const BUYER_WORDS = /\b(buy|price|prices|pricing|cost|hire|quote|cheap|best|service|services|company|companies)\b/;
const READER_WORDS = /\b(how|what|why|when|who|guide|ideas|tips|meaning)\b/;

/**
 * A first-pass sort for a keyword sheet. The word lists are English; a phrase
 * in any other language falls through to "commercial", which is how a bare
 * service phrase behaves.
 */
function classifyIntent(keyword: string, brandTerms: string[] = []): Intent {
  const phrase = keyword.trim().toLowerCase();
  if (brandTerms.some((b) => b.trim().length > 2 && phrase.includes(b.trim().toLowerCase()))) {
    return "brand";
  }
  if (LOCAL_WORDS.test(phrase)) return "local";
  if (BUYER_WORDS.test(phrase)) return "commercial";
  if (READER_WORDS.test(phrase)) return "informational";
  return "commercial";
}

export interface ImportedKeyword {
  keyword: string;
  /** Average monthly searches. */
  volume: number | null;
  /** Difficulty 0–100, whatever the tool calls it. */
  difficulty: number | null;
  /** Cost per click, when the export carries it. */
  cpc: number | null;
}

export interface ImportResult {
  keywords: ImportedKeyword[];
  /** Which column each field was read from, so a bad guess is visible. */
  columns: { keyword: string; volume?: string; difficulty?: string; cpc?: string };
  skipped: number;
}

const KEYWORD_NAMES =
  /^(keyword|keywords|key phrase|phrase|query|search query|search term|term)$/i;
const VOLUME_NAMES =
  /^(volume|search volume|avg\.? monthly searches|monthly searches|searches|vol)$/i;
const DIFFICULTY_NAMES = /^(kd|keyword difficulty|difficulty|competition)$/i;
const CPC_NAMES = /^(cpc|cost per click)$/i;

/** Split one line of a delimited file, honouring quotes. */
function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim().replace(/^"|"$/g, ""));
}

/** Whichever of comma, tab or semicolon the header actually uses. */
function detectDelimiter(header: string): string {
  const counts: [string, number][] = [
    [",", (header.match(/,/g) ?? []).length],
    ["\t", (header.match(/\t/g) ?? []).length],
    [";", (header.match(/;/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/**
 * Numbers arrive formatted: "1,300", "1.3K", "<10", "—". A figure that
 * cannot be read becomes null rather than zero, because zero is a claim.
 */
function toNumber(raw: string): number | null {
  const text = (raw ?? "").trim();
  if (!text || /^[-–—]$/.test(text) || /^n\/?a$/i.test(text)) return null;
  const thousands = /^([\d.,]+)\s*k$/i.exec(text);
  if (thousands) {
    const n = Number(thousands[1].replace(/,/g, ""));
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }
  // "<10" is a real answer from a volume tool: some demand, below reporting.
  const below = /^[<]\s*([\d.,]+)$/.exec(text);
  if (below) {
    const n = Number(below[1].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(text.replace(/[,\s%\p{Sc}]/gu, ""));
  return Number.isFinite(n) ? n : null;
}

/** A cell that reads as a search phrase: letters, and not a number or a URL. */
function isPhrase(cell: string): boolean {
  return /\p{L}/u.test(cell) && toNumber(cell) === null && !/:\/\/|^[^\s]+\.[a-z]{2,}(\/|$)/i.test(cell);
}

const MOST = 0.8;

/**
 * Find the columns of a table whose headings are not ones we know, from what
 * the cells hold, so an export headed in any language can still be read.
 *
 * The keyword column is the one column of phrases. It has to be unmistakable:
 * most cells text, at least half of them more than one word, and no second
 * column that fits. A table of cities and populations has the same shape as a
 * keyword export but its cells are single words, so it is still refused, and
 * two candidates are refused too. Importing the wrong column silently would put
 * invented phrases into a client's campaign.
 *
 * Of the numeric columns, one with fractions is the cost per click, the first
 * other is the volume, and the next that stays within 0-100 is the difficulty.
 * Which column fed which field is reported in `columns`, so a bad guess shows.
 */
function columnsByContent(
  rows: string[][],
  width: number
): { keywordAt: number; volumeAt: number; difficultyAt: number; cpcAt: number } | null {
  if (rows.length < 2) return null;
  const columns = Array.from({ length: width }, (_, at) =>
    rows.map((row) => (row[at] ?? "").trim()).filter(Boolean)
  );
  const share = (cells: string[], test: (cell: string) => boolean) =>
    cells.length === 0 ? 0 : cells.filter(test).length / cells.length;

  const phraseColumns = columns.flatMap((cells, at) =>
    share(cells, isPhrase) >= MOST && share(cells, (cell) => words(cell).length >= 2) >= 0.5 ? [at] : []
  );
  if (phraseColumns.length !== 1) return null;

  const numbers = columns.flatMap((cells, at) => {
    if (share(cells, (cell) => toNumber(cell) !== null) < MOST) return [];
    return [{ at, values: cells.map(toNumber).filter((value): value is number => value !== null) }];
  });
  const cpc = numbers.find((column) => column.values.some((value) => !Number.isInteger(value)));
  const whole = numbers.filter((column) => column !== cpc);
  const difficulty = whole.slice(1).find((column) => column.values.every((value) => value >= 0 && value <= 100));

  return {
    keywordAt: phraseColumns[0],
    volumeAt: whole[0]?.at ?? -1,
    difficultyAt: difficulty?.at ?? -1,
    cpcAt: cpc?.at ?? -1,
  };
}

/**
 * Parse a pasted export.
 *
 * A file with no recognisable keyword column is refused rather than guessed
 * at — importing the wrong column silently would put invented phrases into
 * a client's campaign.
 */
export function parseKeywordExport(text: string): ImportResult | { error: string } {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { error: "nothing pasted" };
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitRow(lines[0], delimiter);

  const find = (pattern: RegExp) => header.findIndex((h) => pattern.test(h.trim()));
  let keywordAt = find(KEYWORD_NAMES);
  let inferred: ReturnType<typeof columnsByContent> = null;

  // Keyword Surfer is copied out of a sidebar, not exported, so the paste
  // is usually just "phrase<tab>volume" with no header at all. A first row
  // whose second field is a number is data, not a heading.
  if (keywordAt < 0) {
    const looksHeaderless =
      header.length >= 1 &&
      header[0].trim().length > 0 &&
      !VOLUME_NAMES.test(header[0].trim()) &&
      (header.length === 1 || toNumber(header[1] ?? "") != null);
    if (looksHeaderless) {
      return parseHeaderless(lines, delimiter);
    }
    inferred = columnsByContent(lines.slice(1).map((line) => splitRow(line, delimiter)), header.length);
    if (inferred) keywordAt = inferred.keywordAt;
  }
  if (keywordAt < 0) {
    return {
      error: `no keyword column found. Columns seen: ${header.filter(Boolean).join(", ")}`,
    };
  }
  if (lines.length < 2) {
    return { error: "the paste has a header row but no keywords under it" };
  }
  const volumeAt = inferred?.volumeAt ?? find(VOLUME_NAMES);
  const difficultyAt = inferred?.difficultyAt ?? find(DIFFICULTY_NAMES);
  const cpcAt = inferred?.cpcAt ?? find(CPC_NAMES);

  const seen = new Set<string>();
  const keywords: ImportedKeyword[] = [];
  let skipped = 0;

  for (const line of lines.slice(1)) {
    const row = splitRow(line, delimiter);
    const keyword = (row[keywordAt] ?? "").trim().toLowerCase();
    if (!keyword || seen.has(keyword)) {
      skipped++;
      continue;
    }
    seen.add(keyword);
    keywords.push({
      keyword,
      volume: volumeAt >= 0 ? toNumber(row[volumeAt] ?? "") : null,
      difficulty: difficultyAt >= 0 ? toNumber(row[difficultyAt] ?? "") : null,
      cpc: cpcAt >= 0 ? toNumber(row[cpcAt] ?? "") : null,
    });
  }

  return {
    keywords,
    columns: {
      keyword: header[keywordAt],
      volume: volumeAt >= 0 ? header[volumeAt] : undefined,
      difficulty: difficultyAt >= 0 ? header[difficultyAt] : undefined,
      cpc: cpcAt >= 0 ? header[cpcAt] : undefined,
    },
    skipped,
  };
}

/**
 * A paste with no header: phrase first, volume second if present.
 */
function parseHeaderless(lines: string[], delimiter: string): ImportResult {
  const seen = new Set<string>();
  const keywords: ImportedKeyword[] = [];
  let skipped = 0;
  for (const line of lines) {
    const row = splitRow(line, delimiter);
    const keyword = (row[0] ?? "").trim().toLowerCase();
    if (!keyword || seen.has(keyword)) {
      skipped++;
      continue;
    }
    seen.add(keyword);
    keywords.push({
      keyword,
      volume: row.length > 1 ? toNumber(row[1]) : null,
      difficulty: row.length > 2 ? toNumber(row[2]) : null,
      cpc: null,
    });
  }
  return { keywords, columns: { keyword: "(no header)", volume: "(second column)" }, skipped };
}

/**
 * The cut, applied to a measured list.
 *
 *   - No volume and no business reason: gone.
 *   - Difficulty far above what a weak site can reach: gone, with the advice
 *     to follow instead — go longer, add the city, narrow the service.
 *   - Five to fifteen core phrases for the campaign, not two hundred rows
 *     out of the tool.
 */
export const CAMPAIGN_CORE_MIN = 5;
export const CAMPAIGN_CORE_MAX = 15;

export interface ShortlistInput {
  keywords: ImportedKeyword[];
  /** Phrases the business itself named, which survive a zero volume. */
  businessSeeds: string[];
  weakClient: boolean;
  /** Pages that exist on the client's site and could receive a link. */
  landingPages?: string[];
  /**
   * Which phrase has been given a page, by phrase. The rule is absolute — no
   * page, no place in the link campaign — so until this is filled in, a phrase
   * is a candidate and not yet a campaign keyword. "build a page" counts: a
   * decided page is a page.
   */
  pageFor?: Record<string, string>;
}

export interface Shortlisted extends ImportedKeyword {
  keep: boolean;
  reason: string;
  intent: Intent;
}

export function shortlist(input: ShortlistInput): Shortlisted[] {
  const seeds = new Set(input.businessSeeds.map((s) => s.trim().toLowerCase()));
  // A weak site is not going to reach page one of a hard phrase, whatever
  // the volume says about how much it would be worth.
  const difficultyCap = input.weakClient ? 35 : 70;

  const hasLandingPage = (input.landingPages ?? []).length > 0;

  const judged: Shortlisted[] = input.keywords.map((row) => {
    const intent = classifyIntent(row.keyword, input.businessSeeds);
    const k = { ...row, intent };
    const named = seeds.has(k.keyword);
    if ((k.volume ?? 0) <= 0 && !named) {
      return { ...k, keep: false, reason: "no volume and no business demand" };
    }
    // The rule a big volume tempts you to break: a broad
    // informational phrase with nothing to convert on is traffic, not a
    // campaign. High volume makes that worse, not better.
    if (intent === "informational" && !hasLandingPage) {
      return { ...k, keep: false, reason: "broad informational phrase with no page that converts; do not build links to it" };
    }
    if (k.difficulty != null && k.difficulty > difficultyCap) {
      return {
        ...k,
        keep: false,
        reason: input.weakClient
          ? "too competitive for this site; go for a longer phrase or add a city"
          : "very high competition",
      };
    }
    // Step 6. A phrase with no decided page is held back, not thrown away:
    // the operator's next move is to give it one.
    if (input.pageFor && !input.pageFor[k.keyword]?.trim()) {
      return { ...k, keep: false, reason: "no target page chosen yet" };
    }
    return { ...k, keep: true, reason: "" };
  });

  // Commercial and local first, and only then by
  // how much demand each carries.
  const rank = (intent: Intent) =>
    intent === "commercial" ? 0 : intent === "local" ? 0 : intent === "brand" ? 1 : 2;
  const kept = judged
    .filter((k) => k.keep)
    .sort((a, b) => {
      const ra = rank(a.intent);
      const rb = rank(b.intent);
      if (ra !== rb) return ra - rb;
      const va = a.volume ?? 0;
      const vb = b.volume ?? 0;
      if (va !== vb) return vb - va;
      return (a.difficulty ?? 100) - (b.difficulty ?? 100);
    });

  const core = new Set(kept.slice(0, CAMPAIGN_CORE_MAX).map((k) => k.keyword));
  const overflow = kept
    .slice(CAMPAIGN_CORE_MAX)
    .map((k) => ({ ...k, keep: false, reason: "beyond the campaign core" }));

  // Returned in the order it should be worked, not in the order the export
  // happened to be in: the campaign's core first, ranked, then everything
  // that did not make it with the reason attached.
  return [
    ...kept.filter((k) => core.has(k.keyword)),
    ...overflow,
    ...judged.filter((k) => !k.keep),
  ];
}
