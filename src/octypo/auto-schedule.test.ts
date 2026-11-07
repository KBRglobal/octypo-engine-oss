import { describe, it, expect } from 'vitest';

import { planSlots, autoScheduleConfig, placeIntoCalendar } from './auto-schedule.js';

/**
 * A site that publishes at exactly 09:00 daily reads as a machine. The plan
 * must be random enough to look human and constrained enough to stay sane.
 */
describe('randomised publish planning', () => {
  const options = { perDay: 3, windowStartHour: 8, windowEndHour: 21, from: new Date('2026-09-01T00:00:00') };

  it('gives every draft exactly one future slot', () => {
    expect(planSlots(10, { ...options, random: () => 0.5 })).toHaveLength(10);
  });

  it('keeps every slot inside the publishing window', () => {
    for (const slot of planSlots(30, options)) {
      expect(slot.getHours()).toBeGreaterThanOrEqual(8);
      expect(slot.getHours()).toBeLessThan(21);
    }
  });

  it('keeps slots strictly increasing and at least 35 minutes apart', () => {
    const slots = planSlots(30, options);
    for (let i = 1; i < slots.length; i++) {
      const gap = (slots[i].getTime() - slots[i - 1].getTime()) / 60000;
      expect(gap).toBeGreaterThanOrEqual(35);
    }
  });

  it('varies the daily count around the target instead of a flat cadence', () => {
    // A seeded LCG: deterministic, but with no phase-lock against the number
    // of random draws a day happens to consume.
    let seed = 42;
    const lcg = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
    const slots = planSlots(40, { ...options, random: lcg });
    const perDay = new Map<string, number>();
    for (const slot of slots) {
      const key = slot.toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }
    const counts = [...perDay.values()];
    expect(new Set(counts).size).toBeGreaterThan(1); // not a flat line
    for (const count of counts) {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  it('never plans into the past: default start is tomorrow', () => {
    const [first] = planSlots(1, { perDay: 3, windowStartHour: 8, windowEndHour: 21 });
    expect(first.getTime()).toBeGreaterThan(Date.now());
  });

  it('plans nothing for nothing', () => {
    expect(planSlots(0, options)).toEqual([]);
    expect(planSlots(5, { ...options, perDay: 0 })).toEqual([]);
  });
});

describe('configuration', () => {
  it('reads the cadence and window from the environment', () => {
    const config = autoScheduleConfig({ PUBLISH_PER_DAY: '5', PUBLISH_WINDOW: '9-18' } as NodeJS.ProcessEnv);
    expect(config).toEqual({ perDay: 5, windowStartHour: 9, windowEndHour: 18 });
  });

  it('defaults to three a day between 08:00 and 21:00', () => {
    expect(autoScheduleConfig({} as NodeJS.ProcessEnv)).toEqual({
      perDay: 3,
      windowStartHour: 8,
      windowEndHour: 21,
    });
  });

  it('refuses an inverted window rather than planning into it', () => {
    const config = autoScheduleConfig({ PUBLISH_WINDOW: '20-8' } as NodeJS.ProcessEnv);
    expect(config.windowEndHour).toBeGreaterThan(config.windowStartHour);
  });
});

describe('incremental placement', () => {
  const config = { perDay: 3, windowStartHour: 8, windowEndHour: 21 };
  const from = new Date('2026-09-01T00:00:00');

  it('fills the first day that is under the daily target', () => {
    const day1 = ['2026-09-01T09:00:00', '2026-09-01T13:00:00', '2026-09-01T18:00:00'].map(
      (s) => new Date(s)
    );
    const slot = placeIntoCalendar(day1, config, () => 0.5, from);
    expect(slot.getDate()).toBe(2);
  });

  it('keeps 35 minutes of clearance from existing slots', () => {
    const existing = [new Date('2026-09-01T14:30:00')];
    let n = 0;
    // First draws land right on top of the taken slot; later draws move away.
    const slot = placeIntoCalendar(existing, config, () => [0.5, 0.5, 0.9][Math.min(n++, 2)], from);
    const gap = Math.abs(slot.getTime() - existing[0].getTime()) / 60000;
    expect(gap).toBeGreaterThanOrEqual(35);
  });

  it('stays inside the window', () => {
    const slot = placeIntoCalendar([], config, () => 0.999, from);
    expect(slot.getHours()).toBeLessThan(21);
    expect(slot.getHours()).toBeGreaterThanOrEqual(8);
  });
});
