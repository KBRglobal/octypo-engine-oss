/**
 * Read a page the way a visitor sees it.
 *
 * A plain fetch returns whatever the server sends, which on a modern site
 * is a script tag and an empty div. one restaurant site answered with 2,838
 * characters of HTML, thirty-five characters of visible text and no links
 * at all — so the review reported no service pages, no navigation, no way
 * to order and thin content. Every one of those was false, and the client
 * would have been told their site was broken.
 *
 * So: fetch first, because it is fast and most sites are fine. When what
 * comes back is obviously a shell, render it in a browser and read that
 * instead. And when neither can produce a readable page, say so — a review
 * that cannot see the site must report that it could not see it, never
 * findings about a page it never read.
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

import { logger } from "../lib/logger.js";

export interface PageContent {
  url: string;
  title: string;
  description: string;
  /** Visible text, markup stripped and whitespace collapsed. */
  text: string;
  /** Link labels from the navigation, which is where the money pages are. */
  links: string[];
  /** How it was read, which the review needs to know. */
  via: "fetch" | "browser";
}

export type PageFailure =
  | { ok: false; status: number; error: string; unreadable?: false }
  /** Reached, but nothing to read — and no browser to render it with. */
  | { ok: false; status: number; error: string; unreadable: true };

/**
 * Below this many characters of visible text a page is a shell, not a page.
 * A real homepage, even a sparse one, carries more than a masthead.
 */
const THIN_TEXT = 400;

function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metaFrom(html: string): { title: string; description: string } {
  return {
    title: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim(),
    description:
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1]?.trim() ??
      "",
  };
}

/** Decode honouring the declared charset: plenty of sites still serve a legacy encoding. */
function decode(buffer: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder("utf-8").decode(buffer.slice(0, 4096));
  const charset = (
    /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    "utf-8"
  ).toLowerCase();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/**
 * Playwright is an optional runtime dependency, not a build one: the engine
 * itself never needs a browser, and a client's install should not pull one
 * down to serve articles. So it is required at run time and typed loosely.
 */
type Renderer = {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<{
      newPage(options?: unknown): Promise<{
        goto(url: string, options?: unknown): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        evaluate(script: string): Promise<unknown>;
      }>;
      close(): Promise<void>;
    }>;
  };
};

function loadPlaywright(): Renderer | null {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright") as Renderer;
  } catch {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
      return require(require.resolve("playwright", { paths: [globalRoot] })) as Renderer;
    } catch {
      return null;
    }
  }
}

/**
 * What to run inside the page. A string, not a function, because this body
 * executes in the browser and its DOM globals are not — and should not be —
 * in the engine's own type environment.
 */
const READ_IN_PAGE = `(() => {
  const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
  const links = Array.from(document.querySelectorAll("a"))
    .map((a) => (a.textContent || "").replace(/\\s+/g, " ").trim())
    .filter((t) => t.length > 1 && t.length < 60);
  return {
    title: document.title || "",
    description:
      (document.querySelector('meta[name="description"]') || {}).content || "",
    text,
    links: Array.from(new Set(links)).slice(0, 40),
  };
})()`;

/** Render in a real browser and read what a visitor would see. */
async function readRendered(url: string): Promise<PageContent | null> {
  const pw = loadPlaywright();
  if (!pw) return null;

  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // A single-page app often paints after the network settles.
    await page.waitForTimeout(1500);

    const read = (await page.evaluate(READ_IN_PAGE)) as {
      title: string;
      description: string;
      text: string;
      links: string[];
    };

    return { url, via: "browser", ...read };
  } catch (error) {
    logger.warn({ url, error: (error as Error).message }, "[PageReader] Render failed");
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

export interface ReadOptions {
  /**
   * How to render a shell page. Defaults to Playwright; a test supplies its
   * own so that the decision to render — the part that was wrong — can be
   * checked without a browser or a network.
   */
  render?: (url: string) => Promise<PageContent | null>;
  fetchImpl?: typeof fetch;
}

/**
 * Read a page, rendering it only when the plain fetch is plainly a shell.
 */
export async function readPage(
  raw: string,
  options: ReadOptions = {}
): Promise<PageContent | PageFailure> {
  const render = options.render ?? readRendered;
  const fetchImpl = options.fetchImpl ?? fetch;
  let target: URL;
  try {
    // "example.com" is a site someone typed without thinking about it, so
    // it gets a scheme. Anything that already declares one keeps it — prefix
    // "ftp://host" and it parses as the host "ftp", which then fails as a
    // network error instead of as the bad address it is.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw.trim());
    target = new URL(hasScheme ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return { ok: false, status: 400, error: "that is not a web address" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, status: 400, error: "only http and https addresses can be read" };
  }

  let html = "";
  try {
    const response = await fetchImpl(target.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OctypoLinkDesk/1.0)" },
    });
    if (!response.ok) {
      return { ok: false, status: 502, error: `the site answered ${response.status}` };
    }
    html = decode(await response.arrayBuffer(), response.headers.get("content-type")).slice(
      0,
      400_000
    );
  } catch {
    // The fetch failing is not the end: a browser may still get there.
    html = "";
  }

  const text = stripToText(html);
  const linkCount = (html.match(/<a\s/gi) ?? []).length;
  const looksRendered = text.length >= THIN_TEXT && linkCount > 0;

  if (looksRendered) {
    const { title, description } = metaFrom(html);
    const labels = [...html.matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => stripToText(m[1]))
      .filter((t) => t.length > 1 && t.length < 60);
    return {
      url: target.toString(),
      title,
      description,
      text,
      links: [...new Set(labels)].slice(0, 40),
      via: "fetch",
    };
  }

  logger.info(
    { url: target.toString(), chars: text.length, links: linkCount },
    "[PageReader] Shell page, rendering in a browser"
  );
  const rendered = await render(target.toString());
  if (rendered && rendered.text.length >= 40) return rendered;

  // Neither route produced a page. Say that, rather than let a review
  // describe an empty string as a thin website.
  return {
    ok: false,
    status: 502,
    unreadable: true,
    error:
      "could not read the page — it renders in the browser and no renderer is available here. Install Playwright (npm i -g playwright) or paste the client's details by hand.",
  };
}
