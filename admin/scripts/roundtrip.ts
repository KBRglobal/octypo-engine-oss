/**
 * Round-trip test for the blocks conversion:
 *   engine blocks → HTML → engine blocks
 *
 * Run from the repo root:  npx tsx admin/scripts/roundtrip.ts
 * Fails (non-zero exit via thrown error) if content is lost.
 */

import {
  engineBlocksToHTML,
  htmlToEngineBlocks,
  engineBlocksToPlainText,
  type EngineBlock,
} from "../src/lib/blocks.js";

const sampleEngineBlocks: EngineBlock[] = [
  {
    type: "text",
    id: "intro-1",
    data: {
      content:
        "<p>You can deploy the Octypo engine in under 10 minutes. The setup needs Node 20, Postgres 16 and a single API key.</p><p>This guide walks through every step with concrete commands.</p>",
    },
  },
  { type: "heading", id: "h-1", data: { text: "What to Expect", level: 2 } },
  {
    type: "text",
    id: "s-1",
    data: {
      content:
        "Plain text content without wrapping tags — including <strong>inline bold</strong> and an &amp; entity.",
    },
  },
  {
    type: "image",
    id: "img-1",
    data: {
      url: "https://example.com/hero.jpg",
      alt: "Server racks in a datacenter",
      caption: "Photo: Example / Unsplash",
    },
  },
  { type: "heading", id: "h-2", data: { text: "How Do You Install It?", level: 3 } },
  {
    type: "list",
    id: "l-1",
    data: {
      items: ["Clone the repository", "Run <code>npm install</code>", "Apply the schema with db:migrate"],
      style: "unordered",
    },
  },
  {
    type: "faq",
    id: "faq-1",
    data: {
      items: [
        {
          question: "How long does setup take?",
          answer: "Setup takes about 10 minutes on a clean machine, including the database.",
        },
        {
          question: "What does it cost to run?",
          answer: "You can run the engine for roughly $5/month on Railway's hobby plan.",
        },
      ],
    },
  },
  // RTL content — must survive untouched
  { type: "heading", id: "h-3", data: { text: "ما الخطوة التالية؟", level: 2 } },
  {
    type: "text",
    id: "s-2",
    data: { content: "<p>يكتب المحرك المقالات تلقائيا وأنت تتحكم في كل خطوة من لوحة التحكم.</p>" },
  },
];

function fail(message: string): never {
  console.error(`✗ ROUND-TRIP FAILED: ${message}`);
  throw new Error(message);
}

// ── 1. engine → HTML ──────────────────────────────────────────────────────
const html = engineBlocksToHTML(sampleEngineBlocks);
console.log("— engine → HTML —\n" + html + "\n");

// ── 2. HTML → engine ──────────────────────────────────────────────────────
const roundTripped = htmlToEngineBlocks(html);
console.log("— HTML → engine —");
for (const b of roundTripped) console.log(`  [${b.type}]`, JSON.stringify(b.data).slice(0, 110));
console.log();

// ── 3. content preservation checks ────────────────────────────────────────
const before = engineBlocksToPlainText(sampleEngineBlocks);
const after = engineBlocksToPlainText(roundTripped);

if (before !== after) {
  console.error("BEFORE:", before);
  console.error("AFTER :", after);
  fail("plain-text content differs after round-trip");
}

// Headings preserved with levels
const headingsBefore = sampleEngineBlocks
  .filter(b => b.type === "heading")
  .map(b => `${b.data.level}:${b.data.text}`);
const headingsAfter = roundTripped
  .filter(b => b.type === "heading")
  .map(b => `${b.data.level}:${b.data.text}`);
// FAQ questions become h3 headings — expected, count them in
const faqQuestions = (sampleEngineBlocks.find(b => b.type === "faq")?.data.items as any[]).map(
  i => `3:${i.question}`
);
const expectedHeadings = [...headingsBefore];
expectedHeadings.splice(expectedHeadings.length - 1, 0, ...faqQuestions); // FAQ block sits before the last heading
if (JSON.stringify(expectedHeadings.sort()) !== JSON.stringify([...headingsAfter].sort())) {
  console.error("expected:", expectedHeadings, "\ngot     :", headingsAfter);
  fail("headings/levels not preserved");
}

// Image preserved with url + alt + caption
const img = roundTripped.find(b => b.type === "image");
if (!img) fail("image block lost");
if (img.data.url !== "https://example.com/hero.jpg") fail("image url changed");
if (img.data.alt !== "Server racks in a datacenter") fail("image alt changed");
if (img.data.caption !== "Photo: Example / Unsplash") fail("image caption lost");

// List preserved
const list = roundTripped.find(b => b.type === "list");
if (!list) fail("list block lost");
if ((list.data.items as string[]).length !== 3) fail("list items lost");
if (!(list.data.items as string[])[1].includes("<code>npm install</code>"))
  fail("inline HTML inside list item lost");

// Second-pass stability: HTML → blocks → HTML → blocks must be identical content
const secondHtml = engineBlocksToHTML(roundTripped);
const secondPass = htmlToEngineBlocks(secondHtml);
if (engineBlocksToPlainText(secondPass) !== after) fail("second pass not stable");

console.log("✓ Round-trip OK — content, headings, images, lists and RTL text preserved");
console.log(`  blocks: ${sampleEngineBlocks.length} in → ${roundTripped.length} out (FAQ expands to h3+p pairs by design)`);
