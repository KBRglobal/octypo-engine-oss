import { describe, it, expect } from "vitest";

import { deliver, resolveTargets } from "./registry.js";
import { normaliseArticle } from "./normalise.js";
import { InMemoryRemoteRefStore } from "./remote-ref-store.js";
import { capabilities, failed, type NormalisedArticle, type PublishOutcome, type PublishingTarget } from "./types.js";

const article = normaliseArticle({
  id: "c_1",
  title: "Deposit rules",
  slug: "deposit-rules",
  summary: "Short.",
  category: "guide",
  blocks: [{ id: "t", type: "text", data: { content: "<p>Body</p>" } }],
});

/** A target that does exactly what the test tells it to. */
function stub(id: string, outcome: PublishOutcome): PublishingTarget & { calls: number } {
  const target = {
    id,
    kind: "stub",
    capabilities: capabilities({}),
    calls: 0,
    async check() {
      return { ok: true as const };
    },
    async publish(_article: NormalisedArticle) {
      target.calls += 1;
      return outcome;
    },
    async unpublish() {
      return outcome;
    },
  };
  return target;
}

const written = (id: string): PublishOutcome => ({
  status: "written",
  action: "created",
  remote: {
    targetId: id,
    articleId: "c_1",
    remoteId: "1",
    remoteUrl: null,
    mediaId: null,
    contentHash: article.contentHash,
    updatedAt: new Date(),
  },
  degraded: [],
});

describe("resolveTargets", () => {
  const store = new InMemoryRemoteRefStore();

  it("configures nothing when nothing is configured — publishing stays local", () => {
    expect(resolveTargets({}, store)).toEqual([]);
  });

  it("builds a WordPress target from the environment", () => {
    const targets = resolveTargets(
      {
        WORDPRESS_URL: "https://example.com",
        WORDPRESS_USER: "octypo",
        WORDPRESS_APP_PASSWORD: "abcd efgh",
      },
      store
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe("wordpress");
    expect(targets[0].id).toBe("wordpress:example.com");
  });

  // Half-configured is worse than not configured: it looks connected and
  // publishes nothing. It must not produce a target at all.
  it("ignores a WordPress target that is missing its password", () => {
    expect(
      resolveTargets({ WORDPRESS_URL: "https://example.com", WORDPRESS_USER: "octypo" }, store)
    ).toEqual([]);
  });

  it("builds a webhook target from the environment", () => {
    const targets = resolveTargets(
      { PUBLISH_WEBHOOK_URL: "https://acme.test/hook", PUBLISH_WEBHOOK_SECRET: "s" },
      store
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe("webhook");
  });

  it("runs both at once — a customer can mirror to two systems", () => {
    const targets = resolveTargets(
      {
        WORDPRESS_URL: "https://example.com",
        WORDPRESS_USER: "octypo",
        WORDPRESS_APP_PASSWORD: "p",
        PUBLISH_WEBHOOK_URL: "https://acme.test/hook",
        PUBLISH_WEBHOOK_SECRET: "s",
      },
      store
    );
    expect(targets.map(t => t.kind).sort()).toEqual(["webhook", "wordpress"]);
  });
});

describe("deliver", () => {
  it("is a success when there is nothing to deliver to", async () => {
    const report = await deliver(article, []);
    expect(report).toMatchObject({ ok: true, retryable: false, results: [] });
  });

  it("reports every target's outcome", async () => {
    const report = await deliver(article, [stub("a", written("a")), stub("b", written("b"))]);
    expect(report.ok).toBe(true);
    expect(report.results.map(r => r.targetId)).toEqual(["a", "b"]);
  });

  it("fails, retryably, when a target is temporarily down", async () => {
    const report = await deliver(article, [stub("a", failed("unreachable", "ECONNREFUSED"))]);
    expect(report.ok).toBe(false);
    expect(report.retryable).toBe(true);
  });

  it("fails, permanently, when a target rejects the article", async () => {
    const report = await deliver(article, [stub("a", failed("unauthorized", "bad password"))]);
    expect(report.ok).toBe(false);
    expect(report.retryable).toBe(false);
  });

  // One broken target must not stop the others: a customer mirroring to two
  // systems should not lose both because one is down.
  it("still delivers to healthy targets when one fails", async () => {
    const good = stub("good", written("good"));
    const report = await deliver(article, [stub("bad", failed("unreachable", "down")), good]);
    expect(good.calls).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(2);
  });

  // If any failure is worth retrying, the job is worth retrying — otherwise a
  // permanent failure on one target would strand a recoverable one on another.
  it("is retryable when any failure is retryable", async () => {
    const report = await deliver(article, [
      stub("a", failed("unauthorized", "no")),
      stub("b", failed("unreachable", "later")),
    ]);
    expect(report.retryable).toBe(true);
  });

  it("collects degradations without failing", async () => {
    const outcome: PublishOutcome = {
      ...(written("a") as Extract<PublishOutcome, { status: "written" }>),
      degraded: [{ feature: "tags", detail: "no tags on this target" }],
    };
    const report = await deliver(article, [stub("a", outcome)]);
    expect(report.ok).toBe(true);
    expect(report.degraded).toHaveLength(1);
  });

  // For a customer who would rather not publish than publish incomplete.
  it("treats degradation as failure in strict mode", async () => {
    const outcome: PublishOutcome = {
      ...(written("a") as Extract<PublishOutcome, { status: "written" }>),
      degraded: [{ feature: "structuredData", detail: "stripped" }],
    };
    const report = await deliver(article, [stub("a", outcome)], { strictDegradation: true });
    expect(report.ok).toBe(false);
    // Nothing will fix itself on a retry: the target simply cannot take it.
    expect(report.retryable).toBe(false);
  });

  it("survives a target that throws despite the contract", async () => {
    const rogue: PublishingTarget = {
      id: "rogue",
      kind: "stub",
      capabilities: capabilities({}),
      async check() {
        return { ok: true as const };
      },
      async publish() {
        throw new Error("adapters are not supposed to do this");
      },
      async unpublish() {
        throw new Error("nor this");
      },
    };
    const report = await deliver(article, [rogue]);
    expect(report.ok).toBe(false);
    expect(report.results[0].outcome).toMatchObject({ status: "failed", code: "unknown" });
  });
});
