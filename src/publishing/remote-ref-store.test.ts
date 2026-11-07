import { describe, it, expect } from "vitest";

import { InMemoryRemoteRefStore } from "./remote-ref-store.js";

const ref = {
  targetId: "wordpress:example.com",
  articleId: "c_1",
  remoteId: "412",
  remoteUrl: "https://example.com/?p=412",
  mediaId: "77",
  contentHash: "abc",
  updatedAt: new Date("2026-08-19T09:00:00.000Z"),
};

describe("InMemoryRemoteRefStore", () => {
  it("round-trips a reference", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put(ref);
    expect(await store.get(ref.targetId, "c_1")).toEqual(ref);
  });

  it("is empty for an unknown article", async () => {
    const store = new InMemoryRemoteRefStore();
    expect(await store.get(ref.targetId, "nope")).toBeNull();
  });

  // Two targets hold two different remote ids for the same article. Keying on
  // the article alone would make a second target overwrite the first and then
  // update the wrong post.
  it("keeps one reference per target per article", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put(ref);
    await store.put({ ...ref, targetId: "webhook:acme", remoteId: "acme-9" });
    expect((await store.get("wordpress:example.com", "c_1"))?.remoteId).toBe("412");
    expect((await store.get("webhook:acme", "c_1"))?.remoteId).toBe("acme-9");
  });

  it("overwrites in place rather than accumulating", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put(ref);
    await store.put({ ...ref, contentHash: "def" });
    expect((await store.get(ref.targetId, "c_1"))?.contentHash).toBe("def");
  });

  it("forgets a reference", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put(ref);
    await store.forget(ref.targetId, "c_1");
    expect(await store.get(ref.targetId, "c_1")).toBeNull();
  });

  it("forgetting something that was never stored is not an error", async () => {
    const store = new InMemoryRemoteRefStore();
    await expect(store.forget(ref.targetId, "ghost")).resolves.toBeUndefined();
  });
});
