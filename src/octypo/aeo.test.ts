import { describe, it, expect } from "vitest";

import { SchemaGenerator, defaultSiteIdentity, type SiteIdentity } from "./aeo.js";

const generator = new SchemaGenerator();

const acme: SiteIdentity = {
  siteUrl: "https://acme.com",
  siteName: "Acme",
  articlePathPrefix: "/blog",
};

const globex: SiteIdentity = {
  siteUrl: "https://globex.io",
  siteName: "Globex",
  articlePathPrefix: "/knowledge",
};

const input = {
  title: "Deposit rules explained",
  description: "What tenants can claim back.",
  slug: "deposit-rules-explained",
  publishedAt: new Date("2026-08-01T10:00:00.000Z"),
  faqs: [{ question: "Who holds it?", answer: "The landlord does, for the whole tenancy." }],
};

describe("per-tenant JSON-LD identity", () => {
  // The engine reads SITE_URL and ARTICLE_PATH_PREFIX at module load, so before
  // this the schema stored on every tenant's article claimed whichever domain
  // the process happened to be configured for. Two customers, one host.
  it("puts each tenant's own host into the Article url", () => {
    const a = generator.generateArticleSchema({ ...input, site: acme });
    const b = generator.generateArticleSchema({ ...input, site: globex });
    expect(a.url).toBe("https://acme.com/blog/deposit-rules-explained");
    expect(b.url).toBe("https://globex.io/knowledge/deposit-rules-explained");
  });

  it("puts each tenant's own host into mainEntityOfPage", () => {
    const a = generator.generateArticleSchema({ ...input, site: acme });
    expect((a.mainEntityOfPage as Record<string, unknown>)["@id"]).toBe(
      "https://acme.com/blog/deposit-rules-explained"
    );
  });

  it("uses the tenant's brand as publisher, not the process-wide SITE_NAME", () => {
    const a = generator.generateArticleSchema({ ...input, site: acme });
    expect((a.publisher as Record<string, unknown>).name).toBe("Acme");
    expect((a.publisher as Record<string, unknown>).url).toBe("https://acme.com");
  });

  it("attributes the author to the tenant when the writer is unknown", () => {
    const a = generator.generateArticleSchema({ ...input, site: acme, authorName: null });
    expect((a.author as Record<string, unknown>).name).toBe("Acme Editorial");
  });

  it("builds every breadcrumb item on the tenant host and prefix", () => {
    const crumbs = generator.generateBreadcrumbSchema({ ...input, site: globex })!;
    const items = crumbs.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].item).toBe("https://globex.io");
    expect(items[1].item).toBe("https://globex.io/knowledge");
    expect(items[2].item).toBeUndefined();
  });

  it("names the breadcrumb section from the tenant prefix", () => {
    const crumbs = generator.generateBreadcrumbSchema({ ...input, site: globex })!;
    expect((crumbs.itemListElement as Array<Record<string, unknown>>)[1].name).toBe("Knowledge");
  });

  it("emits no BreadcrumbList for a tenant with no site URL yet", () => {
    expect(
      generator.generateBreadcrumbSchema({
        ...input,
        site: { siteUrl: null, siteName: "New", articlePathPrefix: "/blog" },
      })
    ).toBeNull();
  });

  it("omits url and mainEntityOfPage entirely rather than emitting a wrong one", () => {
    const schema = generator.generateArticleSchema({
      ...input,
      site: { siteUrl: null, siteName: "New", articlePathPrefix: "/blog" },
    });
    expect(schema.url).toBeUndefined();
    expect(schema.mainEntityOfPage).toBeUndefined();
  });

  it("keeps two tenants' full payloads completely disjoint", () => {
    const a = JSON.stringify(generator.generateFullSchema({ ...input, site: acme }));
    const b = JSON.stringify(generator.generateFullSchema({ ...input, site: globex }));
    expect(a).not.toContain("globex");
    expect(b).not.toContain("acme");
  });

  it("keeps visible FAQs out of legacy FAQPage rich-result markup", () => {
    const schemas = generator.generateFullSchema({ ...input, site: acme });
    expect(schemas.map(schema => schema["@type"])).toEqual(["Article", "BreadcrumbList"]);
  });

  it("falls back to the process identity when no tenant is supplied, so existing callers are unchanged", () => {
    const fallback = defaultSiteIdentity();
    const schema = generator.generateArticleSchema(input);
    expect((schema.publisher as Record<string, unknown>).name).toBe(fallback.siteName);
  });

  it("normalises a prefix given without a leading slash or with a trailing one", () => {
    const schema = generator.generateArticleSchema({
      ...input,
      site: { siteUrl: "https://acme.com", siteName: "Acme", articlePathPrefix: "blog/" },
    });
    expect(schema.url).toBe("https://acme.com/blog/deposit-rules-explained");
  });

  it("handles a tenant mounted at the site root", () => {
    const schema = generator.generateArticleSchema({
      ...input,
      site: { siteUrl: "https://acme.com", siteName: "Acme", articlePathPrefix: "/" },
    });
    expect(schema.url).toBe("https://acme.com/deposit-rules-explained");
  });
});
