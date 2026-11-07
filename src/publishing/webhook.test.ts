import { describe, it, expect } from "vitest";

import { WebhookTarget, serialiseArticleEvent } from "./webhook.js";
import { normaliseArticle } from "./normalise.js";
import { InMemoryRemoteRefStore } from "./remote-ref-store.js";
import { verifyPurgeSignature, SIGNATURE_HEADER } from "../lib/site-webhook.js";

const article = normaliseArticle({
  id: "c_1",
  title: "Deposit rules explained",
  slug: "deposit-rules",
  summary: "What a landlord may keep.",
  heroImage: "https://pub-abc.r2.dev/hero.png",
  heroImageAlt: "Keys",
  category: "guide",
  tags: ["deposits"],
  blocks: [{ id: "t", type: "text", data: { content: "<p>Read the contract.</p>" } }],
  seoSchema: [{ "@type": "Article" }],
  publishedAt: new Date("2026-08-19T09:00:00.000Z"),
});

interface Recorded {
  url: string;
  init: RequestInit;
}

function receiver(
  respond: (recorded: Recorded) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ id: "acme-99", url: "https://acme.test/p/99" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
) {
  const calls: Recorded[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const recorded = { url: String(input), init };
    calls.push(recorded);
    return respond(recorded);
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function target(
  fetchImpl: typeof fetch,
  store = new InMemoryRemoteRefStore(),
  config: Partial<{ url: string; secret: string }> = {}
) {
  return {
    store,
    hook: new WebhookTarget(
      { url: "https://acme.test/hooks/octypo", secret: "shhh", ...config },
      store,
      fetchImpl
    ),
  };
}

describe("WebhookTarget — the payload", () => {
  it("POSTs the whole normalised article, not a WordPress-shaped one", async () => {
    const rx = receiver();
    await target(rx.fetchImpl).hook.publish(article);

    const body = JSON.parse(String(rx.calls[0].init.body)) as Record<string, unknown>;
    expect(body.event).toBe("published");
    expect(body.article).toMatchObject({
      id: "c_1",
      title: "Deposit rules explained",
      slug: "deposit-rules",
      excerpt: "What a landlord may keep.",
      state: "published",
      category: { slug: "guide", name: "Guide" },
      tags: [{ slug: "deposits", name: "Deposits" }],
      heroImage: { url: "https://pub-abc.r2.dev/hero.png", alt: "Keys" },
      structuredData: [{ "@type": "Article" }],
    });
  });

  // A bespoke CMS may want the structure rather than our HTML. Sending both is
  // what makes this adapter a real second implementation and not a copy.
  it("carries the body as HTML and as blocks", async () => {
    const rx = receiver();
    await target(rx.fetchImpl).hook.publish(article);
    const body = JSON.parse(String(rx.calls[0].init.body)) as {
      article: { html: string; blocks: unknown[] };
    };
    expect(body.article.html).toContain("<p>Read the contract.</p>");
    expect(body.article.blocks).toHaveLength(1);
  });

  it("signs the body with the same scheme the blog already verifies", async () => {
    const rx = receiver();
    await target(rx.fetchImpl).hook.publish(article);

    const headers = rx.calls[0].init.headers as Record<string, string>;
    const signature = headers[SIGNATURE_HEADER];
    expect(signature).toBeDefined();
    expect(verifyPurgeSignature(String(rx.calls[0].init.body), signature, "shhh")).toBe(true);
    // The wrong secret must not verify — otherwise the signature is decoration.
    expect(verifyPurgeSignature(String(rx.calls[0].init.body), signature, "other")).toBe(false);
  });

  it("serialises deterministically so the signature covers a stable body", () => {
    const a = serialiseArticleEvent("published", article);
    const b = serialiseArticleEvent("published", article);
    expect(a).toBe(b);
  });
});

describe("WebhookTarget — idempotency", () => {
  it("sends the article id so the receiver can upsert rather than duplicate", async () => {
    const rx = receiver();
    await target(rx.fetchImpl).hook.publish(article);
    const body = JSON.parse(String(rx.calls[0].init.body)) as { article: { id: string } };
    expect(body.article.id).toBe("c_1");
  });

  it("records the receiver's own id so a later delivery can reference it", async () => {
    const rx = receiver();
    const { hook, store } = target(rx.fetchImpl);
    const outcome = await hook.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.remote.remoteId).toBe("acme-99");
    expect((await store.get(hook.id, "c_1"))?.remoteUrl).toBe("https://acme.test/p/99");
  });

  it("does not re-deliver an unchanged article", async () => {
    const rx = receiver();
    const { hook } = target(rx.fetchImpl);
    await hook.publish(article);
    const second = await hook.publish(article);

    expect(second.status).toBe("unchanged");
    expect(rx.calls).toHaveLength(1);
  });

  it("re-delivers when the article changed", async () => {
    const rx = receiver();
    const { hook } = target(rx.fetchImpl);
    await hook.publish(article);
    const changed = normaliseArticle({ id: "c_1", title: "New", slug: "deposit-rules", blocks: [] });
    const second = await hook.publish(changed);

    expect(second.status).toBe("written");
    expect(second.status === "written" && second.action).toBe("updated");
    expect(rx.calls).toHaveLength(2);
  });

  // A receiver that answers nothing useful is normal — most webhooks return 204.
  // The delivery still has to be idempotent, so we fall back to our own id.
  it("works with a receiver that returns an empty 204", async () => {
    const rx = receiver(() => new Response(null, { status: 204 }));
    const { hook } = target(rx.fetchImpl);

    const outcome = await hook.publish(article);
    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.remote.remoteId).toBe("c_1");

    expect((await hook.publish(article)).status).toBe("unchanged");
  });
});

describe("WebhookTarget — failure modes", () => {
  it("treats 401 as permanent and does not record success", async () => {
    const rx = receiver(() => new Response("no", { status: 401 }));
    const { hook, store } = target(rx.fetchImpl);

    const outcome = await hook.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "unauthorized", retryable: false });
    expect(await store.get(hook.id, "c_1")).toBeNull();
  });

  it("treats 503 as retryable", async () => {
    const rx = receiver(() => new Response("later", { status: 503 }));
    const outcome = await target(rx.fetchImpl).hook.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "unreachable", retryable: true });
  });

  it("treats a refused connection as retryable", async () => {
    const rx = receiver(() => {
      throw new TypeError("fetch failed");
    });
    const outcome = await target(rx.fetchImpl).hook.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "unreachable", retryable: true });
  });

  it("treats a 422 as a payload the receiver will never accept", async () => {
    const rx = receiver(() => new Response(JSON.stringify({ message: "bad slug" }), { status: 422 }));
    const outcome = await target(rx.fetchImpl).hook.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "rejected", retryable: false });
  });

  it("keeps the previous hash when a re-delivery fails", async () => {
    const store = new InMemoryRemoteRefStore();
    const good = receiver();
    await target(good.fetchImpl, store).hook.publish(article);
    const before = await store.get("webhook:acme.test", "c_1");

    const bad = receiver(() => new Response("down", { status: 500 }));
    const changed = normaliseArticle({ id: "c_1", title: "New", slug: "deposit-rules", blocks: [] });
    const outcome = await target(bad.fetchImpl, store).hook.publish(changed);

    expect(outcome.status).toBe("failed");
    expect((await store.get("webhook:acme.test", "c_1"))?.contentHash).toBe(before?.contentHash);
  });

  it("refuses to send unsigned when no secret is configured", async () => {
    const rx = receiver();
    const outcome = await target(rx.fetchImpl, new InMemoryRemoteRefStore(), {
      secret: "",
    }).hook.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "config", retryable: false });
    expect(rx.calls).toHaveLength(0);
  });
});

describe("WebhookTarget — capabilities", () => {
  // The point of the second adapter: it is structurally different, so it must
  // declare different capabilities. A webhook has no media library.
  it("declares that it does not host media", () => {
    const rx = receiver();
    expect(target(rx.fetchImpl).hook.capabilities).toMatchObject({
      hostsMedia: false,
      bodyFormat: "both",
      update: true,
      categories: true,
      tags: true,
      structuredData: true,
    });
  });

  it("reports no degradation — everything the article carries is in the payload", async () => {
    const rx = receiver();
    const outcome = await target(rx.fetchImpl).hook.publish(article);
    expect(outcome.status === "written" && outcome.degraded).toEqual([]);
  });
});

describe("WebhookTarget — unpublish", () => {
  it("sends an unpublished event and clears the hash", async () => {
    const rx = receiver();
    const { hook, store } = target(rx.fetchImpl);
    await hook.publish(article);

    const outcome = await hook.unpublish({ id: "c_1", slug: "deposit-rules" });

    expect(outcome.status).toBe("written");
    const body = JSON.parse(String(rx.calls[1].init.body)) as { event: string };
    expect(body.event).toBe("unpublished");
    expect((await store.get(hook.id, "c_1"))?.contentHash).toBeNull();
  });

  it("is a no-op for an article that was never delivered", async () => {
    const rx = receiver();
    const outcome = await target(rx.fetchImpl).hook.unpublish({ id: "ghost", slug: "ghost" });
    expect(outcome.status).toBe("unchanged");
    expect(rx.calls).toHaveLength(0);
  });
});
