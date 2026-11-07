/**
 * Automatic publishing: pull published articles from the Octypo engine and
 * write them into this site's content collection, image included.
 *
 * The engine's review console owns the editorial decision — an article gets
 * here only after a human hit approve. This script is the deterministic other
 * half: convert blocks to markdown, attach an image from the local bank by
 * category, write the frontmatter Astro expects. Run it, then build.
 *
 *   npm run sync         one pass
 *   npm run publish      sync + build
 *
 * Configuration:
 *   OCTYPO_URL            engine base (default http://localhost:3000)
 *   OCTYPO_CATEGORY_LABEL label for an article with no category (default "Guides")
 *   OCTYPO_READING_LABEL  reading time, `{minutes}` is filled in (default "{minutes} min read")
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(ROOT, "src/content/articles");
const BANK_DIR = path.join(ROOT, "public/images/bank");
const ENGINE = (process.env.OCTYPO_URL || "http://localhost:3000").replace(/\/$/, "");
const CATEGORY_LABEL = process.env.OCTYPO_CATEGORY_LABEL || "Guides";
const READING_LABEL = process.env.OCTYPO_READING_LABEL || "{minutes} min read";

const FALLBACK_BANK = "general";

/** Bank filename prefixes, from `<prefix>-NN.webp`. A prefix names one image category. */
function bankPrefixes(files) {
  return [...new Set(files.map((f) => /^(.+)-\d+\.[a-z]+$/i.exec(f)?.[1]).filter(Boolean))];
}

function bankImageFor(article) {
  if (!fs.existsSync(BANK_DIR)) return null;
  const images = fs.readdirSync(BANK_DIR).filter((f) => /\.(webp|jpg|jpeg|png)$/i.test(f)).sort();
  const hint = `${article.tags?.join(" ") ?? ""} ${article.category ?? ""} ${article.title}`.toLowerCase();
  const prefix = bankPrefixes(images).find((p) => hint.includes(p.toLowerCase())) ?? FALLBACK_BANK;
  const candidates = images.filter((f) => f.startsWith(`${prefix}-`));
  const pool = candidates.length ? candidates : images;
  if (!pool.length) return null;
  // Stable pick: the same article keeps the same image across syncs, and
  // consecutive articles spread across the bank instead of all taking file 01.
  const digest = crypto.createHash("sha1").update(article.slug).digest();
  return `/images/bank/${pool[digest[0] % pool.length]}`;
}

function inline(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "**$1**").trim();
}

/** Engine blocks → markdown body + extracted FAQ. */
function blocksToMarkdown(blocks) {
  const body = [];
  const faq = [];
  for (const block of blocks ?? []) {
    const data = block.data ?? {};
    switch (block.type) {
      case "heading":
        body.push(`${"#".repeat(Math.min(Math.max(data.level ?? 2, 2), 4))} ${data.text ?? ""}`);
        break;
      case "text": {
        const content = (data.content ?? data.text ?? "").trim();
        if (!content) break;
        // The writer emits bold-only paragraphs as section labels.
        const bold = /^\*\*(.+)\*\*$/.exec(content);
        body.push(bold ? `## ${bold[1]}` : inline(content));
        break;
      }
      case "list":
        body.push(
          (data.items ?? [])
            .map((item, i) => (data.ordered ? `${i + 1}. ${item}` : `- ${item}`))
            .join("\n")
        );
        break;
      case "faq":
        for (const item of data.items ?? data.faqs ?? []) {
          const q = item.question ?? item.q;
          const a = item.answer ?? item.a;
          if (q && a) faq.push({ q, a });
        }
        break;
      default:
        break; // images are assigned from the bank, not carried from the engine
    }
  }
  return { markdown: body.join("\n\n"), faq };
}

const quote = (value) => `"${String(value ?? "").replace(/"/g, '\\"').replace(/\n/g, " ").trim()}"`;

function frontmatter(article, image, faq) {
  const words = article.wordCount || 400;
  const lines = [
    "---",
    `title: ${quote(article.title)}`,
    `description: ${quote(article.metaDescription || article.summary || article.title)}`,
    `summary: ${quote(article.summary || article.answerCapsule || "")}`,
    `published: ${quote((article.publishedAt ?? new Date().toISOString()).slice(0, 10))}`,
    `image: ${quote(image ?? `/images/bank/${FALLBACK_BANK}-01.webp`)}`,
    `imageAlt: ${quote(article.heroImageAlt || article.title)}`,
    `category: ${quote(article.category === "guide" ? CATEGORY_LABEL : article.category || CATEGORY_LABEL)}`,
    `readingTime: ${quote(READING_LABEL.replace("{minutes}", String(Math.max(2, Math.round(words / 250)))))}`,
  ];
  if (article.answerCapsule) lines.push(`answerCapsule: ${quote(article.answerCapsule)}`);
  if (faq.length) {
    lines.push("faq:");
    for (const item of faq) {
      lines.push(`  - q: ${quote(item.q)}`);
      lines.push(`    a: ${quote(item.a)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

const res = await fetch(`${ENGINE}/api/articles?limit=100`);
if (!res.ok) {
  console.error(`engine unreachable at ${ENGINE} (${res.status})`);
  process.exit(1);
}
const { articles } = await res.json();

let written = 0;
for (const article of articles) {
  // The answer capsule renders in its own highlighted box above the body; if
  // the body opens with the same paragraph, the reader sees it twice in a row.
  if (article.answerCapsule && Array.isArray(article.blocks) && article.blocks[0]?.type === "text") {
    const first = String(article.blocks[0].data?.content ?? "").replace(/<[^>]+>/g, "").trim();
    const capsule = String(article.answerCapsule).trim();
    if (first && capsule && (first.startsWith(capsule.slice(0, 80)) || capsule.startsWith(first.slice(0, 80)))) {
      article.blocks = article.blocks.slice(1);
    }
  }
  const { markdown, faq } = blocksToMarkdown(article.blocks);
  if (!markdown.trim()) continue;
  const image = article.heroImage?.startsWith("http") ? article.heroImage : bankImageFor(article);
  // The slug becomes a filename. Engine slugs are already sanitised, but a
  // filesystem write trusts nobody: strip anything path-like.
  const safeSlug = String(article.slug).replace(/[\/\\.]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeSlug) continue;
  const file = path.join(CONTENT_DIR, `${safeSlug}.md`);
  const next = `${frontmatter(article, image, faq)}\n\n${markdown}\n`;
  // Idempotent: only touch the file when the content actually changed, so
  // rebuilds are not triggered by a no-op sync.
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next) continue;
  fs.writeFileSync(file, next);
  written++;
  console.log(`✓ ${article.slug}`);
}
console.log(`${written} written, ${articles.length} published upstream`);

// llms.txt — the index AI crawlers read first. One line per published article,
// regenerated on every sync so it can never go stale.
const llms = [
  `# ${process.env.SITE_NAME || "Site"} — content index for AI assistants`,
  ``,
  ...articles.map(
    (a) => `- [${a.title}](/insights/${String(a.slug).replace(/[\/\\.]+/g, "-")}/): ${(a.metaDescription || a.summary || "").slice(0, 140)}`
  ),
  ``,
].join("\n");
fs.writeFileSync(path.join(ROOT, "public/llms.txt"), llms);
console.log("✓ llms.txt");
