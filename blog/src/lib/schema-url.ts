/**
 * JSON-LD retargeting.
 *
 * This file deliberately contradicts API.md:74-79 ("inject verbatim").
 *
 * `seoSchema` is generated at publish time from the engine's own environment
 * (src/octypo/aeo.ts:46-48 reads SITE_URL and ARTICLE_PATH_PREFIX at module
 * load), so a row written while the engine said `https://old-host.example/guides`
 * carries that host inside `url`, `mainEntityOfPage["@id"]` and every
 * BreadcrumbList item — forever, even after the tenant's real domain is known.
 * Injected verbatim on `https://acme.com/blog/x`, Google sees structured data
 * claiming the page lives somewhere else and drops it. Nothing throws, nothing
 * logs; the customer simply never ranks and cancels in month three.
 *
 * So: the engine owns the *content* of the schema, the blog owns every URL in
 * it, because only the blog knows the host it is being served from.
 */

export interface SiteIdentity {
  siteUrl: string;
  siteName: string;
  articlePathPrefix: string;
  slug: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
  publisherLogoUrl?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
}

type Json = Record<string, unknown>;

function absolute(siteUrl: string, path: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  if (!path || path === '/') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function prefixPath(prefix: string): string {
  const trimmed = (prefix || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Normalise the engine's `seoSchema` column, which may be an array, an object or a JSON string. */
export function parseSchema(input: unknown): Json[] {
  if (input == null) return [];
  let value: unknown = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.filter((v): v is Json => !!v && typeof v === 'object');
  if (typeof value === 'object') return [value as Json];
  return [];
}

export function retargetSchema(input: unknown, site: SiteIdentity): Json[] {
  const schemas = parseSchema(input);
  if (schemas.length === 0) return [];

  const section = prefixPath(site.articlePathPrefix);
  const articleUrl = absolute(site.siteUrl, `${section}/${site.slug}`);
  const sectionUrl = absolute(site.siteUrl, section);
  const homeUrl = absolute(site.siteUrl, '');

  // Structured clone: the caller's row is shared with the cache layer.
  // Legacy FAQPage and HowTo markup may survive in stored rows created under
  // older search-feature rules. The visible FAQ/steps remain in the article;
  // the blog defensively omits stale rich-result types from production HTML.
  const out = (JSON.parse(JSON.stringify(schemas)) as Json[]).filter(
    schema => !['FAQPage', 'HowTo', 'BreadcrumbList'].includes(String(schema['@type'] ?? ''))
  );

  for (const schema of out) {
    if ('url' in schema) schema.url = articleUrl;

    const mainEntity = schema.mainEntityOfPage;
    if (mainEntity && typeof mainEntity === 'object') {
      (mainEntity as Json)['@id'] = articleUrl;
    } else if (typeof mainEntity === 'string') {
      schema.mainEntityOfPage = articleUrl;
    }

    const publisher = schema.publisher;
    if (publisher && typeof publisher === 'object') {
      (publisher as Json).name = site.siteName;
      (publisher as Json).url = homeUrl;
      if (site.publisherLogoUrl) {
        (publisher as Json).logo = {
          '@type': 'ImageObject',
          url: site.publisherLogoUrl,
        };
      }
    }

    if (
      site.imageUrl &&
      ['Article', 'BlogPosting', 'NewsArticle'].includes(String(schema['@type'] ?? ''))
    ) {
      schema.image = [{
        '@type': 'ImageObject',
        url: site.imageUrl,
        contentUrl: site.imageUrl,
        ...(site.imageAlt ? { description: site.imageAlt } : {}),
      }];
    }
    if (['Article', 'BlogPosting', 'NewsArticle'].includes(String(schema['@type'] ?? ''))) {
      if (site.publishedAt) schema.datePublished = site.publishedAt;
      if (site.updatedAt) schema.dateModified = site.updatedAt;
    }

    // aeo.ts:117 falls back to "<SITE_NAME> Editorial" when an article has no
    // named writer, so a row published under a previous identity carries that
    // brand as its byline forever. A real writer's name never has that suffix,
    // which is what makes this safe to rewrite and wrong to leave.
    const author = schema.author;
    if (author && typeof author === 'object' && !Array.isArray(author)) {
      const name = (author as Json).name;
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name === '[object Object]' ||
        /\sEditorial$/.test(name)
      ) {
        schema.author = {
          '@type': 'Organization',
          name: `${site.siteName} Editorial`,
          url: homeUrl,
        };
      }
    }

  }

  // Breadcrumbs are a property of the page route, not of the content row.
  // Rebuild one canonical BreadcrumbList here so old rows cannot omit it and
  // rows created by different publishers cannot emit duplicates.
  const articleSchema = out.find(schema =>
    ['Article', 'BlogPosting', 'NewsArticle'].includes(String(schema['@type'] ?? ''))
  );
  if (articleSchema) {
    const sectionName = section
      ? section.split('/').filter(Boolean).at(-1)?.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Articles'
      : 'Articles';
    const headline = typeof articleSchema.headline === 'string' && articleSchema.headline.trim()
      ? articleSchema.headline.trim()
      : site.slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    out.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      '@id': `${articleUrl}#breadcrumbs`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: homeUrl },
        { '@type': 'ListItem', position: 2, name: sectionName, item: sectionUrl },
        { '@type': 'ListItem', position: 3, name: headline },
      ],
    });
  }

  return out;
}

/** Every absolute URL the schema asserts — the surface a de-indexing bug hides in. */
export function collectSchemaUrls(schemas: Json[]): string[] {
  const urls: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Json)) {
      // `image` is an asset URL and `@context` is a vocabulary URI — neither is
      // a claim about where this page lives.
      if (key === 'image' || key === '@context') continue;
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value);
      else walk(value);
    }
  };
  walk(schemas);
  return urls;
}

/** Serialise for a <script type="application/ld+json"> without allowing a `</script>` break-out. */
export function serialiseSchema(schemas: Json[]): string {
  return JSON.stringify(schemas).replace(/</g, '\\u003c');
}
