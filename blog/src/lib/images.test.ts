import { describe, it, expect } from 'vitest';

import { resizedImageUrl, buildSrcset, HERO_INTRINSIC } from './images';

const R2 = 'https://pub-abc123.r2.dev/octypo/hero-1.png';

describe('resizedImageUrl', () => {
  // OpenAIImageProvider uploads raw 1536x1024 PNGs (src/lib/image-provider.ts:151,
  // :183-195) — typically 1.5-3 MB. Served bare, that is a 4-8s mobile LCP and
  // the entire reason for choosing Astro evaporates.
  it('routes an R2 URL through Cloudflare image resizing', () => {
    const out = resizedImageUrl(R2, { width: 1200, prefix: '/cdn-cgi/image' });
    expect(out).toBe(`/cdn-cgi/image/width=1200,format=auto,quality=80/${R2}`);
  });

  it('asks for AVIF/WebP via format=auto, never a fixed format', () => {
    expect(resizedImageUrl(R2, { width: 800, prefix: '/cdn-cgi/image' })).toContain('format=auto');
  });

  it('returns the original URL when no resizing prefix is configured (self-host)', () => {
    expect(resizedImageUrl(R2, { width: 1200, prefix: null })).toBe(R2);
  });

  it('never double-wraps an already-resized URL', () => {
    const once = resizedImageUrl(R2, { width: 1200, prefix: '/cdn-cgi/image' });
    expect(resizedImageUrl(once, { width: 1200, prefix: '/cdn-cgi/image' })).toBe(once);
  });

  it('leaves a data: or relative URL alone', () => {
    expect(resizedImageUrl('/local/a.png', { width: 100, prefix: '/cdn-cgi/image' })).toBe('/local/a.png');
    expect(resizedImageUrl('data:image/png;base64,AA', { width: 100, prefix: '/cdn-cgi/image' })).toBe(
      'data:image/png;base64,AA'
    );
  });

  it('returns empty string for a missing URL rather than emitting src=""', () => {
    expect(resizedImageUrl(null, { width: 100, prefix: '/cdn-cgi/image' })).toBe('');
    expect(resizedImageUrl(undefined, { width: 100, prefix: '/cdn-cgi/image' })).toBe('');
  });
});

describe('buildSrcset', () => {
  it('emits one candidate per width with a w descriptor', () => {
    const set = buildSrcset(R2, [640, 1024], '/cdn-cgi/image');
    expect(set).toContain('width=640');
    expect(set).toContain(' 640w');
    expect(set).toContain(' 1024w');
  });

  it('is empty without a resizing prefix, so no bogus candidates are offered', () => {
    expect(buildSrcset(R2, [640], null)).toBe('');
  });
});

describe('HERO_INTRINSIC', () => {
  // Explicit width/height is what keeps CLS at 0; gpt-image-1 renders 1536x1024.
  it('matches what the engine actually generates', () => {
    expect(HERO_INTRINSIC).toEqual({ width: 1536, height: 1024 });
  });
});
