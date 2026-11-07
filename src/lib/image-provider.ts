/**
 * Pluggable image provider.
 *
 * By default the engine selects a real provider when the required keys are
 * present (OpenAIImageProvider: gpt-image-1 → R2 public bucket), and falls
 * back to NullImageProvider (articles publish without images) otherwise.
 *
 * Selection is driven entirely by env so the engine stays domain-neutral.
 * Override at startup with setImageProvider() if you need a custom one.
 */

import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { StockImageProvider, type StockImageUploader } from "../images/stock-provider.js";
import { BankImageProvider } from "../images/bank-provider.js";
import { cloudinaryConfigFromEnv, createCloudinaryUploader } from "../images/cloudinary.js";
import { createR2Uploader, r2ConfigFromEnv } from "../images/r2-upload.js";
import { logger } from "./logger.js";
import { entitled } from "../config/entitlements.js";
import { meterImageGeneration } from "../cost/index.js";
import { CONTENT_DOMAIN } from "../config/domain.js";

export interface ArticleImageResult {
  url: string;
  altText: string;
  source: string;
  credit?: string | null;
}

export interface ImageFetchOptions {
  excludeUrls?: string[];
  unsplashOnly?: boolean;
  skipLibrary?: boolean;
  /** Exact art-direction prompt supplied by an approved content pack. */
  prompt?: string;
  /** Human-written alt text that must survive generation unchanged. */
  altText?: string;
}

export interface ImageProvider {
  /** Find or create an image for an article topic. Return null when unavailable. */
  getArticleImage(
    topic: string,
    keywords: string[],
    category: string,
    options?: ImageFetchOptions
  ): Promise<ArticleImageResult | null>;

  /**
   * Optional. Images that illustrate the article without having to depict its
   * exact subject. A provider that cannot distinguish the two slots simply
   * omits this and the caller falls back to getArticleImage.
   */
  getBodyImages?(
    topic: string,
    keywords: string[],
    category: string,
    count: number
  ): Promise<ArticleImageResult[]>;
}

/** Default provider — articles are published without images. */
export class NullImageProvider implements ImageProvider {
  async getArticleImage(): Promise<ArticleImageResult | null> {
    return null;
  }
}

// ============================================
// OpenAI (gpt-image-1) → R2 provider
// ============================================

const OPENAI_IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 60_000;
const OPENAI_IMAGE_QA_TIMEOUT_MS = 45_000;
const MAX_IMAGE_ATTEMPTS = 3;

/**
 * Brand-consistent editorial illustration provider.
 * Generates a hero via OpenAI gpt-image-1, uploads the PNG to a public R2
 * bucket, and returns the public URL + a clean alt string. Any failure is
 * caught and returns null so the publish pipeline is never blocked.
 */
export class OpenAIImageProvider implements ImageProvider {
  private readonly apiKey: string;
  private readonly bucket: string;
  private readonly publicBase: string;
  private readonly s3: S3Client;

  constructor(config: {
    apiKey: string;
    bucket: string;
    publicBase: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) {
    this.apiKey = config.apiKey;
    this.bucket = config.bucket;
    this.publicBase = config.publicBase.replace(/\/$/, "");
    this.s3 = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  /** Derive a concise, clean visual subject from the article title. */
  private buildSubject(topic: string): string {
    // Keep letters in any script: a non-Latin headline stripped to [a-z0-9] is an
    // empty subject, and an empty subject is how every hero ends up generic.
    return topic
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  /** Brand style preamble + the article subject, unless the pack supplies one. */
  private buildPrompt(topic: string, customPrompt?: string): string {
    if (customPrompt?.trim()) {
      const positivePrompt = customPrompt
        .trim()
        .replace(
          /,\s*no people,\s*no robot,\s*no logo,\s*no words,\s*no interface text\.?/gi,
          "."
        )
        .replace(/without labels/gi, "using unlabeled physical forms")
        .replace(
          /no embedded symbols that require explanation/gi,
          "using only simple blank physical forms"
        );
      return (
        positivePrompt +
        " Every physical surface is blank and unmarked. Use plain tactile geometry, " +
        "dark empty screens, and abstract shapes in place of labels, letters, numerals, " +
        "logos, captions, icons, signage, or interface elements. The set is an unoccupied " +
        "object-only still life."
      );
    }

    const subject = this.buildSubject(topic);
    const customStyle = process.env.IMAGE_STYLE_PROMPT?.trim();

    // A customer with their own visual identity gets a real scene about the
    // article's subject in that identity. The house look below is an
    // object-only still life, and forcing that composition on top of a
    // customer's style produced brand-foreign images (a lone object on a
    // tabletop for a site whose every photo is a place with people).
    if (customStyle) {
      return (
        `${customStyle} ` +
        `The image is for an article about: "${subject}". Show the actual place, event or experience ` +
        "the article is about, as a real moment, composed like a premium editorial photograph. " +
        "Absolutely no text, letters, numerals, logos, brand marks, flags or signage anywhere in the image — " +
        "sails, shirts, vehicles, banners and buildings are plain and unbranded; " +
        "any people are part of the scene, seen from behind, in profile or at a distance, never a close-up face."
      );
    }

    const style =
      `Premium cinematic editorial still-life for a ${CONTENT_DOMAIN} guide. ` +
      "Near-black background, warm ivory materials, vivid orange practical light, " +
      "tactile surfaces, deep blacks, controlled highlights and clean negative space. ";

    return (
      style +
      `The single visual subject represents: ${subject}. ` +
      "The scene is an unoccupied still-life studio composition: only the object " +
      "and its reflection are present, every surface is clean and unmarked, and " +
      "all signage, screens and printed material are absent from the set. " +
      "Composition is object-only, shot as a tabletop product still life."
    );
  }

  private slugify(topic: string): string {
    return (
      topic
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(?:^-|-$)/g, "")
        .slice(0, 60) || "hero"
    );
  }

  private async generateBuffer(prompt: string): Promise<Buffer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(OPENAI_IMAGE_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt,
          size: "1536x1024",
          quality: "medium",
          n: 1,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      logger.warn(
        { status: response.status, body: errBody.slice(0, 500) },
        "[ImageProvider] OpenAI image generation failed"
      );
      return null;
    }

    meterImageGeneration({ model: "gpt-image-1", size: "1536x1024", quality: "medium" });
    const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = payload.data?.[0]?.b64_json;
    return b64 ? Buffer.from(b64, "base64") : null;
  }

  private async inspectBuffer(
    buffer: Buffer,
    altText: string
  ): Promise<{ pass: boolean; reason: string }> {
    const enabled = (process.env.ENABLE_IMAGE_QA || "true").toLowerCase();
    if (["false", "0", "no", "off"].includes(enabled)) return { pass: true, reason: "disabled" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_IMAGE_QA_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_IMAGE_QA_MODEL?.trim() || "gpt-4.1-mini",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    "Inspect the visible pixels as a strict pre-publication image reviewer. " +
                    `Expected contextual alt text: ${altText}. ` +
                    (process.env.IMAGE_STYLE_PROMPT?.trim()
                      ? // The customer's own style is the reference — never the house palette.
                        `Pass when the image plausibly matches this intended visual style: "${process.env.IMAGE_STYLE_PROMPT.trim()}". ` +
                        "People are allowed as part of the scene (from behind, in profile, or at a distance); reject only " +
                        "a close-up, clearly identifiable face. "
                      : "Pass when the image is either a realistic premium cinematic still life or a " +
                        "polished premium 3D editorial still-life render with convincing materials and " +
                        "lighting. Near-black and warm ivory should lead the palette, while vivid orange " +
                        "may be an accent rather than a dominant color. Abstract, symbolic and simplified " +
                        "physical objects may reasonably support the alt subject; do not require a literal " +
                        "depiction or written explanation. ") +
                    (process.env.IMAGE_STYLE_PROMPT?.trim() ? "Reject robots, readable or " : "Reject visible people or robots, readable or ") +
                    "invented letters, words, numerals, labels, captions, logos, signage, interface " +
                    "text, clearly text-like glyph clusters, or severe visual artifacts. Blank layout " +
                    "lines, simple diagrams, dark screens and unlabeled geometric forms are not text. " +
                    "Do not fail solely because the image is stylized, because a color is only an accent, " +
                    "or because the alt explains the intended meaning of unlabeled elements. " +
                    "Write the reason as one short English sentence.",
                },
                {
                  type: "input_image",
                  image_url: `data:image/png;base64,${buffer.toString("base64")}`,
                  // Real scenes carry small text (sails, shirts, signs) that a
                  // low-detail look misses; the house still-life never did.
                  detail: process.env.IMAGE_STYLE_PROMPT?.trim() ? "high" : "low",
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "image_qa",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  pass: { type: "boolean" },
                  unwantedText: { type: "boolean" },
                  peopleOrRobots: { type: "boolean" },
                  styleMatch: { type: "boolean" },
                  subjectMatch: { type: "boolean" },
                  severeArtifact: { type: "boolean" },
                  reason: { type: "string" },
                },
                required: [
                  "pass",
                  "unwantedText",
                  "peopleOrRobots",
                  "styleMatch",
                  "subjectMatch",
                  "severeArtifact",
                  "reason",
                ],
              },
            },
          },
          // 180 truncated the verdict mid-string whenever the reason ran long
          // (non-English alt text echoed back), which threw and failed the image.
          max_output_tokens: 600,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Image QA failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text =
      payload.output_text ??
      payload.output
        ?.flatMap((item) => item.content ?? [])
        .find((item) => item.type === "output_text")
        ?.text;
    if (!text) throw new Error("Image QA returned no verdict");
    const verdict = JSON.parse(text) as {
      pass: boolean;
      unwantedText: boolean;
      peopleOrRobots: boolean;
      styleMatch: boolean;
      subjectMatch: boolean;
      severeArtifact: boolean;
      reason: string;
    };
    const pass =
      verdict.pass &&
      !verdict.unwantedText &&
      !verdict.peopleOrRobots &&
      verdict.styleMatch &&
      verdict.subjectMatch &&
      !verdict.severeArtifact;
    return { pass, reason: verdict.reason };
  }

  async getArticleImage(
    topic: string,
    _keywords: string[],
    _category: string,
    options?: ImageFetchOptions
  ): Promise<ArticleImageResult | null> {
    const prompt = this.buildPrompt(topic, options?.prompt);
    const altText = options?.altText?.trim() || `Editorial illustration for ${topic.trim()}`;

    try {
      let buffer: Buffer | null = null;
      for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS; attempt += 1) {
        const attemptPrompt =
          attempt === 1
            ? prompt
            : attempt === 2
              ? process.env.IMAGE_STYLE_PROMPT?.trim()
                ? `${prompt} The previous candidate failed quality control, usually because of visible text, ` +
                  "a logo or a close-up face. Keep the same scene and style; remove every letter, numeral, sign, " +
                  "screen with text and brand mark, and keep any faces distant or turned away."
                : `${prompt} Previous candidates failed quality control. Use fewer objects and only blank, ` +
                  "unmarked material surfaces; keep every screen dark and empty and every shape purely physical. " +
                  "Treat every descriptive noun as art direction only and never print it on an object."
              : process.env.IMAGE_STYLE_PROMPT?.trim()
                ? // A customer with their own visual identity must never fall back to
                  // the house style: reduce the scene, keep THEIR style.
                  `${prompt} Reduce the scene to one simple, clearly readable subject in exactly the same ` +
                  "visual style; no text, letters, numerals, logos, signage, people or faces anywhere."
                : "Premium cinematic 3D editorial still life representing a structured business decision " +
                  "through an abstract arrangement of unlabeled glass layers, stone modules, metal trays and " +
                  "one vivid orange practical light. Near-black studio background, warm ivory materials, " +
                  "convincing tactile detail, deep blacks, controlled highlights and clean negative space. " +
                  "Every object is blank and unmarked, every surface is plain, and the scene contains only " +
                  "physical geometric forms with no screens, printed material, symbols, people or machines.";
        buffer = await this.generateBuffer(attemptPrompt);
        if (!buffer) continue;
        const verdict = await this.inspectBuffer(buffer, altText);
        if (verdict.pass) break;
        logger.warn({ topic, attempt, reason: verdict.reason }, "[ImageProvider] Image failed QA");
        buffer = null;
      }
      if (!buffer) {
        logger.warn({ topic }, "[ImageProvider] No candidate passed image QA");
        return null;
      }

      // Upload only a candidate that passed visual QA. Convert the 1.5–3 MB
      // generation PNG into a web-ready WebP before it reaches an article.
      const webBuffer = await sharp(buffer)
        .rotate()
        .webp({ quality: 82, effort: 4, smartSubsample: true })
        .toBuffer();
      const year = new Date().getFullYear();
      const shortHash = createHash("sha1").update(webBuffer).digest("hex").slice(0, 10);
      const key = `guides/${year}/${this.slugify(topic)}-${shortHash}.webp`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: webBuffer,
          ContentType: "image/webp",
          CacheControl: "public, max-age=31536000",
        })
      );

      const url = `${this.publicBase}/${key}`;
      logger.info(
        { url, bytes: webBuffer.length, sourceBytes: buffer.length },
        "[ImageProvider] Hero image generated + uploaded"
      );

      return {
        url,
        altText,
        source: "openai-gpt-image-1",
        credit: null,
      };
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), topic },
        "[ImageProvider] Hero image generation errored (non-fatal)"
      );
      return null;
    }
  }
}

// ============================================
// Provider selection
// ============================================

function isDisabled(): boolean {
  const flag = (process.env.ENABLE_IMAGE_GENERATION || "true").toLowerCase();
  return ["false", "0", "no", "off"].includes(flag);
}

/**
 * Where the bytes land. Cloudinary when the customer bought CDN delivery and it
 * is configured, the plain bucket otherwise. Both satisfy the same uploader
 * signature, so nothing downstream knows which one answered.
 */
function requiresArticleMedia(): boolean {
  return ["true", "1", "yes", "on"].includes((process.env.REQUIRE_ARTICLE_MEDIA ?? "false").toLowerCase());
}

function usingCdn(): boolean {
  return entitled("cdn-delivery") && cloudinaryConfigFromEnv() !== null;
}

function resolveUploader(): StockImageUploader | null {
  if (usingCdn()) {
    return createCloudinaryUploader(cloudinaryConfigFromEnv()!);
  }
  const r2 = r2ConfigFromEnv();
  return r2 ? createR2Uploader(r2) : null;
}

/** Build the real provider from env, or null if anything required is missing. */
/**
 * Stock needs a place to put the optimised file. Without R2 configured there is
 * nowhere to host it, so stock is unavailable and the engine falls back to
 * whatever generation is configured.
 */
function buildStockProvider(fallback: ImageProvider | null): ImageProvider | null {
  // Deliberately not gated on ENABLE_IMAGE_GENERATION: that flag turns off
  // *generation*, and turning generation off is exactly when a customer most
  // wants real photography. Stock has its own entitlement.
  if (!entitled("stock-images")) {
    logger.info("[ImageProvider] Stock photography is not in this customer's plan");
    return null;
  }

  const pexels = process.env.PEXELS_API_KEY?.trim();
  const pixabay = process.env.PIXABAY_API_KEY?.trim();
  if (!pexels && !pixabay) return null;

  const upload = resolveUploader();
  if (!upload) {
    logger.warn("[ImageProvider] Stock keys present but no storage is configured — stock disabled");
    return null;
  }

  return new StockImageProvider({
    keys: { pexels, pixabay },
    upload,
    fallback,
    // A transforming CDN derives format and quality per request, so converting
    // on the way in would only cost a second lossy pass over the same pixels.
    // The publish media gate accepts WebP only, so an install that requires
    // article media converts regardless of the plan: a JPEG kept as-is was
    // an article the gate would hold forever (seen on a live site).
    optimise: (entitled("image-optimisation") || requiresArticleMedia()) && !usingCdn(),
  });
}

function buildEnvProvider(): ImageProvider | null {
  if (isDisabled()) return null;
  if (!entitled("generated-images")) {
    logger.info("[ImageProvider] Image generation is not in this customer's plan");
    return null;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.R2_S3_ENDPOINT?.trim();
  const publicBase = process.env.R2_PUBLIC_BASE_URL?.trim();
  const bucket = process.env.R2_BUCKET?.trim() || "octypo-media";

  if (!apiKey || !accessKeyId || !secretAccessKey || !endpoint || !publicBase) {
    return null;
  }

  return new OpenAIImageProvider({
    apiKey,
    bucket,
    publicBase,
    endpoint,
    accessKeyId,
    secretAccessKey,
  });
}

let explicitProvider: ImageProvider | null = null;
let cachedProvider: ImageProvider | null = null;

/** Override the auto-selected provider (e.g. a custom Unsplash/library one). */
export function setImageProvider(provider: ImageProvider): void {
  explicitProvider = provider;
  cachedProvider = provider;
}

/**
 * Returns the active provider: an explicit override if set, otherwise the
 * env-selected OpenAIImageProvider when all keys are present, otherwise
 * NullImageProvider. The choice is cached after first resolution.
 */
export function getImageProvider(): ImageProvider {
  if (explicitProvider) return explicitProvider;
  if (cachedProvider) return cachedProvider;

  const envProvider = buildEnvProvider();
  const stockProvider = buildStockProvider(envProvider);
  const preference = process.env.IMAGE_PROVIDER?.trim().toLowerCase();

  // The customer's own photo bank wraps whichever provider is chosen below:
  // real photography first, that provider only for topics the bank lacks.
  const bankManifestUrl = process.env.IMAGE_BANK_MANIFEST_URL?.trim();
  const withBank = (fallback: ImageProvider | null): ImageProvider | null => {
    if (!bankManifestUrl) return fallback;
    logger.info({ manifest: bankManifestUrl }, "[ImageProvider] Customer image bank in front of the provider");
    return new BankImageProvider({ manifestUrl: bankManifestUrl, fallback });
  };

  if (preference === "generated" && envProvider) {
    logger.info("[ImageProvider] Using configured generated-image provider");
    cachedProvider = withBank(envProvider) as ImageProvider;
  } else if (stockProvider) {
    // Stock first, generation only when stock declines. Real photography is
    // what the product promises, and it costs nothing where generation is the
    // most expensive item in an article.
    logger.info("[ImageProvider] Using stock photography (generation as fallback)");
    cachedProvider = withBank(stockProvider) as ImageProvider;
  } else if (envProvider) {
    logger.info("[ImageProvider] Using OpenAI gpt-image-1 → R2 provider");
    cachedProvider = withBank(envProvider) as ImageProvider;
  } else if (bankManifestUrl) {
    logger.info("[ImageProvider] Customer image bank only — no stock or generation keys");
    cachedProvider = withBank(null) as ImageProvider;
  } else {
    logger.info("[ImageProvider] No image keys configured — articles publish without images");
    cachedProvider = new NullImageProvider();
  }
  return cachedProvider;
}

/**
 * Compatibility helper — same call shape as the original monolith helper.
 * Resolves the active provider lazily on each call.
 */
export async function findOrCreateArticleImage(
  topic: string,
  keywords: string[],
  category: string,
  options?: ImageFetchOptions
): Promise<ArticleImageResult | null> {
  return getImageProvider().getArticleImage(topic, keywords, category, options);
}

/**
 * Images for inside the article.
 *
 * Kept separate from the hero on purpose. The hero has to be about this
 * specific article, and stock only manages that about half the time — so the
 * hero falls back to generation. A body image only has to suit the article's
 * world, which real photography does well and cheaply, so this path never
 * generates: an article with one good image beats one with a hero plus two
 * invented pictures.
 */
export async function findArticleBodyImages(
  topic: string,
  keywords: string[],
  category: string,
  count: number,
  excludeUrls: readonly string[] = []
): Promise<ArticleImageResult[]> {
  const provider = getImageProvider();
  if (!provider.getBodyImages) return [];

  try {
    // The hero comes from the same ranking, so it is usually the top body pick
    // too; ask for enough extra to drop every excluded URL and still fill the
    // slots — one short and the publish media gate refuses the article.
    const images = await provider.getBodyImages(topic, keywords, category, count + excludeUrls.length);
    return images.filter((img) => !excludeUrls.includes(img.url)).slice(0, count);
  } catch (error) {
    logger.warn({ topic, error }, "[Images] Body image lookup failed");
    return [];
  }
}
