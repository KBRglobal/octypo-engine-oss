/**
 * Purge webhook receiver — the blog half of `src/lib/site-webhook.ts`.
 *
 * Implemented on Web Crypto rather than node:crypto because this runs inside a
 * Cloudflare Worker. `purge.test.ts` verifies signatures produced by the
 * engine's node:crypto signer, so the two halves cannot drift.
 *
 * An unverified purge endpoint is a free cache-flush denial of service: anyone
 * who can POST to it forces every article to re-render from the engine.
 */

export const SIGNATURE_HEADER = 'x-octypo-signature';
export const REPLAY_TOLERANCE_SECONDS = 300;

export type PurgeEvent = 'published' | 'updated' | 'unpublished' | 'deleted';

export interface PurgePayload {
  tenantId: string;
  event: PurgeEvent;
  slug: string;
  updatedAt: string;
}

const encoder = new TextEncoder();

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && /^\d+$/.test(value ?? '')) t = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]+$/i.test(value)) v1 = value.toLowerCase();
  }
  return t !== null && v1 !== null ? { t, v1 } : null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Length-independent, timing-safe hex comparison. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPurgeSignature(
  body: string,
  header: string | null | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (!header || !secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.t) > REPLAY_TOLERANCE_SECONDS) return false;

  const expected = await hmacHex(secret, `${parsed.t}.${body}`);
  return constantTimeEquals(expected, parsed.v1);
}

export function parsePurgePayload(body: string): PurgePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;
  const events: PurgeEvent[] = ['published', 'updated', 'unpublished', 'deleted'];
  if (
    typeof candidate.tenantId !== 'string' ||
    typeof candidate.slug !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !events.includes(candidate.event as PurgeEvent)
  ) {
    return null;
  }
  return {
    tenantId: candidate.tenantId,
    event: candidate.event as PurgeEvent,
    slug: candidate.slug,
    updatedAt: candidate.updatedAt,
  };
}

/**
 * The tags a single event must drop. Every publish also invalidates listings,
 * the sitemap and the feed — otherwise a new article is live at its own URL but
 * invisible from the index for up to the listing TTL.
 */
export function purgeTagsFor(payload: PurgePayload, tenantSlug: string): string[] {
  return [`article:${tenantSlug}:${payload.slug}`, `listing:${tenantSlug}`];
}
