import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { toWebp, toDerivative, ImageOptimiseError, MAX_WIDTH } from "./optimise.js";

/**
 * The compression here is what the customer is actually buying, and what makes
 * "sell a number of images, not gigabytes" a sound model. If it silently stopped
 * working we would be paying for full-size storage and shipping slow pages —
 * so it is tested against real encoded images, not mocks.
 */

/** A photographic-looking test image: gradients compress like real photos do. */
async function makePhoto(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = ((x + y) * 255) / (width + height);
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 92 }).toBuffer();
}

describe("WebP conversion", () => {
  it("converts a real JPEG to WebP", async () => {
    const out = await toWebp(await makePhoto(1600, 1000));
    expect(out.format).toBe("webp");
    // Verify by decoding the output, not by trusting our own label.
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
  });

  it("actually makes the file smaller", async () => {
    const source = await makePhoto(3000, 2000);
    const out = await toWebp(source);
    expect(out.bytes).toBeLessThan(out.originalBytes);
    expect(out.compressionRatio).toBeGreaterThan(1);
  });

  it("caps oversized stock downloads at the header width", async () => {
    // Stock originals arrive at 4000px+; serving that is the speed problem.
    const out = await toWebp(await makePhoto(4000, 2600));
    expect(out.width).toBe(MAX_WIDTH);
    expect(out.height).toBeGreaterThan(0);
  });

  it("never enlarges an image that is already small", async () => {
    const out = await toWebp(await makePhoto(900, 600));
    expect(out.width).toBe(900);
  });

  it("strips EXIF metadata", async () => {
    // Stock files carry camera, software and sometimes GPS data that must not
    // be republished on a customer's domain.
    const withExif = await sharp(await makePhoto(1200, 800))
      .withMetadata({ exif: { IFD0: { Copyright: "Test Photographer", Software: "TestCam" } } })
      .jpeg()
      .toBuffer();
    const out = await toWebp(withExif);
    const meta = await sharp(out.data).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("produces smaller derivatives for cards and thumbnails", async () => {
    const source = await makePhoto(3000, 2000);
    const card = await toDerivative(source, 1200);
    const thumb = await toDerivative(source, 400);
    expect(card.width).toBe(1200);
    expect(thumb.width).toBe(400);
    expect(thumb.bytes).toBeLessThan(card.bytes);
  });

  it("throws a typed error on a corrupt download instead of crashing the run", async () => {
    await expect(toWebp(Buffer.from("this is not an image"))).rejects.toBeInstanceOf(
      ImageOptimiseError
    );
  });

  it("rejects an empty buffer", async () => {
    await expect(toWebp(Buffer.alloc(0))).rejects.toBeInstanceOf(ImageOptimiseError);
  });
});
