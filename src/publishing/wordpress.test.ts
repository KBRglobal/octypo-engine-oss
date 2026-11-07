import { describe, it, expect, vi, afterEach } from "vitest";

import { WordPressTarget } from "./wordpress.js";
import { normaliseArticle } from "./normalise.js";
import { InMemoryRemoteRefStore } from "./remote-ref-store.js";

// ============================================================================
// A fake WordPress, good enough to be wrong in the same ways the real one is.
// ============================================================================

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
  headers: Record<string, string>;
}

interface FakeOptions {
  /** Existing posts, keyed by numeric id. */
  posts?: Record<number, Record<string, unknown>>;
  categories?: Array<{ id: number; slug: string }>;
  tags?: Array<{ id: number; slug: string }>;
  media?: Record<number, Record<string, unknown>>;
  /** Force a response, keyed by "METHOD /path" fragment: returns [status, body]. */
  fail?: Record<string, [number, unknown]>;
  /** Paths whose fetch throws (network down). */
  offline?: string[];
  /** Simulate an install where the user lacks unfiltered_html. */
  stripsScripts?: boolean;
  credentials?: string;
}

const CREDS = "octypo:abcd efgh ijkl mnop qrst uvwx";
const EXPECTED_AUTH = "Basic " + Buffer.from("octypo:abcdefghijklmnopqrstuvwx").toString("base64");

function fakeWordPress(options: FakeOptions = {}) {
  const posts: Record<number, Record<string, unknown>> = { ...(options.posts ?? {}) };
  const media: Record<number, Record<string, unknown>> = { ...(options.media ?? {}) };
  const categories = [...(options.categories ?? [])];
  const tags = [...(options.tags ?? [])];
  const calls: Call[] = [];
  let nextPostId = 500;
  let nextMediaId = 900;
  let nextTermId = 30;

  const auth = options.credentials ?? EXPECTED_AUTH;

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ])
    );
    const bodyText = typeof init.body === "string" ? init.body : undefined;
    calls.push({
      method,
      path,
      body: bodyText ? JSON.parse(bodyText) : init.body,
      auth: headers.authorization,
      headers,
    });

    for (const fragment of options.offline ?? []) {
      if (path.includes(fragment) || url.host.includes(fragment)) {
        throw new TypeError("fetch failed");
      }
    }
    for (const [fragment, [status, body]] of Object.entries(options.fail ?? {})) {
      if (`${method} ${path}`.startsWith(fragment)) return json(body, status);
    }

    // The hero image lives on R2, not on WordPress.
    if (url.host !== "example.com") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }

    if (headers.authorization !== auth) {
      return json({ code: "rest_not_logged_in", message: "Not authenticated." }, 401);
    }

    if (url.pathname === "/wp-json/wp/v2/users/me") return json({ id: 1, name: "octypo" });

    if (url.pathname === "/wp-json/wp/v2/media" && method === "POST") {
      const id = nextMediaId++;
      media[id] = { id, source_url: `https://example.com/uploads/${id}.png` };
      return json(media[id], 201);
    }

    const mediaMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/media\/(\d+)$/);
    if (mediaMatch) {
      const item = media[Number(mediaMatch[1])];
      return item ? json(item) : json({ code: "rest_post_invalid_id" }, 404);
    }

    for (const [name, list] of [
      ["categories", categories],
      ["tags", tags],
    ] as const) {
      if (url.pathname !== `/wp-json/wp/v2/${name}`) continue;
      if (method === "GET") {
        const slug = url.searchParams.get("slug");
        return json(list.filter(term => term.slug === slug));
      }
      const created = { id: nextTermId++, slug: String((JSON.parse(bodyText ?? "{}") as { slug?: string }).slug) };
      list.push(created);
      return json(created, 201);
    }

    if (url.pathname === "/wp-json/wp/v2/posts" && method === "GET") {
      const slug = url.searchParams.get("slug");
      return json(Object.values(posts).filter(post => post.slug === slug));
    }

    if (url.pathname === "/wp-json/wp/v2/posts" && method === "POST") {
      const id = nextPostId++;
      posts[id] = store(id, JSON.parse(bodyText ?? "{}"));
      return json(posts[id], 201);
    }

    const postMatch = url.pathname.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
    if (postMatch) {
      const id = Number(postMatch[1]);
      if (!posts[id]) return json({ code: "rest_post_invalid_id", message: "Invalid post ID." }, 404);
      if (method === "GET") return json(posts[id]);
      posts[id] = store(id, { ...posts[id], ...JSON.parse(bodyText ?? "{}") });
      return json(posts[id]);
    }

    return json({ code: "rest_no_route" }, 404);
  };

  function store(id: number, payload: Record<string, unknown>): Record<string, unknown> {
    const raw = String(payload.content ?? "");
    // WordPress strips <script> from post_content unless the author has the
    // unfiltered_html capability — the exact reason JSON-LD injection is fragile.
    const content = options.stripsScripts ? raw.replace(/<script[\s\S]*?<\/script>/gi, "") : raw;
    return {
      ...payload,
      id,
      link: `https://example.com/?p=${id}`,
      content: { raw: content, rendered: content },
    };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  return { fetchImpl, calls, posts, media, categories, tags };
}

// ============================================================================

const article = normaliseArticle({
  id: "c_1",
  title: "Deposit rules explained",
  slug: "deposit-rules",
  summary: "What a landlord may keep.",
  heroImage: "https://pub-abc.r2.dev/guides/2026/deposit-rules-9f2a.png",
  heroImageAlt: "Keys on a contract",
  category: "guide",
  tags: ["deposits"],
  blocks: [
    { id: "h", type: "heading", data: { text: "What to expect", level: 2 } },
    { id: "t", type: "text", data: { content: "<p>Read the contract.</p>" } },
  ],
  seoSchema: [{ "@type": "Article", headline: "Deposit rules explained" }],
  publishedAt: new Date("2026-08-19T09:00:00.000Z"),
});

function target(fake: ReturnType<typeof fakeWordPress>, store = new InMemoryRemoteRefStore()) {
  return {
    store,
    wp: new WordPressTarget(
      {
        baseUrl: "https://example.com",
        username: "octypo",
        applicationPassword: CREDS.split(":")[1],
      },
      store,
      fake.fetchImpl as unknown as typeof fetch
    ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("WordPressTarget — creating a post", () => {
  it("creates the post with every field the customer's site needs", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.action).toBe("created");
    expect(outcome.remote.remoteId).toBe("500");
    expect(outcome.remote.remoteUrl).toBe("https://example.com/?p=500");

    const created = fake.posts[500];
    expect(created.title).toBe("Deposit rules explained");
    expect(created.slug).toBe("deposit-rules");
    expect(created.excerpt).toBe("What a landlord may keep.");
    expect(created.status).toBe("publish");
    expect(created.date_gmt).toBe("2026-08-19T09:00:00.000");
    expect(String((created.content as { raw: string }).raw)).toContain("<h2>What to expect</h2>");
  });

  it("authenticates with an application password over HTTP Basic", async () => {
    const fake = fakeWordPress();
    await target(fake).wp.publish(article);
    // Application passwords are displayed with spaces; WordPress ignores them
    // and a copy-paste that keeps them must still authenticate.
    expect(fake.calls.every(call => !call.path.startsWith("/wp-json") || call.auth === EXPECTED_AUTH)).toBe(
      true
    );
  });

  it("uploads the hero image and sets it as the featured image", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("written");
    const upload = fake.calls.find(c => c.method === "POST" && c.path === "/wp-json/wp/v2/media");
    expect(upload).toBeDefined();
    expect(upload?.headers["content-disposition"]).toBe(
      'attachment; filename="deposit-rules-9f2a.png"'
    );
    expect(fake.posts[500].featured_media).toBe(900);
  });

  it("injects the JSON-LD into the post content", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);
    await wp.publish(article);
    const raw = String((fake.posts[500].content as { raw: string }).raw);
    expect(raw).toContain('<script type="application/ld+json">');
    expect(raw).toContain('"headline":"Deposit rules explained"');
  });

  it("reuses an existing category and creates a missing tag", async () => {
    const fake = fakeWordPress({ categories: [{ id: 7, slug: "guide" }] });
    const { wp } = target(fake);
    await wp.publish(article);

    expect(fake.posts[500].categories).toEqual([7]);
    expect(fake.posts[500].tags).toEqual([30]);
    // The existing category must not be re-created — that is how a customer
    // ends up with "Guide", "Guide-2", "Guide-3".
    expect(fake.calls.filter(c => c.method === "POST" && c.path === "/wp-json/wp/v2/categories")).toHaveLength(
      0
    );
  });
});

describe("WordPressTarget — idempotency", () => {
  it("updates the same post instead of creating a second one", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);

    await wp.publish(article);
    const changed = normaliseArticle({
      id: "c_1",
      title: "Deposit rules explained (2026)",
      slug: "deposit-rules",
      blocks: [{ id: "t", type: "text", data: { content: "<p>Updated.</p>" } }],
    });
    const second = await wp.publish(changed);

    expect(second.status).toBe("written");
    if (second.status !== "written") return;
    expect(second.action).toBe("updated");
    expect(second.remote.remoteId).toBe("500");
    expect(Object.keys(fake.posts)).toEqual(["500"]);
    expect(fake.posts[500].title).toBe("Deposit rules explained (2026)");
  });

  it("does not rewrite the customer's post when nothing changed", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);
    await wp.publish(article);
    const writesBefore = fake.calls.filter(c => c.method === "POST").length;

    const second = await wp.publish(article);

    expect(second.status).toBe("unchanged");
    expect(fake.calls.filter(c => c.method === "POST")).toHaveLength(writesBefore);
  });

  // The reference store is a cache, not the truth. A restored database, a new
  // deployment, or a first run against a site the engine already fed must not
  // duplicate what is already there.
  it("adopts an existing post by slug when it holds no reference", async () => {
    const fake = fakeWordPress({
      posts: { 42: { id: 42, slug: "deposit-rules", title: "Old title", link: "https://example.com/?p=42" } },
    });
    const { wp } = target(fake);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.action).toBe("updated");
    expect(outcome.remote.remoteId).toBe("42");
    expect(Object.keys(fake.posts)).toEqual(["42"]);
  });

  it("does not re-upload the hero image on a republish", async () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);
    await wp.publish(article);
    await wp.publish(
      normaliseArticle({
        id: "c_1",
        title: "Changed",
        slug: "deposit-rules",
        heroImage: "https://pub-abc.r2.dev/guides/2026/deposit-rules-9f2a.png",
        blocks: [],
      })
    );
    expect(fake.calls.filter(c => c.method === "POST" && c.path === "/wp-json/wp/v2/media")).toHaveLength(
      1
    );
  });
});

describe("WordPressTarget — failure modes", () => {
  it("reports wrong credentials as permanent, and writes nothing", async () => {
    const fake = fakeWordPress({ credentials: "Basic something-else" });
    const { wp, store } = target(fake);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("unauthorized");
    // Retrying a revoked application password three times helps nobody.
    expect(outcome.retryable).toBe(false);
    expect(Object.keys(fake.posts)).toHaveLength(0);
    expect(await store.get(wp.id, "c_1")).toBeNull();
  });

  it("reports an unreachable WordPress as retryable", async () => {
    const fake = fakeWordPress({ offline: ["/wp-json"] });
    const { wp } = target(fake);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("unreachable");
    expect(outcome.retryable).toBe(true);
  });

  it("treats a 500 from WordPress as unreachable, not as a rejected article", async () => {
    const fake = fakeWordPress({ fail: { "POST /wp-json/wp/v2/posts": [502, "<html>Bad gateway</html>"] } });
    const outcome = await target(fake).wp.publish(article);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("unreachable");
    expect(outcome.retryable).toBe(true);
  });

  it("reports a rejected payload as permanent", async () => {
    const fake = fakeWordPress({
      fail: { "POST /wp-json/wp/v2/posts": [400, { code: "rest_invalid_param", message: "Invalid slug." }] },
    });
    const outcome = await target(fake).wp.publish(article);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("rejected");
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain("Invalid slug.");
  });

  // The nastiest of the four: the image is in the customer's media library, the
  // post is not. A naive retry uploads it again and leaves orphans behind.
  it("remembers the uploaded image when the post write fails, and reuses it on retry", async () => {
    const failing = fakeWordPress({
      fail: { "POST /wp-json/wp/v2/posts": [502, "gateway"] },
    });
    const store = new InMemoryRemoteRefStore();
    const first = await target(failing, store).wp.publish(article);

    expect(first.status).toBe("failed");
    const ref = await store.get("wordpress:example.com", "c_1");
    expect(ref?.mediaId).toBe("900");
    // Nothing may claim the article is live.
    expect(ref?.remoteId).toBeNull();
    expect(ref?.contentHash).toBeNull();

    const healthy = fakeWordPress({ media: { 900: { id: 900, source_url: "https://x/900.png" } } });
    const second = await target(healthy, store).wp.publish(article);

    expect(second.status).toBe("written");
    expect(
      healthy.calls.filter(c => c.method === "POST" && c.path === "/wp-json/wp/v2/media")
    ).toHaveLength(0);
    expect(healthy.posts[500].featured_media).toBe(900);
  });

  it("does not publish a post without its hero image when the upload fails", async () => {
    const fake = fakeWordPress({ fail: { "POST /wp-json/wp/v2/media": [500, "boom"] } });
    const outcome = await target(fake).wp.publish(article);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("media_failed");
    expect(outcome.retryable).toBe(true);
    // Half a publish on a live site is worse than no publish; the queue retries.
    expect(Object.keys(fake.posts)).toHaveLength(0);
  });

  it("reports a hero image the engine itself cannot fetch", async () => {
    const fake = fakeWordPress({ offline: ["pub-abc.r2.dev"] });
    const outcome = await target(fake).wp.publish(article);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("media_failed");
  });

  it("recreates a post that was deleted on the WordPress side", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "wordpress:example.com",
      articleId: "c_1",
      remoteId: "412",
      remoteUrl: "https://example.com/?p=412",
      mediaId: null,
      contentHash: "stale",
      updatedAt: new Date(0),
    });
    const fake = fakeWordPress();
    const { wp } = target(fake, store);

    const outcome = await wp.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.action).toBe("created");
    expect(outcome.remote.remoteId).toBe("500");
    expect((await store.get(wp.id, "c_1"))?.remoteId).toBe("500");
  });

  // A deleted post whose stored hash still matches must not be reported as
  // "unchanged" — that is the engine claiming success for content that is gone.
  it("never answers 'unchanged' for a post that no longer exists", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "wordpress:example.com",
      articleId: "c_1",
      remoteId: "412",
      remoteUrl: null,
      mediaId: null,
      contentHash: article.contentHash,
      updatedAt: new Date(0),
    });
    const fake = fakeWordPress();
    const outcome = await target(fake, store).wp.publish(article);
    expect(outcome.status).toBe("written");
  });

  it("leaves the stored reference untouched when an update fails", async () => {
    const store = new InMemoryRemoteRefStore();
    const healthy = fakeWordPress();
    await target(healthy, store).wp.publish(article);
    const before = await store.get("wordpress:example.com", "c_1");

    const broken = fakeWordPress({
      posts: healthy.posts,
      media: healthy.media,
      fail: { "POST /wp-json/wp/v2/posts/500": [503, "down"] },
    });
    const changed = normaliseArticle({ id: "c_1", title: "New", slug: "deposit-rules", blocks: [] });
    const outcome = await target(broken, store).wp.publish(changed);

    expect(outcome.status).toBe("failed");
    // The hash must still describe what is actually on the site.
    expect((await store.get("wordpress:example.com", "c_1"))?.contentHash).toBe(
      before?.contentHash
    );
  });

  it("never throws, whatever WordPress returns", async () => {
    const fake = fakeWordPress();
    const wp = new WordPressTarget(
      { baseUrl: "https://example.com", username: "octypo", applicationPassword: "x" },
      new InMemoryRemoteRefStore(),
      (async () => new Response("<html>not json</html>", { status: 200 })) as unknown as typeof fetch
    );
    await expect(wp.publish(article)).resolves.toMatchObject({ status: "failed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses to start when it is not configured", async () => {
    const wp = new WordPressTarget(
      { baseUrl: "", username: "", applicationPassword: "" },
      new InMemoryRemoteRefStore()
    );
    const outcome = await wp.publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "config", retryable: false });
  });
});

describe("WordPressTarget — degradation", () => {
  it("reports JSON-LD that WordPress silently stripped", async () => {
    const fake = fakeWordPress({ stripsScripts: true });
    const outcome = await target(fake).wp.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    // The post is live and correct apart from this, so it is a degradation and
    // not a failure — but it must never pass unreported.
    expect(outcome.degraded.map(d => d.feature)).toContain("structuredData");
  });

  // Many installs let an editor write posts but not create terms. Failing the
  // whole publish would leave the article unpublished over a tag; dropping the
  // tag silently is how a customer ends up with 400 uncategorised articles.
  it("still publishes when the site forbids creating a tag, and says the tag was lost", async () => {
    const fake = fakeWordPress({ fail: { "POST /wp-json/wp/v2/tags": [403, { message: "Sorry." }] } });
    const outcome = await target(fake).wp.publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") return;
    expect(outcome.degraded.map(d => d.feature)).toContain("tags");
    expect(fake.posts[500].tags).toEqual([]);
  });

  it("declares what a WordPress site can do", () => {
    const fake = fakeWordPress();
    const { wp } = target(fake);
    expect(wp.capabilities).toMatchObject({
      update: true,
      hostsMedia: true,
      categories: true,
      tags: true,
      excerpt: true,
      structuredData: true,
      bodyFormat: "html",
    });
  });
});

describe("WordPressTarget — check and unpublish", () => {
  it("confirms working credentials without writing anything", async () => {
    const fake = fakeWordPress();
    await expect(target(fake).wp.check()).resolves.toEqual({ ok: true });
    expect(fake.calls.every(c => c.method === "GET")).toBe(true);
  });

  it("reports bad credentials from check", async () => {
    const fake = fakeWordPress({ credentials: "Basic nope" });
    await expect(target(fake).wp.check()).resolves.toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("withdraws a post to draft rather than deleting the customer's content", async () => {
    const fake = fakeWordPress();
    const { wp, store } = target(fake);
    await wp.publish(article);

    const outcome = await wp.unpublish({ id: "c_1", slug: "deposit-rules" });

    expect(outcome.status).toBe("written");
    expect(fake.posts[500].status).toBe("draft");
    expect((await store.get(wp.id, "c_1"))?.contentHash).toBeNull();
  });

  it("unpublishing something never published is a no-op, not an error", async () => {
    const fake = fakeWordPress();
    const outcome = await target(fake).wp.unpublish({ id: "ghost", slug: "ghost" });
    expect(outcome.status).toBe("unchanged");
  });
});
