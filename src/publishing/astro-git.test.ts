import { describe, it, expect, vi } from "vitest";

import { AstroGitTarget, type AstroGitArea, type AstroGitConfig } from "./astro-git.js";
import { normaliseArticle } from "./normalise.js";
import { InMemoryRemoteRefStore } from "./remote-ref-store.js";

vi.mock("../images/article-image-set.js", () => ({
  deriveArticleImageSet: vi.fn(async (_url: string, slug: string) => ({
    share: `https://pub.test/articles/${slug}-share.webp`,
    card: `https://pub.test/articles/${slug}-1200.webp`,
    thumb: `https://pub.test/articles/${slug}-640.webp`,
  })),
}));

const FAKE_R2 = {
  bucket: "b",
  publicBase: "https://pub.test",
  endpoint: "https://x.r2.cloudflarestorage.com",
  accessKeyId: "k",
  secretAccessKey: "s",
};

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://example.com/</loc>\n    <lastmod>2026-09-09</lastmod>\n  </url>\n</urlset>\n`;

const article = normaliseArticle({
  id: "c_1",
  title: "New hotels in the city",
  slug: "new-city-hotels",
  summary: "What opened last quarter.",
  heroImage: "https://pub.test/guides/hero.webp",
  heroImageAlt: "A new city hotel",
  category: "hotels",
  blocks: [
    { id: "h1", type: "heading", data: { text: "What is new?", level: 2 } },
    { id: "t1", type: "text", data: { content: "<p>Opening paragraph.</p>" } },
  ],
  publishedAt: new Date("2026-09-10T09:00:00.000Z"),
});

interface Recorded {
  url: string;
  init: RequestInit;
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function notFound() {
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}

/**
 * A minimal fake of the bits of the GitHub REST + Git Data API that
 * AstroGitTarget calls: the sitemap read (Contents API), then the five-call
 * Git Data API dance (ref -> commit -> blobs -> tree -> commit -> ref update).
 */
function githubApi(options: { sitemap?: string | null; refFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  let blobCount = 0;
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const method = init.method ?? "GET";

    if (url.includes("/contents/public/sitemap.xml")) {
      if (options.sitemap === null) return notFound();
      return ok({ content: Buffer.from(options.sitemap ?? SITEMAP_XML, "utf8").toString("base64") });
    }
    if (url.includes("/git/ref/heads/")) {
      if (options.refFails) return notFound();
      return ok({ object: { sha: "base-commit-sha" } });
    }
    if (url.includes("/git/commits/base-commit-sha")) {
      return ok({ sha: "base-commit-sha", tree: { sha: "base-tree-sha" } });
    }
    if (method === "POST" && url.endsWith("/git/blobs")) {
      blobCount += 1;
      return ok({ sha: `blob-sha-${blobCount}` });
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      return ok({ sha: "new-tree-sha" });
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      return ok({ sha: "new-commit-sha" });
    }
    if (method === "PATCH" && url.includes("/git/refs/heads/")) {
      return ok({ object: { sha: "new-commit-sha" } });
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

const AREAS: Record<string, AstroGitArea> = {
  hotels: { category: "holiday", hubHref: "/hotels/", hubTitle: "Hotels" },
  events: { category: "city", hubHref: "/events/", hubTitle: "Events" },
};

function target(
  fetchImpl: typeof fetch,
  store = new InMemoryRemoteRefStore(),
  overrides: Partial<AstroGitConfig> = {}
) {
  return new AstroGitTarget(
    {
      owner: "example-org",
      repo: "example-site",
      branch: "main",
      token: "gh_tok",
      contentDir: "src/content/articles",
      siteOrigin: "https://example.com",
      areas: AREAS,
      ...overrides,
    },
    store,
    fetchImpl,
    FAKE_R2
  );
}

function blobContentAt(calls: Recorded[], nth: number): string {
  const blobCalls = calls.filter(c => c.init.method === "POST" && c.url.endsWith("/git/blobs"));
  const payload = JSON.parse(String(blobCalls[nth].init.body)) as { content: string; encoding: string };
  return Buffer.from(payload.content, "base64").toString("utf8");
}

describe("AstroGitTarget — creating a new article", () => {
  it("commits the article Markdown and the sitemap update atomically, in one tree", async () => {
    const api = githubApi();
    const outcome = await target(api.fetchImpl).publish(article);

    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") throw new Error("expected written");
    expect(outcome.action).toBe("created");
    expect(outcome.remote.remoteUrl).toBe("https://example.com/articles/new-city-hotels/");

    // Exactly one commit + one ref update — never two separate commits that
    // could leave the article and the sitemap out of sync with each other.
    expect(api.calls.filter(c => c.url.endsWith("/git/commits") && c.init.method === "POST")).toHaveLength(1);
    expect(api.calls.filter(c => c.url.includes("/git/refs/heads/") && c.init.method === "PATCH")).toHaveLength(1);

    const treeCall = api.calls.find(c => c.url.endsWith("/git/trees"))!;
    const treePayload = JSON.parse(String(treeCall.init.body)) as {
      base_tree: string;
      tree: { path: string }[];
    };
    expect(treePayload.base_tree).toBe("base-tree-sha");
    expect(treePayload.tree.map(t => t.path).sort()).toEqual(
      ["public/sitemap.xml", "src/content/articles/new-city-hotels.md"].sort()
    );

    const markdown = blobContentAt(api.calls, 0);
    expect(markdown).toContain("## What is new?");
    expect(markdown).toMatch(/^---\n\{/);
    expect(markdown).toContain('"draft": true'); // no verifiable source → stays a draft on the site
    expect(markdown).toContain('"category": "holiday"'); // "hotels" maps to "holiday"
    expect(markdown).toContain("new-city-hotels-share.webp");

    const frontMatter = JSON.parse(markdown.split("---\n")[1]) as {
      related: { title: string; href: string }[];
    };
    expect(frontMatter.related[0]).toEqual({ title: "Hotels", href: "/hotels/" });
    expect(frontMatter.related.some(r => r.href === "/topics/")).toBe(true);

    const sitemap = blobContentAt(api.calls, 1);
    expect(sitemap).toContain("<loc>https://example.com/articles/new-city-hotels/</loc>");
    expect(sitemap).toContain("<loc>https://example.com/</loc>"); // original entry preserved
  });

  it("leaves draft behind when the article carries a real source: reviewed content with dates and sources", async () => {
    const sourced = normaliseArticle({
      id: "c_3",
      title: "A night at the opera",
      slug: "opera-night",
      category: "events",
      blocks: [{ id: "t1", type: "text", data: { content: "<p>Body.</p>" } }],
      sourceUrl: "https://news.example.org/story",
      sourceName: "Example News",
      publishedAt: new Date("2026-09-11T10:00:00.000Z"),
    });
    const api = githubApi();
    await target(api.fetchImpl).publish(sourced);

    const markdown = blobContentAt(api.calls, 0);
    const frontMatter = JSON.parse(markdown.split("---\n")[1]) as Record<string, unknown>;
    expect(frontMatter.draft).toBe(false);
    expect(frontMatter.publishedAt).toBe("2026-09-11");
    expect(frontMatter.reviewedAt).toBe("2026-09-11");
    expect(frontMatter.sources).toEqual([{ title: "Example News", url: "https://news.example.org/story" }]);
    // Events have their own hub, not the attractions one.
    expect((frontMatter.related as { href: string }[])[0].href).toBe("/events/");
    expect(markdown).toContain('href="https://news.example.org/story"');
  });

  it("maps an unrecognised topic to the configured default category rather than failing", async () => {
    const other = normaliseArticle({
      id: "c_2",
      title: "Some title",
      slug: "some-slug",
      category: "something-unmapped",
      blocks: [],
    });
    const api = githubApi();
    const outcome = await target(api.fetchImpl, undefined, { defaultCategory: "city" }).publish(other);
    expect(outcome.status).toBe("written");

    const markdown = blobContentAt(api.calls, 0);
    expect(markdown).toContain('"category": "city"');
  });

  it("uses the article's own category when no area or default is configured", async () => {
    const api = githubApi();
    await target(api.fetchImpl, undefined, { areas: undefined }).publish(article);

    const frontMatter = JSON.parse(blobContentAt(api.calls, 0).split("---\n")[1]) as Record<string, unknown>;
    expect(frontMatter.category).toBe("hotels");
    expect(frontMatter.related).toEqual([{ title: "All topics", href: "/topics/" }]);
  });

  it("writes English page text by default and no direction fields on a left-to-right site", async () => {
    const sourced = normaliseArticle({
      id: "c_4",
      title: "Plain title",
      slug: "plain-title",
      heroImage: "https://pub.test/guides/hero.webp",
      blocks: [],
      sourceUrl: "https://news.example.org/story",
      sourceName: "Example News",
    });
    const api = githubApi();
    await target(api.fetchImpl).publish(sourced);

    const markdown = blobContentAt(api.calls, 0);
    const frontMatter = JSON.parse(markdown.split("---\n")[1]) as Record<string, any>;
    expect(frontMatter.author).toBe("Editorial team");
    expect(frontMatter.image.alt).toBe("Illustration for: Plain title");
    expect(frontMatter.image.caption).toBe("Illustrative image, generated with AI.");
    expect(markdown).toContain("**Source:** <a href");
    expect(frontMatter).not.toHaveProperty("dir");
    expect(frontMatter).not.toHaveProperty("lang");
  });

  it("derives the text direction from the site's language and takes its copy from config", async () => {
    const sourced = normaliseArticle({
      id: "c_5",
      title: "\u0641\u0646\u0627\u062f\u0642",
      slug: "arabic-site",
      blocks: [],
      sourceUrl: "https://news.example.org/story",
      sourceName: "Example News",
    });
    const api = githubApi();
    await target(api.fetchImpl, undefined, {
      language: "ar",
      copy: { author: "\u0627\u0644\u062a\u062d\u0631\u064a\u0631", sourceLabel: "\u0627\u0644\u0645\u0635\u062f\u0631" },
    }).publish(sourced);

    const markdown = blobContentAt(api.calls, 0);
    const frontMatter = JSON.parse(markdown.split("---\n")[1]) as Record<string, unknown>;
    expect(frontMatter.dir).toBe("rtl");
    expect(frontMatter.lang).toBe("ar");
    expect(frontMatter.author).toBe("\u0627\u0644\u062a\u062d\u0631\u064a\u0631");
    expect(markdown).toContain("**\u0627\u0644\u0645\u0635\u062f\u0631:** <a href");
  });

  it("keeps a non-Latin slug as a distinct filename", async () => {
    const japanese = normaliseArticle({
      id: "c_6",
      title: "\u6771\u4eac\u306e\u30db\u30c6\u30eb",
      slug: "\u6771\u4eac\u306e\u30db\u30c6\u30eb",
      blocks: [],
    });
    const api = githubApi();
    await target(api.fetchImpl).publish(japanese);

    const treeCall = api.calls.find(c => c.url.endsWith("/git/trees"))!;
    const tree = (JSON.parse(String(treeCall.init.body)) as { tree: { path: string }[] }).tree;
    expect(tree.map(e => e.path)).toContain("src/content/articles/\u6771\u4eac\u306e\u30db\u30c6\u30eb.md");
  });

  it("updates an existing sitemap <lastmod> in place instead of duplicating the <url> block", async () => {
    const existingSitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>https://example.com/articles/new-city-hotels/</loc>\n    <lastmod>2026-01-01</lastmod>\n  </url>\n</urlset>\n`;
    const api = githubApi({ sitemap: existingSitemap });
    await target(api.fetchImpl).publish(article);

    const sitemap = blobContentAt(api.calls, 1);
    const occurrences = sitemap.split("<loc>https://example.com/articles/new-city-hotels/</loc>").length - 1;
    expect(occurrences).toBe(1);
    expect(sitemap).not.toContain("2026-01-01");
  });
});

describe("AstroGitTarget — idempotency", () => {
  it("skips the GitHub round-trip entirely when the content hash is unchanged", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "astro-git:example-org/example-site",
      articleId: article.id,
      remoteId: "src/content/articles/new-city-hotels.md",
      remoteUrl: "https://example.com/articles/new-city-hotels/",
      mediaId: null,
      contentHash: `${article.contentHash}:3`,
      updatedAt: new Date(),
    });
    const api = githubApi();
    const outcome = await target(api.fetchImpl, store).publish(article);

    expect(outcome.status).toBe("unchanged");
    expect(api.calls.length).toBe(0);
  });

  it("rewrites a live article whose text is unchanged when the delivery format moved on", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "astro-git:example-org/example-site",
      articleId: article.id,
      remoteId: "src/content/articles/new-city-hotels.md",
      remoteUrl: "https://example.com/articles/new-city-hotels/",
      mediaId: null,
      contentHash: article.contentHash, // stored by the previous format
      updatedAt: new Date(),
    });
    const api = githubApi();
    const outcome = await target(api.fetchImpl, store).publish(article);
    expect(outcome.status).toBe("written");
  });

  it('reports "updated" when a RemoteRef already exists for this article', async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "astro-git:example-org/example-site",
      articleId: article.id,
      remoteId: "src/content/articles/new-city-hotels.md",
      remoteUrl: "https://example.com/articles/new-city-hotels/",
      mediaId: null,
      contentHash: "stale-hash",
      updatedAt: new Date(),
    });
    const api = githubApi();
    const outcome = await target(api.fetchImpl, store).publish(article);
    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") throw new Error("expected written");
    expect(outcome.action).toBe("updated");
  });
});

describe("AstroGitTarget — failure shapes", () => {
  it("never writes when the config is incomplete", async () => {
    const outcome = await new AstroGitTarget(
      { owner: "", repo: "", branch: "main", token: "", contentDir: "x", siteOrigin: "" },
      new InMemoryRemoteRefStore()
    ).publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "config", retryable: false });
  });

  it("blocks the publish when the hero image cannot be re-derived", async () => {
    const { deriveArticleImageSet } = await import("../images/article-image-set.js");
    vi.mocked(deriveArticleImageSet).mockResolvedValueOnce(null);
    const api = githubApi();
    const outcome = await target(api.fetchImpl).publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "media_failed" });
    // No GitHub write should have been attempted once the image failed.
    expect(api.calls.length).toBe(0);
  });

  it("fails cleanly (never a partial write) when the sitemap can't be read", async () => {
    const api = githubApi({ sitemap: null });
    const outcome = await target(api.fetchImpl).publish(article);
    expect(outcome).toMatchObject({ status: "failed", code: "unreachable" });
    expect(api.calls.some(c => c.url.endsWith("/git/blobs"))).toBe(false);
  });

  it("fails cleanly when the branch ref can't be read (no commit attempted)", async () => {
    const api = githubApi({ refFails: true });
    const outcome = await target(api.fetchImpl).publish(article);
    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.retryable).toBe(false); // "not_found" from a 404 is not retryable
    expect(api.calls.some(c => c.url.endsWith("/git/blobs"))).toBe(false);
  });

  it("does not support unpublish", async () => {
    const outcome = await target(githubApi().fetchImpl).unpublish({
      id: article.id,
      slug: article.slug,
    });
    expect(outcome).toMatchObject({ status: "failed", code: "unsupported" });
  });
});

describe("AstroGitTarget — renaming a slug", () => {
  it("deletes the old file, swaps the sitemap entry and leaves a 301, all in one commit", async () => {
    const store = new InMemoryRemoteRefStore();
    await store.put({
      targetId: "astro-git:example-org/example-site",
      articleId: article.id,
      remoteId: "src/content/articles/old-slug.md",
      remoteUrl: "https://example.com/articles/old-slug/",
      mediaId: null,
      contentHash: "stale",
      updatedAt: new Date(),
    });
    const sitemap = SITEMAP_XML.replace(
      "</urlset>",
      "  <url>\n    <loc>https://example.com/articles/old-slug/</loc>\n    <lastmod>2026-09-15</lastmod>\n  </url>\n</urlset>"
    );
    const base = githubApi({ sitemap });
    const fetchImpl = (async (input: string, init: RequestInit = {}) => {
      if (String(input).includes("/contents/public/_redirects")) {
        return ok({ content: Buffer.from("/apps/ /articles/apps-guide/ 301\n", "utf8").toString("base64") });
      }
      return base.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const outcome = await target(fetchImpl, store).publish(article);
    expect(outcome.status).toBe("written");
    if (outcome.status !== "written") throw new Error("expected written");
    expect(outcome.action).toBe("updated");
    expect(outcome.remote.remoteId).toBe("src/content/articles/new-city-hotels.md");
    expect(outcome.degraded.find(d => d.feature === "redirects")).toBeUndefined();

    const treeCall = base.calls.find(c => c.url.endsWith("/git/trees"))!;
    const tree = (JSON.parse(String(treeCall.init.body)) as { tree: { path: string; sha: string | null }[] }).tree;
    expect(tree.find(e => e.path === "src/content/articles/old-slug.md")?.sha).toBeNull();
    expect(tree.find(e => e.path === "src/content/articles/new-city-hotels.md")?.sha).toMatch(/^blob-sha-/);
    expect(tree.find(e => e.path === "public/_redirects")).toBeDefined();

    const blobs = base.calls.filter(c => c.init.method === "POST" && c.url.endsWith("/git/blobs")).map(c => Buffer.from((JSON.parse(String(c.init.body)) as { content: string }).content, "base64").toString("utf8"));
    const newSitemap = blobs.find(b => b.includes("<urlset"))!;
    expect(newSitemap).not.toContain("old-slug");
    expect(newSitemap).toContain("https://example.com/articles/new-city-hotels/");
    const redirects = blobs.find(b => b.includes("/apps/"))!;
    expect(redirects).toContain("/articles/old-slug/ /articles/new-city-hotels/ 301");
    expect(base.calls.filter(c => c.url.endsWith("/git/commits") && c.init.method === "POST")).toHaveLength(1);
    const commitBody = base.calls.find(c => c.url.endsWith("/git/commits") && c.init.method === "POST")!;
    expect(String(commitBody.init.body)).toContain("move old-slug.md");
  });
});
