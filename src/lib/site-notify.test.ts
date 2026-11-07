import { describe, it, expect, vi, afterEach } from "vitest";

import { notifyBlog, defaultNotifyTarget } from "./site-notify.js";
import { verifyPurgeSignature, SIGNATURE_HEADER } from "./site-webhook.js";

const target = { url: "https://acme.octypo.blog/api/purge", secret: "shhh" };
const article = { slug: "deposit-rules", updatedAt: new Date("2026-08-19T09:00:00.000Z") };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("notifyBlog", () => {
  it("POSTs a signed payload the blog can verify", async () => {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    });

    await expect(notifyBlog("published", article, "t_acme", target)).resolves.toBe(true);

    const [url, init] = calls[0];
    expect(url).toBe(target.url);
    expect(init.method).toBe("POST");
    const signature = (init.headers as Record<string, string>)[SIGNATURE_HEADER];
    expect(verifyPurgeSignature(String(init.body), signature, target.secret)).toBe(true);
  });

  it("carries the tenant, event and slug so the blog knows what to purge", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(null, { status: 204 });
    });
    await notifyBlog("deleted", article, "t_acme", target);
    expect(JSON.parse(body)).toEqual({
      tenantId: "t_acme",
      event: "deleted",
      slug: "deposit-rules",
      updatedAt: "2026-08-19T09:00:00.000Z",
    });
  });

  // A publish that fails because a customer's blog is down is worse than a blog
  // that is five minutes stale — the reconcile cron already covers stale.
  it("never throws when the blog is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(notifyBlog("published", article, "t_acme", target)).resolves.toBe(false);
  });

  it("never throws when the blog rejects the request", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(notifyBlog("published", article, "t_acme", target)).resolves.toBe(false);
  });

  it("does nothing at all, silently, when no blog is configured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(notifyBlog("published", article, "t_acme", null)).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends an abort signal so a hanging blog cannot stall a publish", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(null, { status: 204 });
    });
    await notifyBlog("published", article, "t_acme", target);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("defaultNotifyTarget", () => {
  it("is null unless both the URL and the secret are set", () => {
    vi.stubEnv("BLOG_PURGE_URL", "");
    vi.stubEnv("BLOG_PURGE_SECRET", "");
    expect(defaultNotifyTarget()).toBeNull();

    vi.stubEnv("BLOG_PURGE_URL", "https://x.dev/api/purge");
    expect(defaultNotifyTarget()).toBeNull();

    vi.stubEnv("BLOG_PURGE_SECRET", "s");
    expect(defaultNotifyTarget()).toEqual({ url: "https://x.dev/api/purge", secret: "s" });
  });
});
