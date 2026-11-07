/**
 * Turn a folder of generated images into the site's image bank.
 *
 * Drop the generated files into one subfolder per image category, named
 * after a word that appears in your article tags, categories or titles (plus
 * general/ as the fallback), under any source directory, then:
 *
 *   node scripts/ingest-image-bank.mjs ~/Downloads/bank-source
 *
 * Every image is converted to WebP at 1600px wide and named
 * <category>-NN.webp in public/images/bank/, which is exactly the layout
 * the sync script picks from. Re-running continues the numbering.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BANK = path.join(ROOT, "public/images/bank");

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("usage: node scripts/ingest-image-bank.mjs <source-dir with one subfolder per category>");
  process.exit(1);
}

fs.mkdirSync(BANK, { recursive: true });

const nextIndex = (category) => {
  const taken = fs
    .readdirSync(BANK)
    .map((f) => new RegExp(`^${category}-(\\d+)\\.webp$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return (taken.length ? Math.max(...taken) : 0) + 1;
};

let total = 0;
const categories = fs
  .readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
for (const category of categories) {
  const dir = path.join(source, category);
  let index = nextIndex(category);
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
  for (const file of files) {
    const out = path.join(BANK, `${category}-${String(index).padStart(2, "0")}.webp`);
    await sharp(path.join(dir, file)).resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
    index++;
    total++;
    console.log(`✓ ${path.basename(out)}  ← ${category}/${file}`);
  }
}
console.log(`${total} images in the bank (${BANK})`);
