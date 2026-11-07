import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadBuildInfo, getBuildInfo, resetBuildInfoCache } from "./build-info.js";

/**
 * The build stamp is the only way a deployed engine (no .git in the railway-up
 * tree) can ever say which commit it runs. /health and deploy-all both depend
 * on it, so the fallback chain has to be airtight.
 */

const ORIGINAL_CWD = process.cwd();

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "build-info-test-"));
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  resetBuildInfoCache();
});

describe("loadBuildInfo", () => {
  it("reads build-info.json from the given cwd (the prod path)", () => {
    const dir = tempDir();
    const sha = "a".repeat(40);
    fs.writeFileSync(
      path.join(dir, "build-info.json"),
      JSON.stringify({ sha, builtAt: "2026-08-23T00:00:00.000Z" })
    );
    expect(loadBuildInfo(dir)).toEqual({ sha, builtAt: "2026-08-23T00:00:00.000Z" });
  });

  it("falls back cleanly when the file is absent and there is no git", () => {
    const dir = tempDir();
    const info = loadBuildInfo(dir);
    expect(info.sha).toBe("unknown");
    expect(new Date(info.builtAt).getTime()).not.toBeNaN();
  });

  it("ignores a malformed file instead of crashing /health", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "build-info.json"), "{not json");
    const info = loadBuildInfo(dir);
    expect(typeof info.sha).toBe("string");
    expect(info.sha.length).toBeGreaterThan(0);
  });

  it("falls back to git in a repo without a stamp (the dev path)", () => {
    // vitest runs from the repo root; whether or not a stamp file exists the
    // resolved SHA must be a real 40-hex commit, never "unknown".
    const info = loadBuildInfo(ORIGINAL_CWD);
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("getBuildInfo caching", () => {
  it("resolves once and keeps the first answer", () => {
    const dir = tempDir();
    const first = "b".repeat(40);
    const second = "c".repeat(40);
    fs.writeFileSync(
      path.join(dir, "build-info.json"),
      JSON.stringify({ sha: first, builtAt: "2026-08-23T01:00:00.000Z" })
    );
    process.chdir(dir);
    resetBuildInfoCache();
    expect(getBuildInfo().sha).toBe(first);
    fs.writeFileSync(
      path.join(dir, "build-info.json"),
      JSON.stringify({ sha: second, builtAt: "2026-08-23T02:00:00.000Z" })
    );
    // Still the first read — identity is immutable for the process lifetime.
    expect(getBuildInfo().sha).toBe(first);
  });
});
