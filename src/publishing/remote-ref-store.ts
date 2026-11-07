/**
 * Where an article lives on each target.
 *
 * This is the whole of idempotency. Without a stored remote id, every retry of
 * a publish job creates a *second* post on the customer's live site — the job
 * queue retries three times, so one flaky network moment becomes three copies of
 * the same article in front of their readers. That is the most visible way this
 * system can fail, so the reference is written before it is needed and read
 * before anything else happens.
 *
 * Two implementations:
 *  - `InMemoryRemoteRefStore` — tests, and single-process dry runs.
 *  - `PostgresRemoteRefStore` — production. It self-provisions its table with
 *    idempotent DDL because the shared schema file (src/schema/index.ts) is
 *    owned elsewhere; the `publishingTargetRefs` definition below is exported so
 *    it can be folded into the schema barrel and a real migration later without
 *    changing a single caller.
 *
 * Note what the store is NOT: it is a cache, not the truth. Every adapter must
 * still cope with a reference that points at something the customer deleted, and
 * with having no reference at all for an article that is in fact already there.
 */

import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";

import type { RemoteRef } from "./types.js";

export interface RemoteRefStore {
  get(targetId: string, articleId: string): Promise<RemoteRef | null>;
  put(ref: RemoteRef): Promise<void>;
  forget(targetId: string, articleId: string): Promise<void>;
}

// ============================================================================
// TABLE
// ============================================================================

export const publishingTargetRefs = pgTable(
  "publishing_target_refs",
  {
    targetId: varchar("target_id").notNull(),
    articleId: varchar("article_id").notNull(),
    // Nullable: after a media upload succeeds but the post write fails we keep
    // the row so the retry reuses the uploaded image instead of duplicating it.
    remoteId: text("remote_id"),
    remoteUrl: text("remote_url"),
    mediaId: text("media_id"),
    contentHash: text("content_hash"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  table => [primaryKey({ columns: [table.targetId, table.articleId] })]
);

/** Idempotent DDL, safe to run on every boot and from every replica. */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS publishing_target_refs (
  target_id varchar NOT NULL,
  article_id varchar NOT NULL,
  remote_id text,
  remote_url text,
  media_id text,
  content_hash text,
  updated_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, article_id)
)`;

// ============================================================================
// IN MEMORY
// ============================================================================

export class InMemoryRemoteRefStore implements RemoteRefStore {
  private readonly rows = new Map<string, RemoteRef>();

  private key(targetId: string, articleId: string): string {
    // A target is scoped, not global: two targets hold two different remote ids
    // for the same article, and mixing them updates the wrong post.
    return `${targetId}\u0000${articleId}`;
  }

  async get(targetId: string, articleId: string): Promise<RemoteRef | null> {
    return this.rows.get(this.key(targetId, articleId)) ?? null;
  }

  async put(ref: RemoteRef): Promise<void> {
    this.rows.set(this.key(ref.targetId, ref.articleId), { ...ref });
  }

  async forget(targetId: string, articleId: string): Promise<void> {
    this.rows.delete(this.key(targetId, articleId));
  }
}

// ============================================================================
// POSTGRES
// ============================================================================

export class PostgresRemoteRefStore implements RemoteRefStore {
  private ready: Promise<void> | null = null;

  // `db` is imported lazily: src/db.ts throws at import time when DATABASE_URL
  // is unset, and the publishing layer must be importable (and testable)
  // without a database.
  private async client() {
    const { db } = await import("../db.js");
    if (!this.ready) {
      this.ready = db
        .execute(sql.raw(CREATE_TABLE_SQL))
        .then(() => undefined)
        .catch(error => {
          // Reset so a transient failure does not poison the process forever.
          this.ready = null;
          throw error;
        });
    }
    await this.ready;
    return db;
  }

  async get(targetId: string, articleId: string): Promise<RemoteRef | null> {
    const db = await this.client();
    const [row] = await db
      .select()
      .from(publishingTargetRefs)
      .where(
        and(
          eq(publishingTargetRefs.targetId, targetId),
          eq(publishingTargetRefs.articleId, articleId)
        )
      )
      .limit(1);
    return row ? { ...row } : null;
  }

  async put(ref: RemoteRef): Promise<void> {
    const db = await this.client();
    await db
      .insert(publishingTargetRefs)
      .values(ref)
      .onConflictDoUpdate({
        target: [publishingTargetRefs.targetId, publishingTargetRefs.articleId],
        set: {
          remoteId: ref.remoteId,
          remoteUrl: ref.remoteUrl,
          mediaId: ref.mediaId,
          contentHash: ref.contentHash,
          updatedAt: ref.updatedAt,
        },
      });
  }

  async forget(targetId: string, articleId: string): Promise<void> {
    const db = await this.client();
    await db
      .delete(publishingTargetRefs)
      .where(
        and(
          eq(publishingTargetRefs.targetId, targetId),
          eq(publishingTargetRefs.articleId, articleId)
        )
      );
  }
}
