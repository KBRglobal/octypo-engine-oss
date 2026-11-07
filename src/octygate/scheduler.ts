import { SITE_URL } from "../config/domain.js";
import { logger } from "../lib/logger.js";
import { withTickLock, TICK_LOCKS } from "../lib/advisory-lock.js";
import { runOctyGate } from "./runner.js";

let timer: NodeJS.Timeout | null = null;

export function startOctyGateScheduler(): void {
  if (timer) clearInterval(timer);
  if (process.env.ENABLE_OCTYGATE !== "true" || !SITE_URL) return;
  const siteUrl = SITE_URL;
  const tick = () => withTickLock(TICK_LOCKS.octyGate, () => runOctyGate(siteUrl)).catch((error) => logger.error({ error }, "[OctyGate] Patrol failed"));
  timer = setInterval(tick, (Number(process.env.OCTYGATE_INTERVAL_HOURS) || 24) * 3_600_000);
  setTimeout(tick, 90_000).unref?.();
}

export function stopOctyGateScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function octyGateStatus() { return { running: timer !== null, enabled: process.env.ENABLE_OCTYGATE === "true" }; }
