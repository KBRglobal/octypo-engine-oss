#!/usr/bin/env node
/**
 * Stamp the build with its identity: writes `build-info.json` at the repo root
 * with the current git HEAD SHA and an ISO build time.
 *
 * Runs at the FRONT of `npm run build`. Deploys ship the LOCAL tree via
 * `railway up` WITHOUT `.git`, so this file is the only way prod can ever
 * know which commit it is running — /health serves it (src/lib/build-info.ts).
 *
 * In an environment with no git (the Railway/nixpacks build), an existing
 * build-info.json is kept untouched; only when neither git nor a previous
 * file exists does it write { sha: "unknown" } and warn.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "build-info.json");

let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  sha = "";
}

// No git in the Railway build (and railway up drops the gitignored local
// stamp) — deploy-all sets ENGINE_BUILD_SHA on the service, which is
// available at build time too.
if (!/^[0-9a-f]{40}$/.test(sha) && /^[0-9a-f]{40}$/.test(process.env.ENGINE_BUILD_SHA ?? "")) {
  sha = process.env.ENGINE_BUILD_SHA;
}

if (/^[0-9a-f]{40}$/.test(sha)) {
  const info = { sha, builtAt: new Date().toISOString() };
  fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n");
  console.log(`[build-info] stamped ${sha.slice(0, 7)} -> build-info.json`);
} else if (fs.existsSync(OUT)) {
  // No identity available here — keep whatever stamp already exists.
  console.log("[build-info] no git available — keeping the existing build-info.json");
} else {
  const info = { sha: "unknown", builtAt: new Date().toISOString() };
  fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n");
  console.warn(
    "[build-info] WARNING: no git and no existing build-info.json — stamped sha \"unknown\". " +
      "Deploys must run `npm run build` (or scripts/write-build-info.mjs) locally BEFORE railway up."
  );
}
