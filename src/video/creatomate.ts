/**
 * Short promo videos for published articles, rendered by Creatomate.
 *
 * A render is asynchronous and takes tens of seconds, so this never runs inside
 * a request or inside the publishing path — an article must not wait on, or be
 * blocked by, a video. It runs as a background job and attaches the URL to the
 * article afterwards.
 *
 * The template is the customer's, not ours: it carries their fonts, colours and
 * logo, and the engine only fills the named fields. That keeps brand decisions
 * where they belong and keeps this file to plumbing.
 */

import { logger } from "../lib/logger.js";

const API_BASE = "https://api.creatomate.com/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
/** A 1080×1080 render of a few seconds usually lands well inside this. */
const DEFAULT_MAX_WAIT_MS = 300_000;
const DEFAULT_POLL_MS = 5_000;

export type RenderStatus =
  | "planned"
  | "waiting"
  | "transcribing"
  | "rendering"
  | "succeeded"
  | "failed";

export interface RenderJob {
  id: string;
  status: RenderStatus;
  url: string | null;
  errorMessage: string | null;
}

export interface CreatomateConfig {
  apiKey: string;
  templateId: string;
  timeoutMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export function creatomateConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CreatomateConfig | null {
  const apiKey = env.CREATOMATE_API_KEY?.trim();
  const templateId = env.CREATOMATE_TEMPLATE_ID?.trim();
  // A key without a template renders nothing, and a template without a key
  // cannot be reached. Half-configured is not configured.
  if (!apiKey || !templateId) return null;
  return {
    apiKey,
    templateId,
    maxWaitMs: Number(env.CREATOMATE_MAX_WAIT_MS) || undefined,
  };
}

/** A render that will not change again, whichever way it went. */
export function isTerminal(status: RenderStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export function parseRender(payload: unknown): RenderJob | null {
  const raw = Array.isArray(payload) ? payload[0] : payload;
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  return {
    id,
    status: (typeof record.status === "string" ? record.status : "planned") as RenderStatus,
    url: typeof record.url === "string" ? record.url : null,
    errorMessage: typeof record.error_message === "string" ? record.error_message : null,
  };
}

export interface ArticleVideoInput {
  title: string;
  /** One line under the title — the answer capsule or summary, already trimmed. */
  subtitle?: string;
  /** The article's hero image or a video; whatever the template's media slot takes. */
  mediaUrl?: string | null;
}

/**
 * Map an article onto the template's named fields.
 *
 * Creatomate ignores a modification whose name is not in the template, so a
 * customer template without a media slot simply renders without one instead of
 * failing. Empty values are dropped rather than sent as "", which would blank
 * the template's own default.
 */
export function buildModifications(input: ArticleVideoInput): Record<string, string> {
  const modifications: Record<string, string> = {};
  const title = input.title?.trim();
  if (title) modifications["Text-1.text"] = title;
  const subtitle = input.subtitle?.trim();
  if (subtitle) modifications["Text-2.text"] = subtitle;
  const media = input.mediaUrl?.trim();
  if (media) modifications["Video.source"] = media;
  return modifications;
}

export interface RenderOptions {
  fetchImpl?: typeof fetch;
  /** Injected by tests so polling does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function request(
  config: CreatomateConfig,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const doFetch = fetchImpl;
    const res = await doFetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Creatomate ${path} failed with ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function startRender(
  config: CreatomateConfig,
  input: ArticleVideoInput,
  { fetchImpl = fetch }: RenderOptions = {}
): Promise<RenderJob> {
  const payload = await request(
    config,
    "/renders",
    {
      method: "POST",
      body: JSON.stringify({
        template_id: config.templateId,
        modifications: buildModifications(input),
      }),
    },
    fetchImpl
  );
  const job = parseRender(payload);
  if (!job) throw new Error("Creatomate returned no render");
  return job;
}

export async function getRender(
  config: CreatomateConfig,
  id: string,
  { fetchImpl = fetch }: RenderOptions = {}
): Promise<RenderJob> {
  const job = parseRender(await request(config, `/renders/${id}`, { method: "GET" }, fetchImpl));
  if (!job) throw new Error(`Creatomate returned no render for ${id}`);
  return job;
}

/**
 * Start a render and wait for it. Returns the URL, or null when the render
 * failed or outlasted the budget — a missing promo video is never a reason for
 * an article to be considered unpublished.
 */
export async function renderArticleVideo(
  config: CreatomateConfig,
  input: ArticleVideoInput,
  options: RenderOptions = {}
): Promise<string | null> {
  const { sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = options;
  const deadline = now() + (config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const interval = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let job: RenderJob;
  try {
    job = await startRender(config, input, options);
  } catch (error) {
    logger.warn({ error, title: input.title }, "[Video] Could not start a render");
    return null;
  }

  while (!isTerminal(job.status)) {
    if (now() >= deadline) {
      logger.warn({ renderId: job.id, status: job.status }, "[Video] Render outlasted its budget");
      return null;
    }
    await sleep(interval);
    try {
      job = await getRender(config, job.id, options);
    } catch (error) {
      logger.warn({ error, renderId: job.id }, "[Video] Could not read render status");
      return null;
    }
  }

  if (job.status === "failed" || !job.url) {
    logger.warn({ renderId: job.id, error: job.errorMessage }, "[Video] Render failed");
    return null;
  }

  logger.info({ renderId: job.id }, "[Video] Render finished");
  return job.url;
}
