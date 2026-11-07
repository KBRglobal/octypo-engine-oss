/**
 * Site-key authentication for the public `/api/site/*` surface.
 *
 * A site key is the credential a customer's blog presents. It is read-only,
 * published-only and scoped to exactly one tenant. The tenant is never named in
 * a URL — a numeric or slug tenant id in a path is enumerable, and enumerating
 * it is the whole attack.
 *
 * Only the SHA-256 of a key is stored, so a database dump does not hand over
 * every customer's blog. That also means the plaintext is shown exactly once,
 * at creation, and cannot be recovered.
 *
 * The tenant lookup is injected rather than imported. That keeps this file
 * testable without a database, and — more usefully — keeps the tenant table
 * schema owned by the multi-tenant track instead of duplicated here.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { logger } from "../lib/logger.js";

export const SITE_KEY_PREFIX = "octy_site_";

export interface SiteKeyRecord {
  tenantId: string;
  tenantSlug: string;
  revokedAt: Date | null;
}

/** Resolve a key hash to its tenant. Returns null when there is no such key. */
export type SiteKeyLookup = (keyHash: string) => Promise<SiteKeyRecord | null>;

export interface SiteRequest extends Request {
  tenantId?: string;
  tenantSlug?: string;
}

/** Mint a new key. The plaintext is returned once and never stored. */
export function generateSiteKey(): { key: string; keyHash: string } {
  const key = `${SITE_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, keyHash: hashSiteKey(key) };
}

export function hashSiteKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Extract a well-formed site key from an Authorization header, or null. */
export function parseSiteKey(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  if (!match) return null;
  const key = match[1];
  if (!key.startsWith(SITE_KEY_PREFIX)) return null;
  // Reject a key that is only a prefix: it would hash to a stable value and
  // burn a lookup on every request.
  if (key.length <= SITE_KEY_PREFIX.length + 8) return null;
  return key;
}

/** Constant-time hex comparison, mirroring the admin token check in auth.ts:28-33. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Never log the key itself. Enough to correlate a support ticket, useless to
 * anyone who reads the logs — the same reason the engine's admin token is never
 * echoed back.
 */
export function keyFingerprint(key: string): string {
  return hashSiteKey(key).slice(0, 12);
}

export function createRequireSiteKey(lookup: SiteKeyLookup) {
  return async function requireSiteKey(
    req: SiteRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const key = parseSiteKey(req.headers.authorization);
    if (!key) {
      res.status(401).json({ error: "Missing or malformed site key" });
      return;
    }

    let record: SiteKeyRecord | null;
    try {
      record = await lookup(hashSiteKey(key));
    } catch (error) {
      logger.error({ error, key: keyFingerprint(key) }, "[SiteAuth] Site key lookup failed");
      res.status(503).json({ error: "Site key lookup unavailable" });
      return;
    }

    // A revoked key and an unknown key must be indistinguishable from outside,
    // or revocation becomes an oracle for which keys ever existed.
    if (!record || record.revokedAt !== null) {
      logger.warn({ key: keyFingerprint(key), ip: req.ip }, "[SiteAuth] Rejected site key");
      res.status(401).json({ error: "Invalid site key" });
      return;
    }

    req.tenantId = record.tenantId;
    req.tenantSlug = record.tenantSlug;
    next();
  };
}
