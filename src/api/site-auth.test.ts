import { describe, it, expect, vi } from "vitest";
import type { Response, NextFunction } from "express";

import {
  generateSiteKey,
  hashSiteKey,
  parseSiteKey,
  keyFingerprint,
  createRequireSiteKey,
  SITE_KEY_PREFIX,
  type SiteKeyRecord,
  type SiteRequest,
} from "./site-auth.js";

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const ACME: SiteKeyRecord = { tenantId: "t_acme", tenantSlug: "acme", revokedAt: null };

describe("site key minting", () => {
  it("mints a prefixed, url-safe key and returns only its hash for storage", () => {
    const { key, keyHash } = generateSiteKey();
    expect(key.startsWith(SITE_KEY_PREFIX)).toBe(true);
    expect(key).not.toMatch(/[+/=]/);
    expect(keyHash).toBe(hashSiteKey(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never mints the same key twice", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateSiteKey().key));
    expect(keys.size).toBe(200);
  });

  // A database dump must not hand over every customer's blog credential.
  it("cannot recover the key from the stored hash", () => {
    const { key, keyHash } = generateSiteKey();
    expect(keyHash).not.toContain(key.slice(SITE_KEY_PREFIX.length));
  });

  it("fingerprints a key for logs without revealing it", () => {
    const { key } = generateSiteKey();
    const fingerprint = keyFingerprint(key);
    expect(fingerprint).toHaveLength(12);
    expect(key).not.toContain(fingerprint);
  });
});

describe("parseSiteKey", () => {
  it("accepts a well-formed bearer key", () => {
    const { key } = generateSiteKey();
    expect(parseSiteKey(`Bearer ${key}`)).toBe(key);
  });

  it("rejects a missing header, the wrong scheme and a wrong prefix", () => {
    expect(parseSiteKey(undefined)).toBeNull();
    expect(parseSiteKey("")).toBeNull();
    expect(parseSiteKey("Basic abc")).toBeNull();
    expect(parseSiteKey("Bearer sk_live_something_long_enough")).toBeNull();
  });

  it("rejects a bare prefix, which would burn a lookup on a known hash", () => {
    expect(parseSiteKey(`Bearer ${SITE_KEY_PREFIX}`)).toBeNull();
    expect(parseSiteKey(`Bearer ${SITE_KEY_PREFIX}short`)).toBeNull();
  });

  it("rejects an admin token presented at the site endpoint", () => {
    expect(parseSiteKey(`Bearer ${"a".repeat(64)}`)).toBeNull();
  });
});

describe("requireSiteKey", () => {
  async function run(header: string | undefined, lookup: (h: string) => Promise<SiteKeyRecord | null>) {
    const req = { headers: header ? { authorization: header } : {} } as SiteRequest;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    await createRequireSiteKey(lookup)(req, res, next);
    return { req, res, next: next as unknown as ReturnType<typeof vi.fn> };
  }

  it("attaches the tenant to the request and calls next", async () => {
    const { key } = generateSiteKey();
    const { req, next } = await run(`Bearer ${key}`, async () => ACME);
    expect(next).toHaveBeenCalledOnce();
    expect(req.tenantId).toBe("t_acme");
    expect(req.tenantSlug).toBe("acme");
  });

  it("looks the key up by hash, never by plaintext", async () => {
    const { key } = generateSiteKey();
    const lookup = vi.fn(async (_keyHash: string) => ACME);
    await run(`Bearer ${key}`, lookup);
    expect(lookup).toHaveBeenCalledWith(hashSiteKey(key));
    expect(lookup.mock.calls[0]?.[0]).not.toContain(key);
  });

  it("401s with no key at all", async () => {
    const { res, next } = await run(undefined, async () => ACME);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on an unknown key", async () => {
    const { key } = generateSiteKey();
    const { res, next } = await run(`Bearer ${key}`, async () => null);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  // Revocation has to actually revoke: a cancelled customer whose key still
  // works is a paying-tier bypass as well as a data-retention problem.
  it("401s on a revoked key", async () => {
    const { key } = generateSiteKey();
    const { res, next } = await run(`Bearer ${key}`, async () => ({
      ...ACME,
      revokedAt: new Date("2026-01-01"),
    }));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("makes a revoked key indistinguishable from an unknown one", async () => {
    const { key } = generateSiteKey();
    const revoked = await run(`Bearer ${key}`, async () => ({ ...ACME, revokedAt: new Date() }));
    const unknown = await run(`Bearer ${key}`, async () => null);
    expect(revoked.res.statusCode).toBe(unknown.res.statusCode);
    expect(revoked.res.body).toEqual(unknown.res.body);
  });

  it("503s rather than 401s when the lookup itself fails, so an outage is not read as a bad key", async () => {
    const { key } = generateSiteKey();
    const { res, next } = await run(`Bearer ${key}`, async () => {
      throw new Error("db down");
    });
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("never echoes the key back in an error body", async () => {
    const { key } = generateSiteKey();
    const { res } = await run(`Bearer ${key}`, async () => null);
    expect(JSON.stringify(res.body)).not.toContain(key);
  });

  it("does not let tenant state leak between two requests on one middleware instance", async () => {
    const middleware = createRequireSiteKey(async keyHash =>
      keyHash === hashSiteKey(keyA) ? ACME : { tenantId: "t_globex", tenantSlug: "globex", revokedAt: null }
    );
    const { key: keyA } = generateSiteKey();
    const { key: keyB } = generateSiteKey();

    const reqA = { headers: { authorization: `Bearer ${keyA}` } } as SiteRequest;
    const reqB = { headers: { authorization: `Bearer ${keyB}` } } as SiteRequest;
    await middleware(reqA, mockRes(), vi.fn() as unknown as NextFunction);
    await middleware(reqB, mockRes(), vi.fn() as unknown as NextFunction);

    expect(reqA.tenantId).toBe("t_acme");
    expect(reqB.tenantId).toBe("t_globex");
  });
});
