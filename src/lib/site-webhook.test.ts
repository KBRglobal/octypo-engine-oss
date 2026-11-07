import { describe, it, expect } from "vitest";

import {
  serialisePurgePayload,
  signPurgePayload,
  verifyPurgeSignature,
  parseSignatureHeader,
  REPLAY_TOLERANCE_SECONDS,
} from "./site-webhook.js";

const SECRET = "s3cret-purge-key";
const NOW = 1_800_000_000;

const payload = {
  tenantId: "t_acme",
  event: "published" as const,
  slug: "deposit-rules",
  updatedAt: "2026-08-19T09:00:00.000Z",
};

describe("purge webhook signing", () => {
  it("round-trips a valid signature", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    expect(verifyPurgeSignature(body, header, SECRET, NOW)).toBe(true);
  });

  it("serialises deterministically regardless of key order", () => {
    const a = serialisePurgePayload(payload);
    const b = serialisePurgePayload({
      updatedAt: payload.updatedAt,
      slug: payload.slug,
      event: payload.event,
      tenantId: payload.tenantId,
    });
    expect(a).toBe(b);
  });

  it("rejects a tampered body", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    const tampered = serialisePurgePayload({ ...payload, slug: "someone-elses-article" });
    expect(verifyPurgeSignature(tampered, header, SECRET, NOW)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    expect(verifyPurgeSignature(body, header, "other-secret", NOW)).toBe(false);
  });

  // An unauthenticated purge endpoint is a free cache-flush DoS: replay one
  // captured request in a loop and every article re-renders from the engine.
  it("rejects a replay outside the tolerance window", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    expect(verifyPurgeSignature(body, header, SECRET, NOW + REPLAY_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(verifyPurgeSignature(body, header, SECRET, NOW - REPLAY_TOLERANCE_SECONDS - 1)).toBe(false);
  });

  it("accepts a small amount of clock skew in both directions", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    expect(verifyPurgeSignature(body, header, SECRET, NOW + 30)).toBe(true);
    expect(verifyPurgeSignature(body, header, SECRET, NOW - 30)).toBe(true);
  });

  // The timestamp must be inside the signed material, or it can be edited to
  // slide any captured request back into the window.
  it("rejects a signature whose timestamp was edited after signing", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW - 10_000);
    const slid = header.replace(/^t=\d+/, `t=${NOW}`);
    expect(verifyPurgeSignature(body, slid, SECRET, NOW)).toBe(false);
  });

  it("rejects a missing, empty or malformed header", () => {
    const body = serialisePurgePayload(payload);
    expect(verifyPurgeSignature(body, undefined, SECRET, NOW)).toBe(false);
    expect(verifyPurgeSignature(body, "", SECRET, NOW)).toBe(false);
    expect(verifyPurgeSignature(body, "garbage", SECRET, NOW)).toBe(false);
    expect(verifyPurgeSignature(body, "t=abc,v1=zz", SECRET, NOW)).toBe(false);
  });

  it("rejects verification when no secret is configured, rather than allowing everything", () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    expect(verifyPurgeSignature(body, header, "", NOW)).toBe(false);
  });

  it("parses a well-formed header and refuses a partial one", () => {
    expect(parseSignatureHeader(`t=${NOW},v1=abcd`)).toEqual({ t: NOW, v1: "abcd" });
    expect(parseSignatureHeader(`t=${NOW}`)).toBeNull();
    expect(parseSignatureHeader("v1=abcd")).toBeNull();
  });
});
