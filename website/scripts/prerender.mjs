// Renders the marketing page to static HTML after `vite build`, and writes the three files that tell
// search engines and answer engines what is here. Run by `npm run build`.
//
// The page is one route. It is also the page that sells an editorial engine, so it has to be the most
// readable page we own: every word in the HTML, one h1, real structured data.
import { build } from "vite";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(ROOT, "dist");
const SSR = join(ROOT, "node_modules", ".prerender");
const SITE = "https://octypo.com";

await build({
  root: ROOT,
  logLevel: "warn",
  build: { ssr: "src/entry-server.jsx", outDir: SSR, emptyOutDir: true, minify: false, copyPublicDir: false },
  ssr: { noExternal: true },
});
const { render, renderPrivacy, renderTerms, renderCookies, renderAbout } = await import(
  pathToFileURL(join(SSR, "entry-server.js")).href
);

// One source for the questions: the ones the page renders are the ones the schema describes.
const appSource = readFileSync(join(ROOT, "src", "App.jsx"), "utf8");
const faqBlock = appSource.slice(appSource.indexOf("const faqs = ["), appSource.indexOf("const steps = ["));
const faqs = [...faqBlock.matchAll(/q:\s*"((?:[^"\\]|\\.)*)",\s*\n\s*a:\s*"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => ({ q: m[1].replace(/\\"/g, '"'), a: m[2].replace(/\\"/g, '"') }));
if (faqs.length < 3) throw new Error(`only ${faqs.length} question(s) found in App.jsx; the FAQ schema would not match the page`);

const TITLE = "Octypo: an autonomous editorial engine for publishers and brands";
const DESCRIPTION =
  "Octypo reads your trusted sources, chooses the stories worth telling, writes them with a newsroom of specialist AI writers, checks every fact and delivers publication-ready articles.";

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#software`,
      name: "Octypo",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: SITE,
      description: DESCRIPTION,
      publisher: { "@id": `${SITE}/#organization` },
      offers: [
        { "@type": "Offer", name: "The Brief", price: "89", priceCurrency: "EUR", availability: "https://schema.org/InStock", url: `${SITE}/#pricing`, description: "30 publication-ready articles per month." },
        { "@type": "Offer", name: "The Desk", price: "289", priceCurrency: "EUR", availability: "https://schema.org/InStock", url: `${SITE}/#pricing`, description: "100 publication-ready articles per month." },
        { "@type": "Offer", name: "The Newsroom", price: "799", priceCurrency: "EUR", availability: "https://schema.org/InStock", url: `${SITE}/#pricing`, description: "300 publication-ready articles per month." },
      ],
    },
    {
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      name: "KBR Global",
      legalName: "KBR Global Creative Consulting Ltd",
      url: "https://kbr.global",
      email: "info@kbr.global",
      address: { "@type": "PostalAddress", streetAddress: "Suite 4.3.02, Block 4, Eurotowers", addressLocality: "Gibraltar", postalCode: "GX11 1AA", addressCountry: "GI" },
      sameAs: ["https://kbr.global", "https://kbr.global/products/octypo"],
      identifier: [
        { "@type": "PropertyValue", propertyID: "DUNS", value: "855019981" },
        { "@type": "PropertyValue", propertyID: "Gibraltar company number", value: "125571" },
      ],
    },
    { "@type": "WebSite", "@id": `${SITE}/#website`, name: "Octypo", url: SITE, publisher: { "@id": `${SITE}/#organization` } },
    {
      "@type": "FAQPage",
      "@id": `${SITE}/#faq`,
      mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    },
  ],
};

const head = `    <title>${TITLE}</title>
    <meta name="description" content="${DESCRIPTION}" />
    <link rel="canonical" href="${SITE}/" />
    <meta property="og:site_name" content="Octypo" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${TITLE}" />
    <meta property="og:description" content="${DESCRIPTION}" />
    <meta property="og:url" content="${SITE}/" />
    <meta property="og:image" content="${SITE}/og.jpg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Octypo, an autonomous editorial engine" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${SITE}/og.jpg" />
    <script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>`;

const template = readFileSync(join(DIST, "index.html"), "utf8");
if (!template.includes('<div id="root"></div>')) throw new Error("dist/index.html: #root not found");

const html = template
  .replace(/\s*<title>[^<]*<\/title>/, "")
  .replace(/\s*<meta name="description"[^>]*>/, "")
  .replace("</head>", `${head}\n  </head>`)
  .replace('<div id="root"></div>', `<div id="root">${render()}</div>`);
writeFileSync(join(DIST, "index.html"), html);

const write = (name, body) => { mkdirSync(dirname(join(DIST, name)), { recursive: true }); writeFileSync(join(DIST, name), body); };

// The four legal pages: same shell, no JS bundle (nothing on them is interactive),
// just the stylesheet so they render on-brand and are fully readable by any crawler.
const cssHref = (html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/) || [])[1];
if (!cssHref) throw new Error("dist/index.html: no stylesheet link found to reuse on the legal pages");
const legalPage = (path, title, description, bodyHtml) => {
  const doc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%230b1020'/%3E%3Ccircle cx='32' cy='32' r='15' fill='none' stroke='%23ff6b4a' stroke-width='9'/%3E%3C/svg%3E" />
    <meta name="theme-color" content="#111522" />
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${SITE}/${path}/" />
    <title>${title}</title>
    <link rel="stylesheet" href="${cssHref}">
  </head>
  <body>
    <div id="root">${bodyHtml}</div>
  </body>
</html>
`;
  write(`${path}/index.html`, doc);
};
legalPage("privacy", "Privacy Policy | Octypo", "Privacy policy for Octypo, operated by KBR Global Creative Consulting Ltd, Gibraltar.", renderPrivacy());
legalPage("terms", "Terms of Service | Octypo", "Terms of service for Octypo, an autonomous editorial engine.", renderTerms());
legalPage("cookies", "Cookie Policy | Octypo", "octypo.com sets no cookies — what loads on the page and why.", renderCookies());
legalPage("about", "About Octypo | KBR Global", "Octypo is built and operated by KBR Global Creative Consulting Ltd, Gibraltar.", renderAbout());

// The answer engines are named, because the point of this product is being read by them.
const bots = ["Googlebot", "bingbot", "OAI-SearchBot", "PerplexityBot", "Claude-SearchBot", "Claude-User", "GPTBot", "ClaudeBot", "Google-Extended"];
write("robots.txt", `${bots.map((b) => `User-agent: ${b}\nAllow: /\n`).join("\n")}\nUser-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

const today = new Date().toISOString().slice(0, 10);
const legalPaths = ["", "privacy/", "terms/", "cookies/", "about/"];
write("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${legalPaths.map((p) => `  <url>\n    <loc>${SITE}/${p}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join("\n")}\n</urlset>\n`);

write("llms.txt", [
  "# Octypo",
  "",
  `> ${DESCRIPTION}`,
  "",
  "## Pages",
  "",
  `- [Octypo](${SITE}/): what the engine does, how the newsroom works, what it checks before publishing, and how to see it.`,
  `- [About](${SITE}/about/): who operates Octypo.`,
  `- [Privacy Policy](${SITE}/privacy/)`,
  `- [Terms of Service](${SITE}/terms/)`,
  `- [Cookie Policy](${SITE}/cookies/)`,
  "",
  "## Notes",
  "",
  "- Octypo is made by KBR Global Creative Consulting Ltd, Gibraltar. Company number 125571, DUNS 855019981.",
  "- Contact: info@kbr.global",
  `- Sitemap: ${SITE}/sitemap.xml`,
  "",
].join("\n"));

rmSync(SSR, { recursive: true, force: true });
const text = html.split('<div id="root">')[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
console.log(`prerendered: ${text.split(" ").length} words in the HTML, ${(html.match(/<h1/g) || []).length} h1, robots.txt, sitemap.xml and llms.txt written`);
