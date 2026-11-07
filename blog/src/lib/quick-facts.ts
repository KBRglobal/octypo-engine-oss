/**
 * `quickFacts` is the field that most separates an Octypo article from a
 * generic AI blog post (src/schema/index.ts:38-46: difficulty, timeNeeded,
 * tools, riskLevel, whenToDo, bestFor, checklist), so it gets rendered rather
 * than dropped. Every field is optional and most articles fill only a few, so
 * the projection is "whatever is actually there, in a fixed reading order".
 *
 * The presentation is deliberately the plainest of the three options in the
 * design (spec table rather than sidebar card or inline callout) — that choice
 * is still open, and keeping the data projection separate from the markup means
 * changing it later is a template edit, not a rewrite.
 */

export interface QuickFactsShape {
  difficulty?: string | null;
  timeNeeded?: string | null;
  tools?: string[] | null;
  riskLevel?: string | null;
  whenToDo?: string | null;
  bestFor?: string[] | null;
  checklist?: string[] | null;
  [key: string]: unknown;
}

export interface QuickFactRow {
  label: string;
  value: string;
}

const ORDER: Array<[keyof QuickFactsShape, string]> = [
  ['difficulty', 'Difficulty'],
  ['timeNeeded', 'Time needed'],
  ['riskLevel', 'Risk'],
  ['whenToDo', 'When to do it'],
  ['tools', 'Tools'],
  ['bestFor', 'Best for'],
];

function toDisplay(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .join(', ');
  }
  return '';
}

export function quickFactRows(facts: QuickFactsShape | null | undefined): QuickFactRow[] {
  if (!facts || typeof facts !== 'object') return [];
  const rows: QuickFactRow[] = [];
  for (const [field, label] of ORDER) {
    const value = toDisplay(facts[field]);
    if (value) rows.push({ label, value });
  }
  return rows;
}

export function checklistItems(facts: QuickFactsShape | null | undefined): string[] {
  if (!facts || !Array.isArray(facts.checklist)) return [];
  return facts.checklist.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}
