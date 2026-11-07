#!/usr/bin/env node
/**
 * Install the admin app's dependencies after a source checkout's npm install.
 * The published package ships the built admin, so there it does nothing.
 *
 * npm passes its settings down to child processes as npm_config_* variables,
 * and a user-level allow-scripts setting then fails the nested install, so
 * those two are removed before calling npm again.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("admin/package.json")) process.exit(0);

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^npm_config_allow[_-]scripts$/i.test(key)) delete env[key];
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["--prefix", "admin", "ci"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
