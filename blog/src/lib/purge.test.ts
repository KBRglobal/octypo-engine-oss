import { describe, it, expect } from 'vitest';

import { signPurgePayload, serialisePurgePayload } from '../../../src/lib/site-webhook.js';
import { verifyPurgeSignature, parsePurgePayload, purgeTagsFor } from './purge';

const SECRET = 's3cret-purge-key';
const NOW = 1_800_000_000;
const payload = {
  tenantId: 't_acme',
  event: 'published' as const,
  slug: 'deposit-rules',
  updatedAt: '2026-08-19T09:00:00.000Z',
};

describe('blog purge verification', () => {
  // The engine signs with node:crypto, the Worker verifies with Web Crypto.
  // If these two ever disagree, every publish webhook silently 401s and the
  // only symptom is that new articles take five minutes instead of seconds.
  it('accepts a signature produced by the engine signer', async () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    await expect(verifyPurgeSignature(body, header, SECRET, NOW)).resolves.toBe(true);
  });

  it('rejects a tampered body', async () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    const other = serialisePurgePayload({ ...payload, slug: 'not-mine' });
    await expect(verifyPurgeSignature(other, header, SECRET, NOW)).resolves.toBe(false);
  });

  it('rejects a replayed request outside the tolerance window', async () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    await expect(verifyPurgeSignature(body, header, SECRET, NOW + 600)).resolves.toBe(false);
  });

  it('rejects when the receiver has no secret configured', async () => {
    const body = serialisePurgePayload(payload);
    const header = signPurgePayload(body, SECRET, NOW);
    await expect(verifyPurgeSignature(body, header, '', NOW)).resolves.toBe(false);
  });

  it('rejects a missing or malformed signature header', async () => {
    const body = serialisePurgePayload(payload);
    await expect(verifyPurgeSignature(body, null, SECRET, NOW)).resolves.toBe(false);
    await expect(verifyPurgeSignature(body, 'v1=deadbeef', SECRET, NOW)).resolves.toBe(false);
  });
});

describe('parsePurgePayload', () => {
  it('parses a well-formed event', () => {
    expect(parsePurgePayload(serialisePurgePayload(payload))).toEqual(payload);
  });

  it('refuses unknown events and missing fields rather than purging blindly', () => {
    expect(parsePurgePayload(JSON.stringify({ ...payload, event: 'wipe-everything' }))).toBeNull();
    expect(parsePurgePayload(JSON.stringify({ tenantId: 'x' }))).toBeNull();
    expect(parsePurgePayload('not json')).toBeNull();
  });
});

describe('purgeTagsFor', () => {
  it('drops the article and the listings, so the index is not stale behind the article', () => {
    expect(purgeTagsFor(payload, 'acme')).toEqual(['article:acme:deposit-rules', 'listing:acme']);
  });

  it('never emits a tag that would reach another tenant', () => {
    for (const tag of purgeTagsFor(payload, 'acme')) expect(tag).toContain('acme');
  });
});
