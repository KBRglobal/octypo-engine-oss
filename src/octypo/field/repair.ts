/**
 * Self-healing for field material.
 *
 * The publish gate only accepts WebP, and the first photos through the desk
 * were stored as the phone sent them. Rather than a one-off script that needs
 * a shell inside the container, the engine checks its own field notes at boot:
 * any photo that is not WebP is converted and re-uploaded, and the article
 * written from it (never published, since the gate refused it) is dropped so
 * the library writes it again with images the gate accepts. Idempotent: a
 * note whose media is already WebP is not touched.
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db.js";
import { articles, contents, fieldNotes, libraryItems } from "../../schema/index.js";
import { logger } from "../../lib/logger.js";
import { createR2Uploader, r2ConfigFromEnv } from "../../images/r2-upload.js";
import { toWebp } from "../../images/optimise.js";

export function needsConversion(url: string): boolean {
  try {
    return !new URL(url).pathname.toLowerCase().endsWith(".webp");
  } catch {
    return false;
  }
}

/** The bucket key a converted photo goes under: same place, WebP suffix, no stale hash. */
export function webpKeyFor(url: string): string {
  const path = new URL(url).pathname.replace(/^\//, "");
  return path.replace(/(?:-[a-f0-9]{10})?\.[a-z0-9]+$/i, ".webp");
}

export async function repairFieldMedia(): Promise<{ converted: number; requeued: number }> {
  const r2 = r2ConfigFromEnv();
  if (!r2) return { converted: 0, requeued: 0 };
  const upload = createR2Uploader(r2);
  const notes = await db.select({ id: fieldNotes.id, media: fieldNotes.media, documentId: fieldNotes.documentId }).from(fieldNotes);
  let converted = 0;
  let requeued = 0;
  for (const note of notes) {
    const media = Array.isArray(note.media) ? [...note.media] : [];
    if (!media.some(m => m && typeof m.url === "string" && needsConversion(m.url))) continue;
    let changed = false;
    for (const m of media) {
      if (!m || typeof m.url !== "string" || !needsConversion(m.url)) continue;
      try {
        const res = await fetch(m.url, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const webp = await toWebp(Buffer.from(await res.arrayBuffer()));
        m.url = await upload(webp.data, webpKeyFor(m.url), "image/webp");
        changed = true;
        converted += 1;
      } catch (error) {
        logger.warn({ noteId: note.id, error: error instanceof Error ? error.message : String(error) }, "[Field] Photo conversion failed (non-fatal)");
      }
    }
    if (!changed) continue;
    await db.update(fieldNotes).set({ media, updatedAt: new Date() }).where(eq(fieldNotes.id, note.id));
    if (!note.documentId) continue;
    // The article written from the old photos can never publish. Drop it and
    // let the library write the note again with the WebP set.
    const items = await db
      .select({ id: libraryItems.id, status: libraryItems.status, contentId: libraryItems.contentId })
      .from(libraryItems)
      .where(eq(libraryItems.documentId, note.documentId));
    for (const item of items) {
      if (item.status === "published") continue;
      if (item.contentId) {
        const [row] = await db.select({ status: contents.status }).from(contents).where(eq(contents.id, item.contentId));
        if (row && row.status !== "published") {
          await db.delete(articles).where(eq(articles.contentId, item.contentId));
          await db.delete(contents).where(eq(contents.id, item.contentId));
        }
      }
      await db
        .update(libraryItems)
        .set({ status: "idea", contentId: null, updatedAt: new Date() })
        .where(inArray(libraryItems.id, [item.id]));
      requeued += 1;
    }
  }
  if (converted || requeued) logger.info({ converted, requeued }, "[Field] Repaired field media");
  return { converted, requeued };
}
