/**
 * Keyset cursors for the public `/api/site/articles` sync.
 *
 * Two things make this worth its own file.
 *
 * Correctness: a Scale tenant publishes 300 articles a month and the pipeline
 * publishes in batches, so identical `updatedAt` values across a page boundary
 * are routine, not exotic. Paging on `updatedAt >` drops every row that shares
 * a timestamp with the last row of the previous page; paging on `>=` returns
 * the same row forever. The key has to be the pair `(updatedAt, id)`.
 *
 * Isolation: the cursor is opaque, so it is tempting to treat it as trusted
 * state. It is not — it comes back from the client. A cursor minted for tenant
 * B and replayed with tenant A's key is a cross-tenant read unless the tenant
 * is inside the cursor and checked on the way in. That is the hole this file
 * exists to close.
 */

export interface Keyset {
  tenantId: string;
  updatedAtMs: number;
  id: string;
}

export function encodeCursor(keyset: Keyset): string {
  const payload = JSON.stringify([keyset.tenantId, keyset.updatedAtMs, keyset.id]);
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): Keyset | null {
  if (typeof cursor !== "string" || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [tenantId, updatedAtMs, id] = parsed;
  if (typeof tenantId !== "string" || !tenantId) return null;
  if (typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs)) return null;
  if (typeof id !== "string" || !id) return null;
  return { tenantId, updatedAtMs, id };
}

export type CursorResult =
  | { ok: true; keyset: Keyset | null }
  | { ok: false; reason: "malformed" | "wrong_tenant" };

/**
 * Decode a client-supplied cursor and refuse it unless it was minted for the
 * tenant making the request.
 */
export function decodeCursorForTenant(cursor: string | undefined | null, tenantId: string): CursorResult {
  if (cursor === undefined || cursor === null || cursor === "") return { ok: true, keyset: null };
  const keyset = decodeCursor(cursor);
  if (!keyset) return { ok: false, reason: "malformed" };
  if (keyset.tenantId !== tenantId) return { ok: false, reason: "wrong_tenant" };
  return { ok: true, keyset };
}

/** True when `row` sorts strictly after the cursor position under `(updatedAt, id)` ascending. */
export function isAfter(keyset: Keyset, row: { updatedAtMs: number; id: string }): boolean {
  if (row.updatedAtMs !== keyset.updatedAtMs) return row.updatedAtMs > keyset.updatedAtMs;
  return row.id > keyset.id;
}

/** The cursor to hand back after emitting `rows`, or null when the page was the last one. */
export function cursorAfter(
  tenantId: string,
  rows: Array<{ updatedAtMs: number; id: string }>,
  hasMore: boolean
): string | null {
  if (!hasMore || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return encodeCursor({ tenantId, updatedAtMs: last.updatedAtMs, id: last.id });
}
