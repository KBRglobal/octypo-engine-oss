# Octypo Engine — Public API (for the consuming site)

Base URL: `http://localhost:3000`

The engine is a **closed, headless system** (`X-Robots-Tag: noindex`, `robots.txt Disallow:/`).
The site pulls content from it and owns its own rendering, indexing, sitemap and Search Console.

---

## `GET /api/articles?limit=20`

Returns published articles only, newest first. `limit` max 100.

```jsonc
{
  "articles": [
    {
      "id": "uuid",
      "title": "string",
      "slug": "string",                  // use as /guides/<slug>
      "summary": "string",               // ~200 chars, plain text
      "answerCapsule": "string|null",     // 40–60 word direct answer (render as the gold "In short" box)
      "metaTitle": "string|null",        // for <title>
      "metaDescription": "string|null",  // for <meta name=description>
      "blocks": [ /* see Blocks below */ ],
      "wordCount": 2300,
      "writerId": "string|null",
      "publishedAt": "ISO-8601",
      "heroImage": "https://pub-...r2.dev/guides/2026/<slug>-<hash>.png | null",
      "heroImageAlt": "string|null",
      "seoSchema": [ /* JSON-LD objects, see below */ ],
      "aeoScore": 100,
      "category": "news | diy | tips | guide",  // drives the content-type chip
      "tags": ["market-news", "deposits"]        // topic slugs (relatedTopicIds), may be []
    }
  ]
}
```

### `category` → content-type chip
| value  | source | chip |
|--------|--------|------|
| `news` | RSS feeds | News |
| `diy`  | DIY repair knowledge base | DIY Repairs |
| `tips` | cross-KB viral/synthesis listicles | Tips |
| `guide`| general guides | Guides |

`tags` are topic slugs (e.g. `deposits`, `market-news`, `handover`) — the same slugs used in
the inline `/topics/<slug>` internal links.

There is currently no single-article endpoint on the public API — fetch the list and
match by `slug`, or ask and I'll add `GET /api/articles/:slug`.

---

## Blocks (the article body — `blocks[]`)

Ordered array. Each block: `{ id: string, type: string, data: {...} }`. Types:

| type      | data shape | render as |
|-----------|-----------|-----------|
| `text`    | `{ content: "<p>…HTML…</p>" }` | paragraph(s). **Contains inline HTML** incl. `<a>` links and `<strong>`. |
| `heading` | `{ text: "What to Expect", level: 2 }` | `<h2>`/`<h3>` per `level` |
| `image`   | `{ url: "https://pub-…r2.dev/…png", alt: "…", credit: null }` | `<figure><img>` |
| `faq`     | `{ items: [ { question, answer }, … ] }` | FAQ accordion / Q&A list. Matches the FAQPage JSON-LD. |

**Internal links:** `text` blocks may contain `<a href="/topics/<slug>" class="internal-link">…</a>`
(the engine's internal-linking engine). Decide how the site routes `/topics/*` — either
implement topic hub pages, rewrite them, or strip the anchor (keep the text). Heads-up so
they're not dead links.

---

## `seoSchema` (JSON-LD) — inject verbatim

An **array** of JSON-LD objects (`Article`, `FAQPage`, and `BreadcrumbList` when `SITE_URL` is set).
Drop each into its own `<script type="application/ld+json">` in the page `<head>`, as-is.
With `SITE_URL=https://example.com` set on the engine, `url`/`mainEntityOfPage`/breadcrumb items
already point to `https://example.com/guides/<slug>`.

---

## Other endpoints

- `GET /health` → `{ status, uptime }`
- `GET /api/pipeline/status` → scheduler + queue + library stats (ops/debug)
- Everything under `/api/admin/*` is auth-gated (admin only) — not for the site.

## Notes for SEO/AEO division
- Engine provides the **data**: metaTitle, metaDescription, slug, answerCapsule, JSON-LD, heroImage, FAQ.
- Site owns **indexing**: canonical tag (point to `https://example.com/guides/<slug>`), sitemap.xml,
  robots, Open Graph (use `heroImage` for `og:image`), Search Console, and IndexNow if desired.
- The engine never pings IndexNow (gated off) — indexing is entirely the site's job.
