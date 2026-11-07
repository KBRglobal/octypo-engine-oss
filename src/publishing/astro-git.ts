/**
 * Astro/git publishing target — for a customer whose site is not a CMS at
 * all, but a static Astro site built from a git content collection and
 * deployed on push (Cloudflare Pages, for example).
 *
 * There is no post to create, no media library, no taxonomy API. "Publish"
 * means: write one Markdown file with JSON front matter into the customer's
 * repo, in the exact shape their `content.config.ts` zod schema expects, and
 * commit it. The site's own build+deploy pipeline (untouched, unaware this
 * exists) takes it from there.
 *
 * Two things this target owns that no other target needs to:
 *
 *  - **Front matter, not a CMS payload.** `article.html` is not written
 *    anywhere. A site like this keeps hand-authored Markdown with real `##`
 *    headings (its TOC/heading extraction depends on real CommonMark headings,
 *    not embedded `<h2>`) and raw HTML embedded inline for anything richer
 *    (figures, CTA buttons), so the delivered files read the same way as a
 *    hand-written one.
 *
 *  - **Image re-derivation.** The engine generates one hero image at
 *    whatever aspect ratio gpt-image-1 produced. This site's design wants a
 *    fixed OG crop plus a fixed-aspect card image and its small responsive
 *    variant — see `deriveArticleImageSet`. A hero the customer's schema
 *    cannot validate is worse than no hero, so a failed derivation blocks the
 *    publish (`media_failed`) the same way a failed image upload blocks
 *    WordPress.
 *
 * `draft: true` is written on every delivered article on purpose — every
 * hand-written article on this site carries it too; TopicView renders
 * regardless of the flag, and `draft: true` skips the schema's stricter
 * "approved content" validation (author + publish/review dates + sources)
 * that this pipeline has no clean data for yet.
 *
 * Everything site-specific is configuration: the words this target adds to a
 * page (`copy`, English by default), the topic-to-hub routing (`areas`) and the
 * site's language, which also decides the text direction.
 */

import { describeDegradation } from "./capabilities.js";
import { request, type FetchLike } from "./http.js";
import { renderBlock } from "./normalise.js";
import { r2ConfigFromEnv, type R2Config } from "../images/r2-upload.js";
import { deriveArticleImageSet } from "../images/article-image-set.js";
import type { ContentBlock } from "../schema/index.js";
import type {
  Degradation,
  NormalisedArticle,
  PublishOutcome,
  PublishingTarget,
  RemoteRef,
  TargetCapabilities,
  TargetCheck,
} from "./types.js";
import { capabilities, failed, RETRYABLE } from "./types.js";
import type { RemoteRefStore } from "./remote-ref-store.js";
import { textDirection } from "./text-direction.js";

export interface AstroGitConfig {
  /** e.g. "example-org" */
  owner: string;
  /** e.g. "example-site" */
  repo: string;
  /** Branch the site builds from. */
  branch: string;
  /** A GitHub token with contents:write on the repo. */
  token: string;
  /** Repo-relative directory the content collection loads from. */
  contentDir: string;
  /** Site origin, for the RemoteRef URL only — e.g. "https://example.com" */
  siteOrigin: string;
  /** Repo-relative path to the sitemap the build validates against. Set "" to skip updating it. */
  sitemapPath?: string;
  /**
   * Repo-relative path to the host's redirect rules (Cloudflare Pages /
   * Netlify `_redirects` format). A slug rename appends a 301 there; absent
   * or "" means renames leave no redirect (and the log says so).
   */
  redirectsPath?: string;
  /** BCP 47 tag of the site's language. Decides the text direction. Defaults to "en". */
  language?: string;
  /** Replaces any of the words this target adds to a page. */
  copy?: Partial<AstroGitCopy>;
  /** Free-text topic tag, lowercased, to the site area it belongs to. */
  areas?: Record<string, AstroGitArea>;
  /**
   * The `category` for a topic with no area. Set it when the site validates
   * categories against an enum; unset, the article's own category slug is used.
   */
  defaultCategory?: string;
  timeoutMs?: number;
}

export interface AstroGitCopy {
  author: string;
  /** `{title}` is replaced with the article title. */
  imageAlt: string;
  imageCaption: string;
  sourceLabel: string;
  topicsHubTitle: string;
}

/**
 * One place maps a free-text topic tag (from an RSS feed's `category` or a
 * manually created idea) onto everything the delivered article needs to land on
 * the right part of the site: the `category` its content.config.ts validates
 * against, and the hub page it should show up on. Hub listings can be relational
 * (an article appears on a hub because its own `related` links point at it), so
 * setting this is what makes the article appear there at all, not just exist at
 * an orphaned /articles/ URL.
 */
export interface AstroGitArea {
  category: string;
  hubHref: string;
  hubTitle: string;
}

const DEFAULT_COPY: AstroGitCopy = {
  author: "Editorial team",
  imageAlt: "Illustration for: {title}",
  imageCaption: "Illustrative image, generated with AI.",
  sourceLabel: "Source",
  topicsHubTitle: "All topics",
};

const TOPICS_HUB_HREF = "/topics/";
const FALLBACK_CATEGORY = "general";

/**
 * Bumped whenever the Markdown this target writes changes shape (frontmatter
 * fields, hub routing, body layout). Part of the stored content hash, so
 * every live article is rewritten on its next delivery instead of only the
 * ones whose text changed.
 */
const ASTRO_FORMAT_VERSION = 3;

function sourceLabelFor(source: { url: string; name: string | null }): string {
  if (source.name) return source.name;
  try {
    return new URL(source.url).hostname.replace(/^www\./, "");
  } catch {
    return source.url;
  }
}

/** Letters and digits of any script stay, so a non-Latin slug keeps a distinct filename. */
function slugifyFilename(slug: string): string {
  return slug.replace(/[^\p{L}\p{M}\p{N}-]/gu, "-").toLowerCase();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

/**
 * The FAQ as structured data for the site's FAQPage schema. The readable
 * version still goes into the body via renderBlock; without this, the FAQ
 * block is visible text with no schema behind it, which search engines
 * treat as thin.
 */
function extractFaq(blocks: ContentBlock[]): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const block of blocks) {
    if (block?.type !== "faq") continue;
    const items = Array.isArray(block.data?.items) ? block.data.items : [];
    for (const item of items) {
      const record = item as { question?: unknown; answer?: unknown } | null;
      const question = typeof record?.question === "string" ? stripTags(record.question) : "";
      const answer = typeof record?.answer === "string" ? stripTags(record.answer) : "";
      if (question && answer) out.push({ question, answer });
    }
  }
  return out;
}

/** Headings become real CommonMark `##`; everything else reuses the tested HTML block renderer. */
function renderMarkdownBody(blocks: ContentBlock[]): string {
  return blocks
    .map(block => {
      if (block?.type === "heading") {
        const text = stripTags(
          (typeof block.data?.text === "string" && block.data.text) ||
            (typeof block.data?.content === "string" && block.data.content) ||
            ""
        );
        if (!text) return "";
        const raw = Number(block.data?.level);
        const level = Number.isFinite(raw) ? Math.min(4, Math.max(2, Math.trunc(raw))) : 2;
        return `${"#".repeat(level)} ${text}`;
      }
      return renderBlock(block);
    })
    .filter(text => text !== "")
    .join("\n\n");
}

/** One JSON value per line inside the `---` front-matter fence, matching the site's existing files. */
function buildFrontMatter(fields: Record<string, unknown>): string {
  return `---\n${JSON.stringify(fields, null, 2)}\n---`;
}

/**
 * A site's build can hard-fail if a real, indexable page isn't listed in
 * public/sitemap.xml, so a delivered article that skips this either breaks the
 * next deploy (this article missing) or breaks it later (a stale entry from an
 * edit that changed the url). Insert is idempotent: republishing the same slug updates its <lastmod> in place
 * rather than duplicating the <url> block.
 */
function updateSitemapXml(xml: string, url: string, lastmod: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingBlock = new RegExp(`<url>\\s*<loc>${escaped}</loc>\\s*<lastmod>[^<]*</lastmod>\\s*</url>`);
  if (existingBlock.test(xml)) {
    return xml.replace(existingBlock, `<url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`);
  }
  const entry = `  <url>\n    <loc>${url}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`;
  return xml.replace(/<\/urlset>/, `${entry}</urlset>`);
}

/** Drop one <url> block; a renamed article must not stay listed twice. */
export function removeSitemapUrl(xml: string, url: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.replace(new RegExp(`\\s*<url>\\s*<loc>${escaped}</loc>[\\s\\S]*?</url>`), "");
}

/** Append a 301 in `_redirects` format unless that source path is already routed. */
export function appendRedirect(rules: string, fromPath: string, toPath: string): string {
  const lines = rules.split("\n");
  if (lines.some(line => line.trim().split(/\s+/)[0] === fromPath)) return rules;
  const body = rules.endsWith("\n") || rules === "" ? rules : `${rules}\n`;
  return `${body}${fromPath} ${toPath} 301\n`;
}

interface GhContentsGet {
  content: string;
}

interface GhRef {
  object: { sha: string };
}

interface GhCommit {
  sha: string;
  tree: { sha: string };
}

interface GhTree {
  sha: string;
}

interface GhBlob {
  sha: string;
}

export class AstroGitTarget implements PublishingTarget {
  readonly kind = "astro-git";
  readonly id: string;
  readonly capabilities: TargetCapabilities = capabilities({
    // Images are re-hosted on R2 and referenced by URL in front matter, not
    // uploaded into a media library the target owns.
    hostsMedia: false,
    // The schema has no tag taxonomy.
    tags: false,
    // A static build has no notion of a future publish date; "publish" is "commit now".
    scheduling: false,
    // We render our own Markdown from blocks; article.html is never used.
    bodyFormat: "blocks",
    // The site's own layout supplies its own schema.org markup; nothing here injects the engine's.
    structuredData: false,
  });

  private readonly configured: boolean;
  private readonly apiBase: string;
  private readonly sitemapPath: string;
  private readonly redirectsPath: string;
  private readonly r2: R2Config | null;
  private readonly language: string;
  private readonly copy: AstroGitCopy;

  constructor(
    private readonly config: AstroGitConfig,
    private readonly store: RemoteRefStore,
    private readonly fetchImpl: FetchLike = fetch,
    r2Override?: R2Config | null
  ) {
    this.configured = Boolean(config.owner?.trim() && config.repo?.trim() && config.token?.trim());
    this.id = `astro-git:${config.owner}/${config.repo}`;
    this.apiBase = `https://api.github.com/repos/${config.owner}/${config.repo}`;
    this.sitemapPath = config.sitemapPath ?? "public/sitemap.xml";
    this.redirectsPath = config.redirectsPath ?? "public/_redirects";
    this.r2 = r2Override !== undefined ? r2Override : r2ConfigFromEnv();
    this.language = config.language?.trim() || "en";
    this.copy = { ...DEFAULT_COPY, ...config.copy };
  }

  private areaFor(raw: string | null): { category: string; related: { title: string; href: string }[] } {
    const topicsHub = { title: this.copy.topicsHubTitle, href: TOPICS_HUB_HREF };
    const key = (raw ?? "").trim().toLowerCase();
    const area = this.config.areas?.[key];
    if (!area) {
      return { category: this.config.defaultCategory || key || FALLBACK_CATEGORY, related: [topicsHub] };
    }
    return {
      category: area.category,
      related: [{ title: area.hubTitle, href: area.hubHref }, topicsHub],
    };
  }

  // ==========================================================================
  // GIT DATA API — one atomic commit for the article file AND the sitemap.
  // The Contents API can only write one file per commit; two separate commits
  // would let a mid-way failure leave the sitemap listing a page that was
  // never actually written (or vice-versa) — exactly the "stale"/"missing"
  // pair a site's own sitemap build gate treats as a hard error.
  // ==========================================================================

  private async commitFiles(
    files: { path: string; content: string | null }[],
    message: string
  ): Promise<{ ok: true } | { ok: false; code: Parameters<typeof failed>[0]; message: string }> {
    const refRes = await request(`${this.apiBase}/git/ref/heads/${this.config.branch}`, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!refRes.ok) return { ok: false, code: refRes.code, message: `reading branch ref: ${refRes.message}` };
    const baseSha = (refRes.body as GhRef).object.sha;

    const commitRes = await request(`${this.apiBase}/git/commits/${baseSha}`, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!commitRes.ok) return { ok: false, code: commitRes.code, message: `reading base commit: ${commitRes.message}` };
    const baseTreeSha = (commitRes.body as GhCommit).tree.sha;

    const treeEntries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
    for (const file of files) {
      if (file.content === null) {
        // A null sha in a tree entry deletes the path — the Git Data API's
        // one way to remove a file inside the same commit as the additions.
        treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blobRes = await request(`${this.apiBase}/git/blobs`, {
        method: "POST",
        headers: this.headers(),
        timeoutMs: this.config.timeoutMs,
        fetchImpl: this.fetchImpl,
        body: JSON.stringify({ content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" }),
      });
      if (!blobRes.ok) return { ok: false, code: blobRes.code, message: `creating blob for ${file.path}: ${blobRes.message}` };
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: (blobRes.body as GhBlob).sha });
    }

    const treeRes = await request(`${this.apiBase}/git/trees`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    if (!treeRes.ok) return { ok: false, code: treeRes.code, message: `creating tree: ${treeRes.message}` };

    const newCommitRes = await request(`${this.apiBase}/git/commits`, {
      method: "POST",
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
      body: JSON.stringify({ message, tree: (treeRes.body as GhTree).sha, parents: [baseSha] }),
    });
    if (!newCommitRes.ok) return { ok: false, code: newCommitRes.code, message: `creating commit: ${newCommitRes.message}` };

    // force:false — if the branch moved since we read it, this fails cleanly
    // (RETRYABLE via "rejected") rather than silently overwriting a concurrent push.
    const updateRefRes = await request(`${this.apiBase}/git/refs/heads/${this.config.branch}`, {
      method: "PATCH",
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
      body: JSON.stringify({ sha: (newCommitRes.body as { sha: string }).sha, force: false }),
    });
    if (!updateRefRes.ok) return { ok: false, code: updateRefRes.code, message: `updating ref: ${updateRefRes.message}` };

    return { ok: true };
  }

  private async readFile(path: string): Promise<string | null> {
    const res = await request(`${this.apiBase}/contents/${path}?ref=${this.config.branch}`, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (!res.ok) return null;
    return Buffer.from((res.body as GhContentsGet).content, "base64").toString("utf8");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private pathFor(slug: string): string {
    const dir = this.config.contentDir.replace(/\/+$/, "");
    return `${dir}/${slugifyFilename(slug)}.md`;
  }

  async check(): Promise<TargetCheck> {
    if (!this.configured) {
      return { ok: false, code: "config", retryable: false, message: "astro-git target is not configured" };
    }
    const result = await request(`https://api.github.com/repos/${this.config.owner}/${this.config.repo}`, {
      headers: this.headers(),
      timeoutMs: this.config.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
    if (result.ok) return { ok: true };
    return { ok: false, code: result.code, retryable: RETRYABLE[result.code], message: result.message };
  }

  async publish(article: NormalisedArticle): Promise<PublishOutcome> {
    if (!this.configured) return failed("config", "astro-git target is missing owner, repo or token");
    try {
      return await this.doPublish(article);
    } catch (error) {
      return failed("unknown", error instanceof Error ? error.message : String(error));
    }
  }

  async unpublish(_article: Pick<NormalisedArticle, "id" | "slug">): Promise<PublishOutcome> {
    // Deleting the customer's file for a "false schedule" event is a live-site
    // deletion this target refuses to perform on its own; withdrawing a page
    // is an editorial decision, not a publishing-adapter one.
    return failed("unsupported", "astro-git target does not support unpublishing");
  }

  private async doPublish(article: NormalisedArticle): Promise<PublishOutcome> {
    const degraded: Degradation[] = describeDegradation(this.capabilities, article);
    const ref: RemoteRef = (await this.store.get(this.id, article.id)) ?? {
      targetId: this.id,
      articleId: article.id,
      remoteId: null,
      remoteUrl: null,
      mediaId: null,
      contentHash: null,
      updatedAt: new Date(),
    };

    // The hash covers the article AND how this target renders it: a change to
    // the frontmatter format or the hub routing must reach every live article
    // on its next delivery, not only articles whose text happened to change.
    const renderedHash = `${article.contentHash}:${ASTRO_FORMAT_VERSION}`;
    if (ref.remoteId && ref.contentHash === renderedHash) {
      return { status: "unchanged", remote: ref, degraded };
    }

    let shareImage: string | null = null;
    let cardImage: string | null = null;
    let thumbImage: string | null = null;
    if (article.heroImage) {
      if (!this.r2) {
        return failed("media_failed", "astro-git target has a hero image but R2 is not configured", degraded);
      }
      const images = await deriveArticleImageSet(article.heroImage.url, article.slug, this.r2);
      if (!images) {
        return failed("media_failed", "could not derive the share/card/thumb crops from the hero image", degraded);
      }
      shareImage = images.share;
      cardImage = images.card;
      thumbImage = images.thumb;
    }

    const path = this.pathFor(article.slug);
    const area = this.areaFor(article.category?.slug ?? null);
    const today = new Date().toISOString().slice(0, 10);
    const publishedDay = (article.publishedAt ?? new Date()).toISOString().slice(0, 10);
    const sources = article.source && /^https?:\/\//.test(article.source.url)
      ? [{ title: sourceLabelFor(article.source), url: article.source.url }]
      : [];
    // An article reaches this target only after a person approved it in the
    // engine, so it is reviewed content. The site's schema lets it out of
    // draft only with author + dates + at least one source; an article
    // without a verifiable source stays a draft on the site, by design.
    const frontMatter: Record<string, unknown> = {
      title: article.title,
      // The site shows `description` under the title and in the SERP: the
      // writer's whole-sentence answer, never a clipped excerpt.
      description: article.answerCapsule || article.excerpt || article.title,
      category: area.category,
      kind: "article",
      draft: sources.length === 0,
      author: this.copy.author,
      publishedAt: publishedDay,
      reviewedAt: publishedDay,
      updatedAt: today,
      sources,
      related: area.related,
    };
    // Only when it differs from the default, so a left-to-right site's schema
    // never has to know about these fields.
    if (textDirection(this.language) === "rtl") {
      frontMatter.lang = this.language;
      frontMatter.dir = "rtl";
    }
    const faq = extractFaq(article.blocks);
    if (faq.length > 0) frontMatter.faq = faq;
    if (shareImage) frontMatter.shareImage = shareImage;
    if (cardImage) {
      frontMatter.image = {
        src: cardImage,
        ...(thumbImage ? { srcset: `${thumbImage} 640w, ${cardImage} 1200w` } : {}),
        alt: article.heroImage?.alt || this.copy.imageAlt.replace("{title}", article.title),
        caption: this.copy.imageCaption,
      };
    }

    // Above the fold: the writer's direct answer, as the first paragraph.
    // Below everything: the source as a real link, unless the body already
    // links to it — the editor's rule is "a source with an href, not a name".
    const lead = article.answerCapsule ? `**${article.answerCapsule}**\n\n` : "";
    const bodyBlocks = renderMarkdownBody(article.blocks);
    const sourceLine =
      article.source && /^https?:\/\//.test(article.source.url) && !bodyBlocks.includes(article.source.url)
        ? `\n\n**${this.copy.sourceLabel}:** <a href="${article.source.url}" rel="nofollow noopener" target="_blank">${sourceLabelFor(article.source)}</a>`
        : "";
    const body = `${lead}${bodyBlocks}${sourceLine}`;
    const content = `${buildFrontMatter(frontMatter)}\n\n${body}\n`;
    const articleUrl = `${this.config.siteOrigin.replace(/\/+$/, "")}/articles/${article.slug}/`;
    const isUpdate = Boolean(ref.remoteId);
    // An editor changed the slug: the page moves. The old file goes in the
    // same commit, the old URL leaves the sitemap, and a 301 keeps every link
    // that already points at it alive. Leaving the old file would publish
    // the same article twice under two URLs.
    const renamedFrom = isUpdate && ref.remoteId && ref.remoteId !== path ? ref.remoteId : null;
    const oldUrl = renamedFrom && ref.remoteUrl ? ref.remoteUrl : null;

    const files: { path: string; content: string | null }[] = [{ path, content }];
    if (renamedFrom) files.push({ path: renamedFrom, content: null });
    if (this.sitemapPath) {
      const sitemap = await this.readFile(this.sitemapPath);
      if (sitemap === null) {
        return failed("unreachable", `could not read ${this.sitemapPath} to add this article to it`, degraded);
      }
      const withoutOld = oldUrl ? removeSitemapUrl(sitemap, oldUrl) : sitemap;
      const updatedSitemap = updateSitemapXml(withoutOld, articleUrl, frontMatter.updatedAt as string);
      files.push({ path: this.sitemapPath, content: updatedSitemap });
    }
    if (oldUrl && this.redirectsPath) {
      const rules = await this.readFile(this.redirectsPath);
      if (rules === null) {
        degraded.push({ feature: "redirects", detail: `no ${this.redirectsPath} in the repo — the old URL ${oldUrl} now 404s` });
      } else {
        const fromPath = new URL(oldUrl).pathname;
        const toPath = new URL(articleUrl).pathname;
        files.push({ path: this.redirectsPath, content: appendRedirect(rules, fromPath, toPath) });
      }
    }

    const commit = await this.commitFiles(
      files,
      renamedFrom ? `content: move ${renamedFrom.split("/").pop()} → ${article.slug} via Octypo` : `content: publish ${article.slug} via Octypo`
    );
    if (!commit.ok) return failed(commit.code, commit.message, degraded);

    const saved: RemoteRef = {
      targetId: this.id,
      articleId: article.id,
      remoteId: path,
      remoteUrl: articleUrl,
      mediaId: null,
      contentHash: renderedHash,
      updatedAt: new Date(),
    };
    await this.store.put(saved);

    return { status: "written", action: isUpdate ? "updated" : "created", remote: saved, degraded };
  }
}
