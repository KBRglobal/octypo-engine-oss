/**
 * Knowledge-base digest.
 *
 * Assembles a compact markdown index of EVERYTHING the library knows about:
 * every mined article idea (title + angle + key points) across every uploaded
 * document, grouped by source document (category/filename). This digest is the
 * cross-document grounding source that "viral" synthesis listicles are mined
 * from and written against. Domain-neutral.
 */

import { eq, ne } from "drizzle-orm";

import { db } from "../../db.js";
import { documents, libraryItems } from "../../schema/index.js";

/** Sentinel filename for the synthetic "collection" document viral items hang on. */
export const VIRAL_SYNTH_FILENAME = "__viral_synthesis__";
/** Synthetic-document mime type — lets the pipeline recognise synthesis docs. */
export const VIRAL_SYNTH_MIME = "application/x-octypo-synthesis";

/** Hard cap on digest size so writer/idea prompts stay within model limits. */
const MAX_DIGEST_CHARS = 120_000;

interface DigestRow {
  documentId: string;
  filename: string;
  title: string;
  angle: string;
  keyPoints: string[] | null;
}

/** Render one idea as a compact markdown bullet. */
function renderItem(row: DigestRow): string {
  const points = (row.keyPoints || []).slice(0, 8).map(p => `    - ${p}`).join("\n");
  const angle = row.angle ? `\n  - _Angle:_ ${row.angle}` : "";
  return `- **${row.title}**${angle}${points ? `\n${points}` : ""}`;
}

/**
 * Build the whole-knowledge-base markdown digest.
 *
 * Includes every library item that carries real content (any status), grouped
 * by its source document. Excludes the synthetic synthesis document itself so a
 * digest never grounds on a previous digest. If the assembled markdown exceeds
 * the cap, items are sampled EVENLY across documents so every source category
 * stays represented rather than truncating whole documents off the tail.
 */
export async function buildKnowledgeDigest(): Promise<string> {
  // Pull all real ideas, excluding any hung off a synthesis document.
  const rows = await db
    .select({
      documentId: libraryItems.documentId,
      filename: documents.filename,
      mimeType: documents.mimeType,
      title: libraryItems.title,
      angle: libraryItems.angle,
      keyPoints: libraryItems.keyPoints,
    })
    .from(libraryItems)
    .innerJoin(documents, eq(libraryItems.documentId, documents.id))
    .where(ne(documents.mimeType, VIRAL_SYNTH_MIME));

  // Group by document.
  const byDoc = new Map<string, { filename: string; items: DigestRow[] }>();
  for (const r of rows) {
    if (!r.title || r.title.trim().length === 0) continue;
    const bucket = byDoc.get(r.documentId) ?? { filename: r.filename, items: [] };
    bucket.items.push({
      documentId: r.documentId,
      filename: r.filename,
      title: r.title,
      angle: r.angle,
      keyPoints: r.keyPoints,
    });
    byDoc.set(r.documentId, bucket);
  }

  const docs = [...byDoc.values()];
  if (docs.length === 0) return "";

  // First pass: render everything.
  const full = renderDigest(docs);
  if (full.length <= MAX_DIGEST_CHARS) return full;

  // Over budget: sample evenly across documents (round-robin) until near the cap.
  const sampled: { filename: string; items: DigestRow[] }[] = docs.map(d => ({
    filename: d.filename,
    items: [],
  }));
  const cursors = docs.map(() => 0);
  let approxChars = 0;
  let added = true;
  while (added && approxChars < MAX_DIGEST_CHARS) {
    added = false;
    for (let i = 0; i < docs.length; i++) {
      const src = docs[i];
      const c = cursors[i];
      if (c >= src.items.length) continue;
      const item = src.items[c];
      cursors[i] = c + 1;
      const rendered = renderItem(item);
      if (approxChars + rendered.length + src.filename.length + 8 > MAX_DIGEST_CHARS) {
        added = false;
        break;
      }
      sampled[i].items.push(item);
      approxChars += rendered.length + 1;
      added = true;
    }
  }

  return renderDigest(sampled.filter(d => d.items.length > 0));
}

function renderDigest(docs: { filename: string; items: DigestRow[] }[]): string {
  const parts: string[] = [
    "# Knowledge Base Digest",
    "",
    `This index summarises ${docs.reduce((n, d) => n + d.items.length, 0)} topics across ${docs.length} source document(s).`,
    "",
  ];
  for (const doc of docs) {
    if (doc.items.length === 0) continue;
    parts.push(`## Source: ${doc.filename}`);
    for (const item of doc.items) parts.push(renderItem(item));
    parts.push("");
  }
  return parts.join("\n").trim();
}
