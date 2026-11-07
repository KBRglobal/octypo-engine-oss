/**
 * Cloudinary as a delivery target for article imagery.
 *
 * R2 stores a file and serves exactly that file. Cloudinary stores an original
 * and derives what each visitor should actually receive — AVIF for a browser
 * that takes it, WebP for one that does not, sized to the request — from one
 * URL. That is the difference the "fast images" add-on is sold on, so it is
 * gated on the `cdn-delivery` entitlement rather than on merely having keys.
 *
 * Upload is signed rather than unsigned: an unsigned preset is a public write
 * endpoint for the customer's media library, and the signature is four lines.
 */

import { createHash } from "node:crypto";

import { logger } from "../lib/logger.js";

const API_BASE = "https://api.cloudinary.com/v1_1";
const DELIVERY_BASE = "https://res.cloudinary.com";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `f_auto` picks the format per browser and `q_auto` picks the quality per
 * image. Both are why the file that leaves the CDN is smaller than the one that
 * went in, without a second stored copy.
 */
export const DEFAULT_TRANSFORM = "f_auto,q_auto";

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Everything the engine uploads lands here, apart from the customer's own media. */
  folder?: string;
  transform?: string;
  timeoutMs?: number;
}

export function cloudinaryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudinaryConfig | null {
  const cloudName = env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = env.CLOUDINARY_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) return null;

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: env.CLOUDINARY_FOLDER?.trim() || "octypo",
    transform: env.CLOUDINARY_TRANSFORM?.trim() || DEFAULT_TRANSFORM,
  };
}

/**
 * Cloudinary's signature: every signed parameter except `file`, `api_key` and
 * `resource_type`, sorted by name, joined as a query string, with the API
 * secret appended, SHA-1'd.
 */
export function signParams(params: Record<string, string>, apiSecret: string): string {
  const payload = Object.keys(params)
    .filter((key) => key !== "file" && key !== "api_key" && key !== "resource_type")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash("sha1").update(`${payload}${apiSecret}`).digest("hex");
}

/** A storage key becomes a public id: no extension, no leading slash. */
export function publicIdFor(key: string, folder?: string): string {
  const withoutExtension = key.replace(/\.[a-z0-9]+$/i, "").replace(/^\/+/, "");
  return folder ? `${folder}/${withoutExtension}` : withoutExtension;
}

export function deliveryUrl(config: CloudinaryConfig, publicId: string, format = "auto"): string {
  const transform = config.transform || DEFAULT_TRANSFORM;
  const suffix = format === "auto" ? "" : `.${format}`;
  return `${DELIVERY_BASE}/${config.cloudName}/image/upload/${transform}/${publicId}${suffix}`;
}

export interface CloudinaryUploadOptions {
  fetchImpl?: typeof fetch;
  /** Injected only by tests; production stamps the real clock. */
  now?: () => number;
}

/**
 * Uploads bytes and returns the delivery URL.
 *
 * `overwrite` plus a stable public id makes a re-run idempotent: regenerating
 * an article's image replaces it rather than accumulating a second copy the
 * customer pays to store.
 */
export async function uploadToCloudinary(
  config: CloudinaryConfig,
  data: Buffer,
  key: string,
  contentType: string,
  { fetchImpl = fetch, now = Date.now }: CloudinaryUploadOptions = {}
): Promise<string> {
  const publicId = publicIdFor(key, config.folder);
  const timestamp = String(Math.floor(now() / 1000));

  const signed: Record<string, string> = {
    public_id: publicId,
    timestamp,
    overwrite: "true",
    invalidate: "true",
  };

  const form = new FormData();
  for (const [name, value] of Object.entries(signed)) form.append(name, value);
  form.append("api_key", config.apiKey);
  form.append("signature", signParams(signed, config.apiSecret));
  form.append("file", new Blob([new Uint8Array(data)], { type: contentType }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch = fetchImpl;
    const res = await doFetch(`${API_BASE}/${config.cloudName}/image/upload`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Cloudinary upload failed with ${res.status}`);
    }
    const body = (await res.json()) as { public_id?: unknown };
    const returnedId = typeof body.public_id === "string" ? body.public_id : publicId;
    return deliveryUrl(config, returnedId);
  } finally {
    clearTimeout(timer);
  }
}

/** An uploader with the signature the image pipeline already uses. */
export function createCloudinaryUploader(
  config: CloudinaryConfig,
  options: CloudinaryUploadOptions = {}
) {
  logger.info({ cloud: config.cloudName, folder: config.folder }, "[Cloudinary] Delivery enabled");
  return (data: Buffer, key: string, contentType: string) =>
    uploadToCloudinary(config, data, key, contentType, options);
}
