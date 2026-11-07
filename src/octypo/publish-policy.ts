/**
 * Single source of truth for "may this article go live without a human?".
 *
 * This exists because the decision used to be made in two places: the
 * gatekeeper wrote `status: "published"` unconditionally on approval, and the
 * job handler afterwards set it back to `draft` when AUTO_PUBLISH was off. In
 * the gap between those two writes the article was genuinely published and
 * served by `GET /api/articles` — so the one safety switch a cautious customer
 * relies on was a race, not a gate.
 *
 * Every caller must decide through this function so the two can never disagree.
 */

const OFF_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Defaults to true to preserve existing single-tenant behaviour. New tenants
 * should be created with auto-publish OFF and opt in deliberately.
 */
export function shouldAutoPublish(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.AUTO_PUBLISH ?? "true").trim().toLowerCase();
  return !OFF_VALUES.has(raw);
}

/**
 * The status an approved article must be written with — never "published"
 * when held.
 *
 * Held means "in_review", not "draft": the publish scheduler auto-slots every
 * `draft` with no calendar slot (that is how a human's Approve in the Studio
 * goes live), so writing a held article as `draft` sent it live on the next
 * tick anyway and the AUTO_PUBLISH switch protected nothing.
 */
export function approvedStatus(env: NodeJS.ProcessEnv = process.env): "published" | "in_review" {
  return shouldAutoPublish(env) ? "published" : "in_review";
}

/**
 * Extra editor rounds for mechanical findings (Gate 2's deterministic gate and
 * the publish audit) on an article the reviewer approved. They are fixable by
 * an edit, so they get rounds of their own instead of a rejection.
 */
export function publishFixRounds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PUBLISH_FIX_ROUNDS ?? 2);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

/**
 * APPROVED_TO_CALENDAR=true: an approved article takes the next free calendar
 * slot (PUBLISH_PER_DAY, PUBLISH_WINDOW) instead of going live the moment it
 * is approved. For a site that publishes on a fixed rhythm (say, one a day).
 */
export function approvedToCalendar(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["true", "1", "yes", "on"].includes((env.APPROVED_TO_CALENDAR ?? "false").trim().toLowerCase());
}
