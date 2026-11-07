/**
 * Stores optimised images in the R2 bucket the engine already uses.
 *
 * R2 is the reason the hosting economics work at all: egress is free at any
 * volume, so a customer whose article goes viral costs us nothing extra in
 * bandwidth. That is the single largest variable cost in this category
 * everywhere else — it is what every image-CDN competitor is fundamentally
 * metering.
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

export interface R2Config {
  bucket: string;
  publicBase: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = env.R2_S3_ENDPOINT?.trim();
  const publicBase = env.R2_PUBLIC_BASE_URL?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint || !publicBase) return null;
  return {
    bucket: env.R2_BUCKET?.trim() || "octypo-media",
    publicBase: publicBase.replace(/\/+$/, ""),
    endpoint,
    accessKeyId,
    secretAccessKey,
  };
}

export function createR2Uploader(config: R2Config) {
  const s3 = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return async function upload(data: Buffer, key: string, contentType: string): Promise<string> {
    // Content hash in the key means re-publishing the same article reuses the
    // same object instead of accumulating duplicates, and lets us cache
    // immutably for a year.
    const hash = createHash("sha1").update(data).digest("hex").slice(0, 10);
    const finalKey = key.replace(/(\.[a-z0-9]+)$/i, `-${hash}$1`);

    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: finalKey,
        Body: data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    return `${config.publicBase}/${finalKey}`;
  };
}
