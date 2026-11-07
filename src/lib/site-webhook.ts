/**
 * Signed publish webhooks — the low-latency half of blog freshness.
 *
 * When an article publishes the engine POSTs a small event to the tenant's blog
 * so it can purge that one cache tag. The webhook is best-effort by design: the
 * blog also reconciles on a cron, so a dropped delivery costs minutes, never
 * correctness. That is why nothing here is allowed to block or fail a publish.
 *
 * The signature is Stripe-shaped — `t=<unix>,v1=<hmac(t.body)>` — because the
 * timestamp is inside the signed material. Signing the body alone would let a
 * captured request be replayed forever, and the purge endpoint is a free
 * cache-flush DoS if anyone can hit it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-octypo-signature";

/** Requests older than this are refused even with a valid signature. */
export const REPLAY_TOLERANCE_SECONDS = 300;

export type PurgeEvent = "published" | "updated" | "unpublished" | "deleted";

export interface PurgePayload {
  tenantId: string;
  event: PurgeEvent;
  slug: string;
  updatedAt: string;
}

/** Canonical JSON — key order is part of the signed material, so it is fixed here. */
export function serialisePurgePayload(payload: PurgePayload): string {
  return JSON.stringify({
    tenantId: payload.tenantId,
    event: payload.event,
    slug: payload.slug,
    updatedAt: payload.updatedAt,
  });
}

export function signPurgePayload(body: string, secret: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = header.split(",").map(p => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && /^\d+$/.test(value ?? "")) t = Number(value);
    if (key === "v1" && /^[0-9a-f]+$/i.test(value ?? "")) v1 = value.toLowerCase();
  }
  return t !== null && v1 !== null ? { t, v1 } : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyPurgeSignature(
  body: string,
  header: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!header || !secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.t) > REPLAY_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${parsed.t}.${body}`).digest("hex");
  return constantTimeEquals(expected, parsed.v1);
}
