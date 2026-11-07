import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { parseEntitlements, CAPABILITIES } = await import('./entitlements.js');

/**
 * Image optimisation and CDN delivery are a paid add-on. A customer who did not
 * buy storage must not receive it, and a customer who did must not lose it
 * because of a typo somewhere else in the list.
 */
describe('entitlements', () => {
  it('grants everything when nothing is configured', () => {
    // Existing installs have no such variable and currently do everything.
    expect(parseEntitlements(undefined).size).toBe(CAPABILITIES.length);
    expect(parseEntitlements('   ').size).toBe(CAPABILITIES.length);
  });

  it('grants exactly the named capabilities', () => {
    const granted = parseEntitlements('stock-images, internal-links');
    expect([...granted].sort()).toEqual(['internal-links', 'stock-images']);
  });

  it('reads a leading subtraction as "the product, minus this"', () => {
    const granted = parseEntitlements('-image-optimisation');
    expect(granted.has('image-optimisation')).toBe(false);
    expect(granted.has('stock-images')).toBe(true);
    expect(granted.size).toBe(CAPABILITIES.length - 1);
  });

  it('supports the explicit all-minus form', () => {
    const granted = parseEntitlements('all,-image-optimisation,-generated-images');
    expect(granted.has('image-optimisation')).toBe(false);
    expect(granted.has('generated-images')).toBe(false);
    expect(granted.has('stock-images')).toBe(true);
  });

  it('grants nothing for none', () => {
    expect(parseEntitlements('none').size).toBe(0);
  });

  it('does not let a short list accidentally grant an add-on', () => {
    // The whole point: naming one capability must not imply the rest.
    expect(parseEntitlements('stock-images').has('image-optimisation')).toBe(false);
  });

  it('ignores a typo instead of refusing to boot', () => {
    const granted = parseEntitlements('stock-images, imag-optimisation');
    expect(granted.has('stock-images')).toBe(true);
    expect(granted.size).toBe(1);
  });

  it('applies tokens in order, so a later grant wins', () => {
    expect(parseEntitlements('-stock-images,stock-images').has('stock-images')).toBe(true);
    expect(parseEntitlements('all,-stock-images').has('stock-images')).toBe(false);
  });

  it('is case and whitespace insensitive', () => {
    expect(parseEntitlements('  Stock-Images ,  INTERNAL-LINKS ').size).toBe(2);
  });
});
