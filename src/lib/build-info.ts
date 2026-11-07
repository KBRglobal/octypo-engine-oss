/**
 * Which build is this process running?
 *
 * Resolution order:
 *   1. `build-info.json` in the working directory. NOTE: this file is in
 *      .gitignore, and `railway up` excludes gitignored files — so it never
 *      reaches prod; the env vars below are the real prod path.
 *   2. ENGINE_BUILD_SHA / ENGINE_BUILD_AT env vars — set on the Railway
 *      service by scripts/deploy-all.mjs right before each upload.
 *   3. `git rev-parse HEAD` — the dev path, with builtAt = process start time.
 *   4. `{ sha: "unknown" }` — never throws; /health must always answer.
 *
 * The result is cached after the first read: identity cannot change while the
 * process lives, and /health is polled every 15 minutes per install.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface BuildInfo {
  sha: string;
  builtAt: string;
}

/** Process start, ISO — the honest "builtAt" when running from source in dev. */
const PROCESS_START_ISO = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** Uncached resolution — exported for tests; callers want getBuildInfo(). */
export function loadBuildInfo(cwd: string = process.cwd()): BuildInfo {
  try {
    const raw = fs.readFileSync(path.join(cwd, "build-info.json"), "utf8");
    const parsed = JSON.parse(raw) as { sha?: unknown; builtAt?: unknown };
    if (
      typeof parsed.sha === "string" &&
      parsed.sha.length > 0 &&
      parsed.sha !== "unknown" && // a giterless build stamps "unknown" — try env/git instead
      typeof parsed.builtAt === "string" &&
      parsed.builtAt.length > 0
    ) {
      return { sha: parsed.sha, builtAt: parsed.builtAt };
    }
  } catch {
    // absent or malformed — fall through to env
  }
  const envSha = process.env.ENGINE_BUILD_SHA;
  if (envSha && /^[0-9a-f]{40}$/.test(envSha)) {
    const envAt = process.env.ENGINE_BUILD_AT;
    return { sha: envSha, builtAt: envAt && envAt.length > 0 ? envAt : PROCESS_START_ISO };
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, builtAt: PROCESS_START_ISO };
  } catch {
    // no git either
  }
  return { sha: "unknown", builtAt: PROCESS_START_ISO };
}

let cached: BuildInfo | null = null;

/** The build identity of this process. Cached after the first read. */
export function getBuildInfo(): BuildInfo {
  cached ??= loadBuildInfo();
  return cached;
}

/** Test hook — identity is otherwise immutable for the process lifetime. */
export function resetBuildInfoCache(): void {
  cached = null;
}
