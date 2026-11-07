/**
 * The rule these tests exist to hold: a review never describes a page the
 * reader could not see.
 *
 * One restaurant site answered 200 with a script tag and an empty div. The reader
 * handed that to the model as the client's homepage, and the model — doing
 * exactly what it was asked — reported no service pages, no navigation, no
 * contact details and no way to order. Five findings about a site nobody had
 * looked at, on their way to the client.
 *
 * So the decision that matters is not "did the fetch succeed" but "is there
 * a page here", and when there is not, whether it says so.
 */
import { describe, it, expect } from "vitest";

import { readPage, type PageContent } from "./page-reader.js";

/** A fetch that always answers with this body, and never touches a network. */
function serving(html: string, init: { status?: number; contentType?: string } = {}) {
  const { status = 200, contentType = "text/html; charset=utf-8" } = init;
  return (async () =>
    new Response(html, {
      status,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

/** A renderer that reports what a browser would have seen. */
function renders(page: Partial<PageContent>) {
  return async (url: string): Promise<PageContent> => ({
    url,
    title: "",
    description: "",
    text: "",
    links: [],
    via: "browser",
    ...page,
  });
}

/** No browser on this machine, which is the production install's case. */
const noRenderer = async () => null;

const FULL_PAGE = `<!doctype html><html><head>
  <title>Home kitchen in Lisbon</title>
  <meta name="description" content="Fresh home cooking">
  </head><body>
  <nav><a href="/menu">Weekday menu</a><a href="/weekend">Weekend</a></nav>
  <p>${"A home kitchen cooking fresh meals with delivery across Lisbon. ".repeat(12)}</p>
  </body></html>`;

/** What a client-rendered app actually serves. */
const SHELL = `<!doctype html><html><head><title>Golden Kitchen</title></head>
  <body><div id="root"></div><script src="/app.js"></script></body></html>`;

describe("a page that is really there", () => {
  it("reads it from the fetch without opening a browser", async () => {
    const page = await readPage("https://example.com", {
      fetchImpl: serving(FULL_PAGE),
      render: async () => {
        throw new Error("should not render a page that already has content");
      },
    });

    expect("ok" in page).toBe(false);
    const content = page as PageContent;
    expect(content.via).toBe("fetch");
    expect(content.title).toBe("Home kitchen in Lisbon");
    expect(content.description).toBe("Fresh home cooking");
    expect(content.text).toContain("delivery across Lisbon");
  });

  it("keeps the navigation labels, because that is where the money pages are", async () => {
    const page = (await readPage("https://example.com", {
      fetchImpl: serving(FULL_PAGE),
      render: noRenderer,
    })) as PageContent;

    expect(page.links).toEqual(["Weekday menu", "Weekend"]);
  });

  it("accepts an address with no scheme", async () => {
    const page = (await readPage("example.com", {
      fetchImpl: serving(FULL_PAGE),
      render: noRenderer,
    })) as PageContent;

    expect(page.url).toBe("https://example.com/");
  });
});

describe("a page that renders in the browser", () => {
  it("renders it rather than reading the empty shell", async () => {
    const page = await readPage("https://example-kitchen.ae", {
      fetchImpl: serving(SHELL),
      render: renders({
        title: "Golden Kitchen",
        text: "A home kitchen in Lisbon, weekend meals and event catering.",
        links: ["Weekday menu", "Weekend specials", "Order by message"],
      }),
    });

    expect("ok" in page).toBe(false);
    const content = page as PageContent;
    expect(content.via).toBe("browser");
    expect(content.links).toContain("Order by message");
  });

  it("renders a page whose text is long enough but carries no links at all", async () => {
    const wall = `<!doctype html><html><body><p>${"text ".repeat(200)}</p></body></html>`;
    const page = (await readPage("https://example.com", {
      fetchImpl: serving(wall),
      render: renders({ text: "A home kitchen in Lisbon with a weekday menu and weekend meals.", links: ["Home"] }),
    })) as PageContent;

    expect(page.via).toBe("browser");
  });

  it("reports that it could not read the page when there is no browser", async () => {
    const page = await readPage("https://example-kitchen.ae", {
      fetchImpl: serving(SHELL),
      render: noRenderer,
    });

    expect("ok" in page).toBe(true);
    const failure = page as { unreadable?: boolean; error: string };
    expect(failure.unreadable).toBe(true);
    // The whole point: nothing a review could mistake for findings.
    expect(failure.error).not.toContain("content");
  });

  it("treats a browser that returns almost nothing as unreadable too", async () => {
    const page = await readPage("https://example-kitchen.ae", {
      fetchImpl: serving(SHELL),
      render: renders({ text: "Loading..." }),
    });

    expect((page as { unreadable?: boolean }).unreadable).toBe(true);
  });

  it("still tries the browser when the fetch itself fails", async () => {
    const page = (await readPage("https://example-kitchen.ae", {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      render: renders({ text: "A home kitchen in Lisbon with hot delivery all over the city." }),
    })) as PageContent;

    expect(page.via).toBe("browser");
  });
});

describe("addresses it refuses", () => {
  it("rejects something that is not a web address", async () => {
    const page = await readPage("not a url at all", { render: noRenderer });
    expect((page as { status: number }).status).toBe(400);
  });

  it("rejects a scheme that is not http", async () => {
    const page = await readPage("ftp://example.com", { render: noRenderer });
    expect((page as { status: number }).status).toBe(400);
  });

  it("passes on the site's own error rather than guessing", async () => {
    const page = await readPage("https://example.com", {
      fetchImpl: serving("gone", { status: 404 }),
      render: noRenderer,
    });

    const failure = page as { status: number; error: string; unreadable?: boolean };
    expect(failure.error).toContain("404");
    // A site that answers 404 was read fine; it is the site that is missing.
    expect(failure.unreadable).toBeUndefined();
  });
});

describe("text that arrives in a legacy encoding", () => {
  it("decodes the declared charset instead of serving mojibake", async () => {
    // "Здравствуй" begins these bytes in windows-1251, which plenty of sites still serve.
    const bytes = new Uint8Array([0xc7, 0xe4, 0xf0, 0xe0, 0xe2]);
    const filler = new TextEncoder().encode(
      `<html><head><title>x</title></head><body><a href="/a">link</a><p>${"a ".repeat(300)}`
    );
    const body = new Uint8Array(filler.length + bytes.length);
    body.set(filler);
    body.set(bytes, filler.length);

    const page = (await readPage("https://example.com", {
      fetchImpl: (async () =>
        new Response(body, {
          headers: { "content-type": "text/html; charset=windows-1251" },
        })) as unknown as typeof fetch,
      render: noRenderer,
    })) as PageContent;

    expect(page.text).toContain("\u0417\u0434\u0440\u0430\u0432");
  });
});
