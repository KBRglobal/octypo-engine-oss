/**
 * Randomised publish planning.
 *
 * A site that publishes at exactly 09:00 every day looks like what it is — a
 * machine. Real editorial desks are noisy: some days two pieces, some days
 * four, at odd minutes. This module hands approved drafts randomised future
 * slots inside a working window, so the public rhythm of the site reads human
 * while the operator only ever pressed one button.
 */

export interface PlanOptions {
  /** Average articles per day. The actual count varies ±1 around it. */
  perDay: number;
  /** Publishing window in local hours, inclusive start, exclusive end. */
  windowStartHour: number;
  windowEndHour: number;
  /** First day to plan (defaults to tomorrow). */
  from?: Date;
  /** Random source, injected by tests. */
  random?: () => number;
}

/**
 * Assign one future slot per draft.
 *
 * Slots are strictly increasing, at least 35 minutes apart within a day —
 * publishes two minutes apart read as machine again — and each day carries
 * perDay ± 1 articles so no two weeks look alike.
 */
export function planSlots(count: number, options: PlanOptions): Date[] {
  const { perDay, windowStartHour, windowEndHour, random = Math.random } = options;
  if (count <= 0 || perDay <= 0 || windowEndHour <= windowStartHour) return [];

  const slots: Date[] = [];
  const day = options.from ? new Date(options.from) : new Date(Date.now() + 86400_000);
  day.setHours(0, 0, 0, 0);

  while (slots.length < count) {
    // ±1 wobble, clamped so a day never goes empty when there is work.
    const wobble = Math.floor(random() * 3) - 1;
    const todayCount = Math.min(Math.max(perDay + wobble, 1), count - slots.length);

    const windowMinutes = (windowEndHour - windowStartHour) * 60;
    const segment = windowMinutes / todayCount;
    const minutes: number[] = [];
    for (let i = 0; i < todayCount; i++) {
      // One slot per segment, jittered inside it, with a floor of 35 minutes
      // between neighbours.
      const jitter = random() * Math.max(segment - 35, 5);
      const minute = Math.round(i * segment + jitter);
      const previous = minutes[minutes.length - 1];
      minutes.push(previous !== undefined ? Math.max(minute, previous + 35) : minute);
    }

    for (const minute of minutes) {
      if (slots.length >= count) break;
      const slot = new Date(day);
      slot.setMinutes(windowStartHour * 60 + Math.min(minute, windowMinutes - 1));
      slots.push(slot);
    }
    day.setDate(day.getDate() + 1);
  }

  return slots;
}

export interface AutoScheduleConfig {
  perDay: number;
  windowStartHour: number;
  windowEndHour: number;
}

/**
 * Reads PUBLISH_PER_DAY and PUBLISH_WINDOW ("8-21").
 *
 * The window hours are interpreted in the process timezone. Set TZ on the
 * deployment to the customer's zone (e.g. Europe/Paris) so "8-21" means their
 * local morning-to-evening, not the server's UTC. The install kit sets it.
 */
export function autoScheduleConfig(env: NodeJS.ProcessEnv = process.env): AutoScheduleConfig {
  const perDay = Number(env.PUBLISH_PER_DAY) || 3;
  const window = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(env.PUBLISH_WINDOW?.trim() ?? "");
  const start = window ? Number(window[1]) : 8;
  const end = window ? Number(window[2]) : 21;
  return {
    perDay,
    windowStartHour: Math.min(Math.max(start, 0), 23),
    windowEndHour: Math.min(Math.max(end > start ? end : start + 1, 1), 24),
  };
}

/**
 * Place one article into an existing publish calendar.
 *
 * Used by the continuous path: an approval arrives, the calendar already holds
 * slots, and the new piece takes the first day that is under the daily target —
 * at a random minute, at least 35 minutes clear of its neighbours. The manual
 * "plan everything" button and this incremental path therefore produce the same
 * kind of calendar.
 */
/** Local-date key. UTC keys shift a +04:00 midnight onto the previous day. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function placeIntoCalendar(
  existing: Date[],
  config: AutoScheduleConfig,
  random: () => number = Math.random,
  from?: Date
): Date {
  const byDay = new Map<string, Date[]>();
  for (const slot of existing) {
    const key = localDayKey(slot);
    byDay.set(key, [...(byDay.get(key) ?? []), slot]);
  }

  const day = from ? new Date(from) : new Date(Date.now() + 86400_000);
  day.setHours(0, 0, 0, 0);

  for (let i = 0; i < 365; i++) {
    const key = localDayKey(day);
    const taken = (byDay.get(key) ?? []).sort((a, b) => a.getTime() - b.getTime());
    if (taken.length < config.perDay) {
      const windowMinutes = (config.windowEndHour - config.windowStartHour) * 60;
      // Up to 20 random draws to find a spot 35 minutes clear of neighbours;
      // a window that cannot fit falls through to the next day.
      for (let attempt = 0; attempt < 20; attempt++) {
        const minute = Math.floor(random() * windowMinutes);
        const candidate = new Date(day);
        candidate.setMinutes(config.windowStartHour * 60 + minute);
        const clear = taken.every(
          (slot) => Math.abs(slot.getTime() - candidate.getTime()) >= 35 * 60000
        );
        if (clear) return candidate;
      }
    }
    day.setDate(day.getDate() + 1);
  }
  // Degenerate config — put it tomorrow morning rather than failing the approve.
  const fallback = from ? new Date(from) : new Date(Date.now() + 86400_000);
  fallback.setHours(config.windowStartHour, 0, 0, 0);
  return fallback;
}
