import { describe, it, expect } from 'vitest';

import { quickFactRows, checklistItems } from './quick-facts';

describe('quickFactRows', () => {
  it('renders the fields that are present, in a fixed reading order', () => {
    const rows = quickFactRows({
      bestFor: ['Tenants'],
      difficulty: 'easy',
      timeNeeded: '5-10 minutes',
    });
    expect(rows.map(r => r.label)).toEqual(['Difficulty', 'Time needed', 'Best for']);
  });

  it('joins array fields into a readable list', () => {
    const rows = quickFactRows({ tools: ['Phone camera', 'Flashlight'] });
    expect(rows[0]).toEqual({ label: 'Tools', value: 'Phone camera, Flashlight' });
  });

  it('omits empty strings, empty arrays and nulls rather than rendering blank rows', () => {
    expect(quickFactRows({ difficulty: '', tools: [], riskLevel: null })).toEqual([]);
  });

  it('drops non-string entries inside an array', () => {
    expect(quickFactRows({ tools: ['ok', 42, null] as never })).toEqual([
      { label: 'Tools', value: 'ok' },
    ]);
  });

  it('ignores keys it does not know, so a new engine field cannot break the page', () => {
    expect(quickFactRows({ somethingNew: 'x' } as never)).toEqual([]);
  });

  it('returns nothing for null, undefined or a non-object', () => {
    expect(quickFactRows(null)).toEqual([]);
    expect(quickFactRows(undefined)).toEqual([]);
    expect(quickFactRows('nope' as never)).toEqual([]);
  });
});

describe('checklistItems', () => {
  it('returns only non-empty strings', () => {
    expect(checklistItems({ checklist: ['Take photos', '', '  ', 7 as never] })).toEqual(['Take photos']);
  });

  it('returns nothing when there is no checklist', () => {
    expect(checklistItems({})).toEqual([]);
    expect(checklistItems(null)).toEqual([]);
  });
});
