/**
 * One generated hero image, re-cropped into the exact three sizes a
 * git-delivered static site needs.
 *
 * `OpenAIImageProvider` (../lib/image-provider.ts) hands back a single WebP at
 * whatever aspect ratio gpt-image-1 produced (1536x1024). That is fine for a
 * WordPress featured image, but a statically-generated site with a fixed
 * design (fixed OG crop, fixed card aspect, a matching small variant for the
 * responsive srcset) needs three specific crops, not one arbitrary one. This
 * derives them from the already-generated, already-QA'd source image rather
 * than generating three separate images — cheaper, and guarantees the three
 * crops are the same photo.
 */

import sharp from "sharp";

import { requestBytes } from "../publishing/http.js";
import { createR2Uploader, type R2Config } from "./r2-upload.js";

export interface ArticleImageSet {
  /** 1200x630 — the fixed Open Graph / Twitter card crop. */
  share: string;
  /** 1200x675 (16:9) — the in-article and card-teaser image. */
  card: string;
  /** 640x360 (16:9) — the small responsive-srcset variant of `card`. */
  thumb: string;
}

const SPECS: { key: keyof ArticleImageSet; width: number; height: number; suffix: string }[] = [
  { key: "share", width: 1200, height: 630, suffix: "share" },
  { key: "card", width: 1200, height: 675, suffix: "1200" },
  { key: "thumb", width: 640, height: 360, suffix: "640" },
];

/** Never throws — a target that cannot derive images degrades to no image, not a crash. */
export async function deriveArticleImageSet(
  sourceUrl: string,
  slug: string,
  r2: R2Config
): Promise<ArticleImageSet | null> {
  try {
    const fetched = await requestBytes(sourceUrl);
    if (!fetched.ok) return null;

    const source = Buffer.from(fetched.bytes);
    const upload = createR2Uploader(r2);

    const entries = await Promise.all(
      SPECS.map(async spec => {
        const resized = await sharp(source)
          .resize(spec.width, spec.height, { fit: "cover" })
          .webp({ quality: 82 })
          .toBuffer();
        const url = await upload(resized, `articles/${slug}-${spec.suffix}.webp`, "image/webp");
        return [spec.key, url] as const;
      })
    );

    const result = Object.fromEntries(entries) as Record<keyof ArticleImageSet, string>;
    return result;
  } catch {
    return null;
  }
}
