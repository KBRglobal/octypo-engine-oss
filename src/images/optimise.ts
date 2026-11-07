/**
 * Turns a full-resolution stock download into web-ready WebP.
 *
 * This is the work the customer is actually paying for. A stock photo arrives
 * at 4000px and several megabytes; dropped onto a page unmodified it is the
 * single biggest reason a site scores badly on speed. The first prospect's own
 * site measured 14/100 on mobile performance, and oversized imagery was the
 * main cause.
 *
 * The customer buys a number of images, not an amount of storage. What the
 * files weigh after this step is our concern, not theirs — which is exactly why
 * this step has to be real and not a claim on a pricing page.
 */

import sharp from "sharp";

/**
 * Header images are rendered at most ~1600px wide in practice, and 2x that
 * covers retina. Anything beyond is bytes the visitor downloads and never sees.
 */
export const MAX_WIDTH = 2400;

/**
 * 82 sits at the point where WebP artefacts stop being visible on photographic
 * content while still cutting most of the weight. Higher barely improves what a
 * reader can see; lower starts showing banding in skies and gradients, which is
 * common in stock photography.
 */
export const WEBP_QUALITY = 82;

export interface OptimisedImage {
  data: Buffer;
  format: "webp";
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  /** e.g. 8.4 means the stored file is 8.4× smaller than what we downloaded. */
  compressionRatio: number;
}

export class ImageOptimiseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ImageOptimiseError";
  }
}

/**
 * Derivative sizes for a thumbnail or social card. Generated from the same
 * source so a set of images stays visually consistent.
 */
export const DERIVATIVE_WIDTHS = { thumbnail: 400, card: 1200 } as const;

export async function toWebp(
  input: Buffer,
  { maxWidth = MAX_WIDTH, quality = WEBP_QUALITY } = {}
): Promise<OptimisedImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new ImageOptimiseError("empty image buffer");
  }

  try {
    const pipeline = sharp(input, { failOn: "error" })
      // Strip EXIF: stock photos carry camera, software and sometimes GPS data
      // that has no business being republished on a customer's domain.
      .rotate() // apply EXIF orientation before the metadata is dropped
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality, effort: 4 });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      data,
      format: "webp",
      width: info.width,
      height: info.height,
      bytes: data.length,
      originalBytes: input.length,
      compressionRatio: Number((input.length / data.length).toFixed(2)),
    };
  } catch (error) {
    // A corrupt or unsupported download must not take down the publishing run —
    // the caller falls back to another candidate or to no image.
    throw new ImageOptimiseError("could not process image", error);
  }
}

/** Smaller renditions for cards and thumbnails, from the same source. */
export async function toDerivative(
  input: Buffer,
  width: number,
  quality = WEBP_QUALITY
): Promise<OptimisedImage> {
  return toWebp(input, { maxWidth: width, quality });
}
