import { describe, it, expect } from "vitest";

import {
  encodeCursor,
  decodeCursor,
  decodeCursorForTenant,
  isAfter,
  cursorAfter,
  type Keyset,
} from "./site-cursor.js";

const TENANT_A = "t_acme";
const TENANT_B = "t_globex";

const keyset: Keyset = { tenantId: TENANT_A, updatedAtMs: 1_800_000_000_000, id: "row-42" };

describe("cursor round-trip", () => {
  it("round-trips a keyset", () => {
    expect(decodeCursor(encodeCursor(keyset))).toEqual(keyset);
  });

  it("is url-safe, so it survives a query string untouched", () => {
    const cursor = encodeCursor({ ...keyset, id: "a/b+c=d" });
    expect(cursor).not.toMatch(/[+/=]/);
    expect(new URLSearchParams({ cursor }).get("cursor")).toBe(cursor);
  });

  it("returns null for garbage rather than throwing inside a request handler", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor(Buffer.from('{"a":1}').toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe("decodeCursorForTenant", () => {
  it("accepts a missing cursor as the start of the sequence", () => {
    expect(decodeCursorForTenant(undefined, TENANT_A)).toEqual({ ok: true, keyset: null });
    expect(decodeCursorForTenant("", TENANT_A)).toEqual({ ok: true, keyset: null });
  });

  it("accepts a cursor minted for the same tenant", () => {
    const result = decodeCursorForTenant(encodeCursor(keyset), TENANT_A);
    expect(result).toEqual({ ok: true, keyset });
  });

  // The opaque-cursor hole: the caller presents tenant A's key and replays a
  // cursor minted while paging tenant B. Without the tenant inside the signed
  // material there is nothing to check and the page reads across the boundary.
  it("refuses a cursor minted for another tenant", () => {
    const stolen = encodeCursor({ ...keyset, tenantId: TENANT_B });
    expect(decodeCursorForTenant(stolen, TENANT_A)).toEqual({ ok: false, reason: "wrong_tenant" });
  });

  it("refuses a malformed cursor instead of silently starting from the beginning", () => {
    expect(decodeCursorForTenant("!!!", TENANT_A)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("keyset ordering", () => {
  // A naive `updatedAt >` loses every row that shares a timestamp with the last
  // row of the previous page; `>=` returns that row on every page forever.
  it("orders by id when timestamps are identical", () => {
    const cursorRow = { updatedAtMs: 1000, id: "b" };
    const ks: Keyset = { tenantId: TENANT_A, ...cursorRow };
    expect(isAfter(ks, { updatedAtMs: 1000, id: "c" })).toBe(true);
    expect(isAfter(ks, { updatedAtMs: 1000, id: "b" })).toBe(false);
    expect(isAfter(ks, { updatedAtMs: 1000, id: "a" })).toBe(false);
  });

  it("orders by timestamp first", () => {
    const ks: Keyset = { tenantId: TENANT_A, updatedAtMs: 1000, id: "z" };
    expect(isAfter(ks, { updatedAtMs: 1001, id: "a" })).toBe(true);
    expect(isAfter(ks, { updatedAtMs: 999, id: "z" })).toBe(false);
  });

  it("pages a run of identical timestamps exactly once each", () => {
    const rows = [
      { updatedAtMs: 1000, id: "a" },
      { updatedAtMs: 1000, id: "b" },
      { updatedAtMs: 1000, id: "c" },
      { updatedAtMs: 1000, id: "d" },
    ];
    const pageSize = 2;
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 10; guard++) {
      const decoded = decodeCursorForTenant(cursor, TENANT_A);
      expect(decoded.ok).toBe(true);
      const from = decoded.ok && decoded.keyset ? decoded.keyset : null;
      const remaining = rows.filter(row => (from ? isAfter(from, row) : true));
      const page = remaining.slice(0, pageSize);
      seen.push(...page.map(row => row.id));
      cursor = cursorAfter(TENANT_A, page, remaining.length > pageSize);
      if (!cursor) break;
    }

    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("cursorAfter", () => {
  it("returns null on the last page, so the client stops", () => {
    expect(cursorAfter(TENANT_A, [{ updatedAtMs: 1, id: "a" }], false)).toBeNull();
    expect(cursorAfter(TENANT_A, [], true)).toBeNull();
  });

  it("stamps the requesting tenant into every cursor it mints", () => {
    const cursor = cursorAfter(TENANT_A, [{ updatedAtMs: 1, id: "a" }], true)!;
    expect(decodeCursor(cursor)!.tenantId).toBe(TENANT_A);
  });
});
