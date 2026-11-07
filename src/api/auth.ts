/**
 * Admin authentication — minimal, stateless.
 *
 * The admin token is HMAC-SHA256("octypo-admin") keyed with ADMIN_PASSWORD,
 * hex-encoded. No DB, no sessions: as long as ADMIN_PASSWORD is stable the
 * token is stable. If ADMIN_PASSWORD is unset, the admin API is disabled
 * (503) and the engine keeps running headless.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { logger } from "../lib/logger.js";

const TOKEN_MESSAGE = "octypo-admin";

export function isAdminEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

/** Compute the expected admin token, or null when admin is disabled. */
export function computeAdminToken(): string | null {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  return createHmac("sha256", password).update(TOKEN_MESSAGE).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Brute-force gate on login.
 *
 * The admin token is derived from one password, so the password IS the
 * account. Ten wrong guesses from one address buys a 15-minute wait; a correct
 * login clears the slate. In-process on purpose — one engine, one process, and
 * a datastore dependency here would let a DB outage lock the operator out too.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, number[]>();

export function isLoginBlocked(ip: string, now = Date.now()): boolean {
  const recent = (loginFailures.get(ip) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
  loginFailures.set(ip, recent);
  return recent.length >= LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip: string, now = Date.now()): void {
  loginFailures.set(ip, [...(loginFailures.get(ip) ?? []), now]);
}

export function clearLoginFailures(ip: string): void {
  loginFailures.delete(ip);
}

/** POST /api/auth/login — { password } → { token } */
export function handleLogin(req: Request, res: Response): void {
  const ip = req.ip ?? "unknown";
  if (isLoginBlocked(ip)) {
    logger.warn({ ip }, "[Auth] Login blocked — too many failures");
    res.status(429).json({ error: "Too many attempts — wait 15 minutes" });
    return;
  }

  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    res.status(503).json({ error: "admin disabled" });
    return;
  }

  const provided = typeof req.body?.password === "string" ? req.body.password : "";
  if (!provided || !constantTimeEquals(provided, password)) {
    recordLoginFailure(ip);
    logger.warn({ ip: req.ip }, "[Auth] Failed admin login attempt");
    res.status(401).json({ error: "Invalid password" });
    return;
  }

  clearLoginFailures(ip);
  res.json({ token: computeAdminToken() });
}

/** Middleware: require `Authorization: Bearer <admin token>`. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = computeAdminToken();
  if (!expected) {
    res.status(503).json({ error: "admin disabled" });
    return;
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (!token || !constantTimeEquals(token, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
