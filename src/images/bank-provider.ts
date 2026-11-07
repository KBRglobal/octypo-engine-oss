/**
 * Image bank provider — the customer's own photographs first.
 *
 * A bank is a JSON manifest at a public URL (normally in the install's R2
 * bucket) listing real photos with alt text in the site language, a caption and topic tags.
 * For every hero or body slot the provider picks the best unused match by tag
 * and keyword overlap, and only when the bank has nothing left for the topic
 * does it hand the slot to the fallback provider (stock or generated).
 *
 * Why: generated still-lifes of "an object representing the topic" were
 * meaningless on a site whose whole subject is one physical product, and the
 * owner wants real photography wherever it exists. A bank entry is
 * used once per slot per article and never twice on the same article.
 *
 * Manifest shape (`version: 1`):
 *   { "version": 1, "images": [
 *       { "url": "https://…/bank/product/abc.webp", "alt": "…", "caption": "…",
 *         "tags": ["product", "street", "night"], "category": "product" } ] }
 */
import { logger } from "../lib/logger.js";
import { normaliseText } from "../lib/topic-terms.js";
import type { ArticleImageResult, ImageFetchOptions, ImageProvider } from "../lib/image-provider.js";

export interface BankImage {
  url: string;
  alt: string;
  caption?: string | null;
  tags?: string[];
  category?: string | null;
}

export interface BankManifest {
  version: number;
  images: BankImage[];
}

export interface BankProviderOptions {
  manifestUrl: string;
  fallback?: ImageProvider | null;
  fetchImpl?: typeof fetch;
  /** Manifest cache lifetime; the bank changes rarely. */
  ttlMs?: number;
  /** Below this score a bank image is not "about" the topic and the fallback runs. */
  minScore?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;

/** Word tokens of any script, normalised, two letters or more. */
export function tokenize(text: string): string[] {
  return [...new Set(normaliseText(text).split(" ").filter((token) => token.length >= 2))];
}

/**
 * How well one bank image fits a topic: tags count double, alt and caption
 * words once, and the whole-tag match of a keyword counts most of all.
 */
export function scoreImage(image: BankImage, topic: string, keywords: string[]): number {
  const wanted = new Set([...tokenize(topic), ...keywords.flatMap((k) => tokenize(k))]);
  if (wanted.size === 0) return 0;
  let score = 0;
  for (const tag of image.tags ?? []) {
    const lower = tag.toLowerCase();
    if (topic.toLowerCase().includes(lower) || keywords.some((k) => k.toLowerCase().includes(lower))) score += 4;
    for (const token of tokenize(tag)) if (wanted.has(token)) score += 2;
  }
  for (const token of tokenize(`${image.alt} ${image.caption ?? ""}`)) if (wanted.has(token)) score += 1;
  return score;
}

export function isBankManifest(value: unknown): value is BankManifest {
  if (!value || typeof value !== "object") return false;
  const images = (value as { images?: unknown }).images;
  return (
    Array.isArray(images) &&
    images.every(
      (img) =>
        !!img &&
        typeof img === "object" &&
        typeof (img as BankImage).url === "string" &&
        /^https:\/\/.+\.webp$/i.test((img as BankImage).url) &&
        typeof (img as BankImage).alt === "string" &&
        (img as BankImage).alt.trim().length >= 20
    )
  );
}

export class BankImageProvider implements ImageProvider {
  private cache: { at: number; manifest: BankManifest } | null = null;

  constructor(private readonly options: BankProviderOptions) {}

  async loadManifest(): Promise<BankManifest | null> {
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.manifest;
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(this.options.manifestUrl, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!isBankManifest(body)) throw new Error("manifest failed validation");
      this.cache = { at: Date.now(), manifest: body };
      return body;
    } catch (error) {
      logger.warn({ error, url: this.options.manifestUrl }, "[ImageBank] Manifest unavailable — using fallback");
      return this.cache?.manifest ?? null;
    }
  }

  /** Best unused bank images for a topic, strongest first. */
  async pick(topic: string, keywords: string[], count: number, exclude: readonly string[]): Promise<BankImage[]> {
    const manifest = await this.loadManifest();
    if (!manifest) return [];
    const minScore = this.options.minScore ?? 2;
    const excluded = new Set(exclude);
    return manifest.images
      .filter((img) => !excluded.has(img.url))
      .map((img) => ({ img, score: scoreImage(img, topic, keywords) }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(({ img }) => img);
  }

  private toResult(image: BankImage): ArticleImageResult {
    return { url: image.url, altText: image.alt, source: "bank", credit: image.caption ?? null };
  }

  async getArticleImage(
    topic: string,
    keywords: string[],
    category: string,
    options?: ImageFetchOptions
  ): Promise<ArticleImageResult | null> {
    // An explicit art-direction prompt asks for that picture, not the closest
    // bank photo: a bank hit would carry the plan's alt and caption while
    // showing something else.
    if (options?.prompt?.trim()) {
      return this.options.fallback ? this.options.fallback.getArticleImage(topic, keywords, category, options) : null;
    }
    const [best] = await this.pick(topic, keywords, 1, options?.excludeUrls ?? []);
    if (best) {
      logger.info({ topic, url: best.url }, "[ImageBank] Hero from the customer's bank");
      return this.toResult(best);
    }
    return this.options.fallback ? this.options.fallback.getArticleImage(topic, keywords, category, options) : null;
  }

  async getBodyImages(topic: string, keywords: string[], category: string, count: number): Promise<ArticleImageResult[]> {
    // Body slots may repeat a hero used elsewhere but never each other; the
    // caller filters the article's own hero through excludeUrls upstream.
    const picked = await this.pick(topic, keywords, count, []);
    const out = picked.map((img) => this.toResult(img));
    if (out.length >= count || !this.options.fallback?.getBodyImages) return out;
    const more = await this.options.fallback.getBodyImages(topic, keywords, category, count - out.length);
    return [...out, ...more.filter((img) => !out.some((o) => o.url === img.url))];
  }
}
