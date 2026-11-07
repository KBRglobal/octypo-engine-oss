/**
 * The current date, as a fact every model must be told.
 *
 * A language model has no clock. Left alone it assumes the year of its
 * training data, and the engine paid for that twice on one install: the
 * writer titled a September 2026 article "season 2025-2026", and the Gate 2
 * reviewer rejected a real news item as "a fictional future event in 2026".
 * Every prompt that reasons about time therefore carries this block, and the
 * deterministic gates check the same clock (see title-freshness).
 */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** ISO calendar date, UTC. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The prompt block. Explicit about the consequence, because "today is X"
 * alone did not stop a reviewer from calling the current year fictional.
 */
export function todayContextBlock(now: Date = new Date()): string {
  const iso = todayIso(now);
  const weekday = WEEKDAYS[now.getUTCDay()];
  const year = now.getUTCFullYear();
  return [
    `CURRENT DATE: ${iso} (${weekday}). The current year is ${year}.`,
    `Dates on or before ${iso} are the past or the present, never "the future" and never fictional.`,
    `An event, season or edition dated ${year} or ${year + 1} is current. Never call it speculative because of its date.`,
    `Never describe a season or edition that ended before ${iso} as upcoming, and never put a past year in a title about what is coming next.`,
  ].join("\n");
}
