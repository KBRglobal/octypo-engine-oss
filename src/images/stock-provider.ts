/**
 * Article images, with a different strategy for the hero and the body.
 *
 * Measurement drove this split. Searching stock for a specific article subject
 * found a relevant photograph only about half the time — "LED screens for
 * municipal events" and "truck-mounted LED screen rental" are not things anyone
 * photographed and tagged. Loosening the search to fill the gap was worse: it
 * returned a laptop on a desk for an advertising-truck article, and "right or
 * wrong" clipart for an article about choosing a supplier.
 *
 * So:
 * - The HERO must be about this specific article. Stock rarely has it, so the
 *   hero is generated when stock cannot match the subject closely.
 * - BODY images only have to suit the article's world, not its exact subject.
 *   Broad stock is genuinely good at that, and it is free.
 *
 * This also matches what the content actually is: across a hundred articles a
 * month most are topical pieces, not photographs of the customer's own product.
 *
 * Generation is kept away from people entirely — roughly half of generated
 * images containing people show anatomical distortion, and there is no reliable
 * way to catch it before it reaches a customer's live site.
 *
 * Licence obligations are enforced here rather than trusted to a prompt. See
 * topic-safety.ts: Pixabay forbids their content in political and medical
 * contexts outright, and with no human reviewing images the only way to honour
 * that is to refuse before searching.
 */

import type { ArticleImageResult, ImageFetchOptions, ImageProvider } from "../lib/image-provider.js";
import { logger } from "../lib/logger.js";
import { searchAllProviders, type StockKeys } from "./providers.js";
import { rankCandidates } from "./relevance.js";
import { checkImageTopicSafety } from "./topic-safety.js";
import { toWebp } from "./optimise.js";
import { buildQueryLadder } from "./query-ladder.js";
import { needsTranslation, translateQuery, type QueryTranslator } from "./query-language.js";

export interface StockImageUploader {
  /** Stores the optimised bytes and returns a public URL. */
  (data: Buffer, key: string, contentType: string): Promise<string>;
}

export interface StockProviderOptions {
  keys: StockKeys;
  upload: StockImageUploader;
  /** Used when stock declines — normally the existing generation provider. */
  fallback?: ImageProvider | null;
  fetchImpl?: typeof fetch;
  /**
   * Compress and convert to WebP before storing. Optimisation is a paid add-on
   * (it is what makes the customer's storage and delivery cheap), so a customer
   * who did not buy it gets the original bytes instead of silently receiving a
   * service they are not paying for. See `src/config/entitlements.ts`.
   *
   * Defaults to true: a direct construction, and every existing test, behaves
   * exactly as before.
   */
  optimise?: boolean;
  /**
   * Turns a non-Latin topic into an English stock-photo query. Stock libraries
   * are indexed in English, so without this every article for a non-English customer
   * publishes with no image. Injected so tests never reach a model.
   */
  translate?: QueryTranslator;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

interface PreparedImage {
  data: Buffer;
  extension: string;
  contentType: string;
  savedKb: number;
}

/**
 * Which slot an image is for. The hero carries the article's identity and is
 * held to the subject; body images illustrate and are held only to the theme.
 */
export type ImageSlot = "hero" | "body";

/**
 * Stock search engines match plain nouns, not article headlines. "How LED
 * trucks reach customers in Lyon, and what it costs" finds nothing; "led
 * truck advertising" finds the right photographs.
 */
/** Filler that dilutes a stock search without adding any visual signal. */
const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "your", "how", "what", "why", "when", "where",
  "complete", "guide", "best", "top", "ultimate", "everything", "about",
  "from", "that", "this", "into", "over", "you", "our", "are", "can",
]);

export function toSearchQuery(topic: string, keywords: readonly string[] = []): string {
  const fromKeywords = keywords.filter(Boolean).slice(0, 2).join(" ").trim();
  if (fromKeywords) return fromKeywords;

  return topic
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUERY_STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .join(" ")
    .trim();
}

/**
 * Is this candidate already in use on another article (SEO-E)?
 *
 * `excludeUrls` carries what `contents.heroImage`/`cardImage` actually store —
 * the UPLOADED delivery URL (R2/Cloudinary), never the stock download URL, so
 * a plain `includes(c.url)` comparison alone would never fire in production.
 * The stored key embeds the candidate identity (`…-${provider}-${id}.ext`,
 * with an optional R2 content-hash suffix before the extension), so the guard
 * matches on that identity as well as on the raw source URL.
 */
function isExcluded(
  candidate: { url: string; provider: string; id: string | number },
  excludeUrls: string[] | undefined
): boolean {
  if (!excludeUrls?.length) return false;
  const identity = `-${candidate.provider}-${candidate.id}`;
  return excludeUrls.some(
    (u) => u === candidate.url || u.includes(`${identity}.`) || u.includes(`${identity}-`)
  );
}

export class StockImageProvider implements ImageProvider {
  constructor(private readonly options: StockProviderOptions) {}

  /**
   * Body images: illustrate the article's world rather than its exact subject,
   * so the broader rungs of the query ladder are acceptable here. Returns as
   * many distinct images as asked for, and never generates — a body image is a
   * nice-to-have, not worth the cost or the anatomy risk.
   */
  async getBodyImages(
    topic: string,
    keywords: string[],
    category: string,
    count: number
  ): Promise<ArticleImageResult[]> {
    const safety = checkImageTopicSafety(topic, ...(keywords ?? []), category);
    if (!safety.safe) return [];

    const out: ArticleImageResult[] = [];
    const used = new Set<string>();

    for (const query of await this.queriesFor(topic, keywords)) {
      if (out.length >= count) break;

      const candidates = await searchAllProviders(query, this.options.keys, {
        fetchImpl: this.options.fetchImpl,
      });
      // Scored against the query rather than the headline: a body image only
      // has to depict what was searched for.
      const hits = rankCandidates(query, candidates).filter((c) => !used.has(c.url));

      for (const hit of hits) {
        if (out.length >= count) break;
        const stored = await this.storeCandidate(topic, hit);
        if (stored) {
          used.add(hit.url);
          out.push(stored);
        }
      }
    }

    return out;
  }

  /**
   * The queries to try, in order.
   *
   * A non-Latin topic is translated once and the ladder is rebuilt from the English
   * result; the original is kept as a last rung, because a proper noun sometimes
   * matches even untranslated.
   */
  private async queriesFor(topic: string, keywords: string[]): Promise<string[]> {
    const ladder = buildQueryLadder(topic, keywords);
    const first = ladder[0] ?? topic;
    if (!needsTranslation(first)) return ladder;

    const translator = this.options.translate ?? translateQuery;
    const english = await translator(`${topic} ${keywords.join(" ")}`.trim());
    if (!english) return ladder;
    // The sensitive-topic list is English, so the translation is the first
    // point where a non-Latin topic can be judged against it.
    if (!checkImageTopicSafety(english).safe) return [];

    return [...buildQueryLadder(english, []), ...ladder];
  }

  /**
   * WebP conversion when the customer is entitled to it, the original bytes
   * when they are not. Either way the caller gets bytes, an extension and a
   * content type that agree with each other — a `.webp` key holding a JPEG is
   * the kind of mismatch a CDN caches for a year.
   */
  private async prepare(raw: Buffer, contentTypeHeader: string | null): Promise<PreparedImage> {
    if (this.options.optimise === false) {
      const declared = (contentTypeHeader ?? "").split(";")[0].trim().toLowerCase();
      const contentType = EXTENSION_BY_TYPE[declared] ? declared : "image/jpeg";
      return {
        data: raw,
        extension: EXTENSION_BY_TYPE[contentType] ?? "jpg",
        contentType,
        savedKb: 0,
      };
    }

    const optimised = await toWebp(raw);
    return {
      data: optimised.data,
      extension: "webp",
      contentType: "image/webp",
      savedKb: Math.round((optimised.originalBytes - optimised.bytes) / 1024),
    };
  }

  /** Downloads, optimises and uploads one candidate. Null on any failure. */
  private async storeCandidate(
    topic: string,
    best: { url: string; id: string; provider: string; description: string; photographer?: string | null }
  ): Promise<ArticleImageResult | null> {
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const res = await doFetch(best.url);
      if (!res.ok) return null;

      const raw = Buffer.from(await res.arrayBuffer());
      const prepared = await this.prepare(raw, res.headers.get("content-type"));
      const key = `articles/${slugForKey(topic)}-${best.provider}-${best.id}.${prepared.extension}`;
      const url = await this.options.upload(prepared.data, key, prepared.contentType);

      return {
        url,
        altText: buildAltText(topic, best.description),
        source: `stock:${best.provider}`,
        credit: best.photographer ?? null,
      };
    } catch (error) {
      logger.warn({ topic, provider: best.provider, error }, "[StockImage] Candidate failed");
      return null;
    }
  }

  async getArticleImage(
    topic: string,
    keywords: string[],
    category: string,
    options?: ImageFetchOptions
  ): Promise<ArticleImageResult | null> {
    // Same rule as the bank: a stock photo cannot honour an exact prompt.
    if (options?.prompt?.trim()) {
      return this.options.fallback ? this.options.fallback.getArticleImage(topic, keywords, category, options) : null;
    }
    const safety = checkImageTopicSafety(topic, ...(keywords ?? []), category);
    if (!safety.safe) {
      // Not a soft preference: using stock here would breach the licence on the
      // customer's own domain. Generation is ours outright, so it is still allowed.
      logger.warn(
        { topic, category: safety.category },
        `[StockImage] Refusing stock for a restricted subject — ${safety.reason}`
      );
      return this.generate(topic, keywords, category, options);
    }

    // One query built from the article's own words finds nothing about half the
    // time — stock libraries index what is visibly in frame, not what an article
    // is about. Walk outward from the exact subject to a scene that stands in
    // for it, stopping at the first rung that clears the relevance bar.
    let ranked: ReturnType<typeof rankCandidates> = [];
    let usedQuery = "";

    // Only the specific rungs. The hero carries the article's identity, so a
    // stand-in scene is not good enough here — if stock cannot match the actual
    // subject, generation produces something that can.
    for (const query of (await this.queriesFor(topic, keywords)).slice(0, 2)) {
      const candidates = await searchAllProviders(query, this.options.keys, {
        fetchImpl: this.options.fetchImpl,
      });
      // Rank against the query that was actually searched, not the raw topic:
      // for a non-English article the topic is not English and every candidate's
      // description is English, so scoring against the topic makes overlap
      // structurally zero and rejects every photo the search just found.
      const hits = rankCandidates(query, candidates).filter(
        (c) => !isExcluded(c, options?.excludeUrls)
      );
      if (hits.length > 0) {
        ranked = hits;
        usedQuery = query;
        break;
      }
    }

    if (ranked.length === 0) {
      logger.info({ topic }, "[StockImage] No relevant stock match at any query rung");
      return this.generate(topic, keywords, category, options);
    }

    // Try the best matches in order — a download can fail or return something
    // sharp cannot decode, and that must not cost the article its image.
    for (const best of ranked.slice(0, 3)) {
      try {
        const doFetch = this.options.fetchImpl ?? fetch;
        const res = await doFetch(best.url);
        if (!res.ok) continue;

        const raw = Buffer.from(await res.arrayBuffer());
        const prepared = await this.prepare(raw, res.headers.get("content-type"));
        const key = `articles/${slugForKey(topic)}-${best.provider}-${best.id}.${prepared.extension}`;
        const url = await this.options.upload(prepared.data, key, prepared.contentType);

        logger.info(
          {
            topic,
            provider: best.provider,
            query: usedQuery,
            relevance: Number(best.relevance.score.toFixed(2)),
            savedKb: prepared.savedKb,
          },
          "[StockImage] Stock image selected"
        );

        return {
          url,
          altText: buildAltText(topic, best.description),
          source: `stock:${best.provider}`,
          credit: best.photographer ?? null,
        };
      } catch (error) {
        logger.warn({ topic, provider: best.provider, error }, "[StockImage] Candidate failed, trying next");
      }
    }

    return this.generate(topic, keywords, category, options);
  }

  private async generate(
    topic: string,
    keywords: string[],
    category: string,
    options?: ImageFetchOptions
  ): Promise<ArticleImageResult | null> {
    const fallback = this.options.fallback;
    if (!fallback) return null;
    return fallback.getArticleImage(topic, keywords, category, options);
  }
}

function slugForKey(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "article";
}

/**
 * Alt text must describe the image, not repeat the headline — Google's own
 * guidance ranks "Dalmatian puppy playing fetch" above "puppy" and calls
 * keyword-stuffed alt text a fault. The stock description is a real sentence
 * about what is depicted, so it is preferred when present.
 */
export function buildAltText(topic: string, description: string): string {
  const clean = description.replace(/\s+/g, " ").trim();
  if (clean.length >= 15) return clean.slice(0, 125);
  return topic.replace(/\s+/g, " ").trim().slice(0, 125);
}
