import { describe, it, expect } from 'vitest';

import { reconcile } from './reconcile';
import type { SyncItem } from './engine-client';

const live = (slug: string, updatedAt: string): SyncItem =>
  ({ slug, title: slug, updatedAt, tags: [] }) as SyncItem;
const gone = (slug: string, updatedAt: string): SyncItem =>
  ({ slug, deleted: true, updatedAt }) as SyncItem;

describe('reconcile', () => {
  it('purges a tag per changed article plus the listings', () => {
    const result = reconcile([live('a', '2026-08-01T00:00:00.000Z')], 'acme', null);
    expect(result.tags).toContain('article:acme:a');
    expect(result.tags).toContain('listing:acme');
  });

  it('separates tombstones from live changes', () => {
    const result = reconcile(
      [live('a', '2026-08-01T00:00:00.000Z'), gone('b', '2026-08-02T00:00:00.000Z')],
      'acme',
      null
    );
    expect(result.changedSlugs).toEqual(['a']);
    expect(result.removedSlugs).toEqual(['b']);
  });

  // An unpublish or a delete has to reach the blog, or the page stays live on a
  // customer's domain forever. A pull-based blog cannot learn it any other way.
  it('still purges a removed article, not only a changed one', () => {
    const result = reconcile([gone('b', '2026-08-02T00:00:00.000Z')], 'acme', null);
    expect(result.tags).toContain('article:acme:b');
  });

  it('does nothing at all on an empty window', () => {
    const result = reconcile([], 'acme', '2026-08-01T00:00:00.000Z');
    expect(result.tags).toEqual([]);
    expect(result.watermark).toBe('2026-08-01T00:00:00.000Z');
  });

  it('deduplicates a slug that appears twice in one window', () => {
    const result = reconcile(
      [live('a', '2026-08-01T00:00:00.000Z'), live('a', '2026-08-01T00:05:00.000Z')],
      'acme',
      null
    );
    expect(result.tags.filter(t => t === 'article:acme:a')).toHaveLength(1);
  });

  // Advancing the watermark to exactly the newest updatedAt drops any row that
  // shares that timestamp and was written between the two queries.
  it('rewinds the watermark slightly so a same-millisecond row is not skipped', () => {
    const result = reconcile([live('a', '2026-08-01T00:00:10.000Z')], 'acme', null);
    expect(Date.parse(result.watermark!)).toBeLessThan(Date.parse('2026-08-01T00:00:10.000Z'));
  });

  it('never moves the watermark backwards past the previous one when nothing is newer', () => {
    const previous = '2026-08-05T00:00:00.000Z';
    const result = reconcile([live('a', '2026-08-06T00:00:00.000Z')], 'acme', previous);
    expect(Date.parse(result.watermark!)).toBeGreaterThan(Date.parse(previous));
  });

  it('keeps the previous watermark when every timestamp in the window is unparseable', () => {
    const result = reconcile([live('a', 'nonsense')], 'acme', '2026-08-01T00:00:00.000Z');
    expect(result.watermark).toBe('2026-08-01T00:00:00.000Z');
  });

  it('never emits a tag that could reach another tenant', () => {
    const result = reconcile([live('a', '2026-08-01T00:00:00.000Z'), gone('b', '2026-08-01T00:00:00.000Z')], 'acme', null);
    for (const tag of result.tags) expect(tag).toContain('acme');
  });
});
