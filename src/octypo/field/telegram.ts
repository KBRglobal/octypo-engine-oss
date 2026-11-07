/**
 * The field desk: a Telegram group the client throws things into.
 *
 * The owner's picture (2026-09-02): the client is at the border with soldiers
 * and sends a photo to WhatsApp. That photo is a live article. Nobody at the
 * client will ever open a Studio, so the door has to be the one they already
 * use: a Telegram group with a bot in it. Text, a photo with a caption, a few
 * photos in a row. The bot's only job is to turn what lands there into raw
 * material for the engine, and to say so.
 *
 * What one message becomes:
 *   - a `documents` row of kind FIELD_NOTE_MIME, whose text is the message
 *     plus what the vision model saw in each photo, so the existing library
 *     path (extract ideas → write → publish) picks it up unchanged;
 *   - the photos themselves, uploaded to the engine's bucket, remembered on
 *     `field_notes` and used as the article's real images instead of a
 *     generated one (see persistGeneratedArticle's providedImages);
 *   - a short "received" in the group, and the article link when it is live.
 *
 * Polling, not a webhook: the engine already runs a loop, long polling needs
 * no public route and no secret, and a restart loses nothing because Telegram
 * keeps unconfirmed updates for a day and `update_id` is unique on the table.
 *
 * Only chats in TELEGRAM_FIELD_CHAT_IDS are listened to. A group that is not
 * on the list gets its own id back, once, so the operator can add it; anybody
 * else who finds the bot can feed nothing into a customer's blog.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db.js";
import { documents, fieldNotes, libraryItems } from "../../schema/index.js";
import { jobQueue, type JobType } from "../../job-queue.js";
import { logger } from "../../lib/logger.js";
import { createR2Uploader, r2ConfigFromEnv } from "../../images/r2-upload.js";
import { toWebp } from "../../images/optimise.js";
import { CONTENT_LANGUAGE, SITE_URL } from "../../config/domain.js";

export const FIELD_NOTE_MIME = "text/x-octypo-field-note";

const API = "https://api.telegram.org";
const POLL_TIMEOUT_S = 25;
const MAX_PHOTOS_PER_NOTE = 4;
const MAX_TEXT_CHARS = 4000;
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  media_group_id?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface FieldMedia {
  url: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface FieldConfig {
  token: string;
  /** Chat ids the bot listens to. Empty means: listen to nobody, tell every group its id. */
  chatIds: Set<string>;
  locale: string;
}

/** Read the configuration; null when the feature is off. */
export function fieldConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FieldConfig | null {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) return null;
  const chatIds = new Set(
    (env.TELEGRAM_FIELD_CHAT_IDS ?? "")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean)
  );
  return { token, chatIds, locale: (env.OCTYPO_LOCALE ?? "en").trim().toLowerCase() };
}

/** The message carried by an update, whichever door it came through. */
export function messageOf(update: TelegramUpdate): TelegramMessage | null {
  return update.message ?? update.channel_post ?? null;
}

/** The largest rendition Telegram offers for a photo. */
export function largestPhoto(sizes: TelegramPhotoSize[] | undefined): TelegramPhotoSize | null {
  if (!sizes || sizes.length === 0) return null;
  return sizes.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best), sizes[0]);
}

/** Is this a message the desk should turn into material at all? */
export function isUsable(message: TelegramMessage): boolean {
  if (message.from?.is_bot) return false;
  const text = (message.text ?? message.caption ?? "").trim();
  const hasPhoto = Boolean(largestPhoto(message.photo));
  if (!text && !hasPhoto) return false;
  // Bot commands are for the bot, not for the blog.
  if (!hasPhoto && text.startsWith("/")) return false;
  return true;
}

const ACK: Record<string, string> = {
  en: "Got it. Filed for an article, and I will post the link here when it is live.",
  ar: "استلمت. دخل إلى الأرشيف، وسأنشر الرابط هنا عندما تُنشر المقالة.",
};
const LIVE: Record<string, string> = {
  en: "The article from the field is live:",
  ar: "مقالة الميدان نُشرت:",
};
const UNKNOWN_GROUP: Record<string, string> = {
  en: "This group is not connected to Octypo yet. Group id:",
  ar: "هذه المجموعة غير متصلة بأوكتيبو بعد. معرّف المجموعة:",
};
export function ackText(locale: string): string {
  return ACK[locale] ?? ACK.en;
}
export function liveText(locale: string): string {
  return LIVE[locale] ?? LIVE.en;
}
export function unknownGroupText(locale: string): string {
  return UNKNOWN_GROUP[locale] ?? UNKNOWN_GROUP.en;
}

/**
 * The document the library mines: the person's own words first, then what
 * the camera saw. Dated, so the writer can say "this week" and be right.
 */
export function buildFieldNoteText(input: {
  text: string;
  descriptions: string[];
  sentAt: Date;
  chatTitle?: string;
  sender?: string;
}): string {
  const date = input.sentAt.toISOString().slice(0, 10);
  const lines = [
    `FIELD NOTE (live report from the field), ${date}${input.chatTitle ? `, ${input.chatTitle}` : ""}${input.sender ? `, sent by ${input.sender}` : ""}.`,
    "This is first-hand material from the business itself, today. Treat every detail as a fact the business witnessed. Write it as a fresh report from the field, not as an evergreen guide.",
    "",
  ];
  const text = input.text.trim().slice(0, MAX_TEXT_CHARS);
  if (text) lines.push("WHAT THEY WROTE:", text, "");
  if (input.descriptions.length) {
    lines.push("WHAT THE PHOTOS SHOW:");
    input.descriptions.forEach((d, i) => lines.push(`Photo ${i + 1}: ${d}`));
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function tg<T>(token: string, method: string, body?: Record<string, unknown>, timeoutMs = 40_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadPhoto(token: string, fileId: string): Promise<{ buffer: Buffer; ext: string }> {
  const file = await tg<{ file_path?: string }>(token, "getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("telegram getFile returned no path");
  const res = await fetch(`${API}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`telegram file download ${res.status}`);
  const ext = (file.file_path.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  return { buffer: Buffer.from(await res.arrayBuffer()), ext };
}

/**
 * What is in the picture, in the content language, as a caption a journalist
 * would write. Non-fatal: a photo with no description is still a photo.
 */
async function describePhoto(buffer: Buffer, mime: string, context: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return "";
  try {
    const res = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_IMAGE_QA_MODEL?.trim() || "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  `Describe this photo in ${CONTENT_LANGUAGE}, in two or three plain sentences, as a caption for a news article: ` +
                  "who or what is in it, where it seems to be, what is happening, anything readable on screens or signs. " +
                  "Only what is visible; never guess names or places that are not shown. " +
                  (context ? `The person who sent it wrote: "${context.slice(0, 500)}".` : ""),
              },
              { type: "input_image", image_url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "low" },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ type: string; text?: string }> }> };
    const text =
      data.output_text ??
      (data.output ?? [])
        .flatMap(o => o.content ?? [])
        .filter(c => c.type === "output_text")
        .map(c => c.text ?? "")
        .join(" ");
    return (text ?? "").trim().slice(0, 700);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] Photo description failed (non-fatal)");
    return "";
  }
}

/**
 * Upload one photo to the engine's bucket; the URL is what the article will
 * show. Converted to WebP first: the publish media gate accepts nothing else,
 * and a phone JPEG is three times the bytes for the same picture.
 */
async function storePhoto(buffer: Buffer, key: string): Promise<string | null> {
  const r2 = r2ConfigFromEnv();
  if (!r2) {
    logger.warn("[Field] No R2 storage configured — the photo cannot be kept for the article");
    return null;
  }
  const upload = createR2Uploader(r2);
  try {
    const optimised = await toWebp(buffer);
    return await upload(optimised.data, key.replace(/\.[a-z0-9]+$/i, "") + ".webp", "image/webp");
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] WebP conversion failed, keeping the original");
    return upload(buffer, key, "image/jpeg");
  }
}

/**
 * The alt text the media gate accepts: twenty to one hundred and eighty
 * characters that say what is in the picture. The vision caption first, the
 * person's own words second, a dated line last.
 */
export function altFor(description: string, text: string, sentAt: Date, locale: string): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const candidate of [clean(description), clean(text)]) {
    if (candidate.length >= 20) return candidate.length > 180 ? candidate.slice(0, 177).trimEnd() + "..." : candidate;
  }
  const date = sentAt.toISOString().slice(0, 10);
  const line = locale === "ar" ? `صورة من الميدان أرسلها النشاط التجاري، ${date}` : `Photo from the field, sent by the business, ${date}`;
  return line;
}

interface PendingGroup {
  chatId: number;
  chatTitle?: string;
  sender?: string;
  sentAt: Date;
  updateIds: number[];
  messageIds: number[];
  text: string;
  photos: TelegramPhotoSize[];
  timer: NodeJS.Timeout | null;
}

/**
 * The desk itself. One instance per engine; started from index.ts.
 *
 * Telegram delivers an album as one message per photo, seconds apart, and a
 * caption on only one of them. Those are held for a moment and filed as ONE
 * note, so five photos of the same street become one article, not five.
 */
export class FieldDesk {
  private running = false;
  private offset = 0;
  private readonly pending = new Map<string, PendingGroup>();
  private readonly toldGroups = new Set<number>();
  private slug: string;

  constructor(private readonly config: FieldConfig, private readonly now: () => Date = () => new Date()) {
    this.slug = (process.env.OCTYPO_SITE_SLUG ?? "site").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "site";
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const last = await db
      .select({ updateId: fieldNotes.updateId })
      .from(fieldNotes)
      .where(isNotNull(fieldNotes.updateId))
      .orderBy(desc(fieldNotes.updateId))
      .limit(1);
    this.offset = last[0]?.updateId ? Number(last[0].updateId) + 1 : 0;
    logger.info({ chats: [...this.config.chatIds], offset: this.offset }, "[Field] Telegram desk started");
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await tg<TelegramUpdate[]>(
          this.config.token,
          "getUpdates",
          { offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "channel_post"] },
          (POLL_TIMEOUT_S + 15) * 1000
        );
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await this.handle(update);
          } catch (error) {
            logger.error({ updateId: update.update_id, error: error instanceof Error ? error.message : String(error) }, "[Field] Update failed");
          }
        }
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] Polling error, retrying");
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /** Exposed for tests: one update in, the note filed (or not) out. */
  async handle(update: TelegramUpdate): Promise<void> {
    const message = messageOf(update);
    if (!message) return;
    const chatId = String(message.chat.id);
    if (!this.config.chatIds.has(chatId)) {
      if (!this.toldGroups.has(message.chat.id) && message.chat.type !== "private") {
        this.toldGroups.add(message.chat.id);
        logger.warn({ chatId, title: message.chat.title }, "[Field] Message from a group that is not connected");
        await this.say(message.chat.id, `${unknownGroupText(this.config.locale)} ${chatId}`);
      }
      return;
    }
    if (!isUsable(message)) return;

    // Album handling: same media_group_id within a few seconds is one note.
    const groupKey = message.media_group_id ? `${chatId}:${message.media_group_id}` : `${chatId}:${message.message_id}`;
    const photo = largestPhoto(message.photo);
    const existing = this.pending.get(groupKey);
    const text = (message.text ?? message.caption ?? "").trim();
    if (existing) {
      existing.updateIds.push(update.update_id);
      existing.messageIds.push(message.message_id);
      if (text && !existing.text) existing.text = text;
      if (photo && existing.photos.length < MAX_PHOTOS_PER_NOTE) existing.photos.push(photo);
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => void this.flush(groupKey), 4000);
      return;
    }
    const group: PendingGroup = {
      chatId: message.chat.id,
      chatTitle: message.chat.title,
      sender: message.from?.first_name || message.from?.username,
      sentAt: new Date((message.date || Math.floor(this.now().getTime() / 1000)) * 1000),
      updateIds: [update.update_id],
      messageIds: [message.message_id],
      text,
      photos: photo ? [photo] : [],
      timer: null,
    };
    this.pending.set(groupKey, group);
    if (message.media_group_id) {
      group.timer = setTimeout(() => void this.flush(groupKey), 4000);
    } else {
      await this.flush(groupKey);
    }
  }

  private async flush(groupKey: string): Promise<void> {
    const group = this.pending.get(groupKey);
    if (!group) return;
    this.pending.delete(groupKey);
    if (group.timer) clearTimeout(group.timer);
    await this.file(group);
  }

  private async file(group: PendingGroup): Promise<void> {
    const media: FieldMedia[] = [];
    const descriptions: string[] = [];
    for (let i = 0; i < group.photos.length; i++) {
      const p = group.photos[i];
      try {
        const { buffer, ext } = await downloadPhoto(this.config.token, p.file_id);
        const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        const description = await describePhoto(buffer, mime, group.text);
        const stamp = group.sentAt.toISOString().slice(0, 10);
        const url = await storePhoto(buffer, `field/${this.slug}/${stamp}-${group.messageIds[0]}-${i + 1}.${ext}`);
        if (description) descriptions.push(description);
        if (url) media.push({ url, alt: altFor(description, group.text, group.sentAt, this.config.locale), width: p.width, height: p.height });
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] Photo could not be kept (non-fatal)");
      }
    }
    const text = buildFieldNoteText({ text: group.text, descriptions, sentAt: group.sentAt, chatTitle: group.chatTitle, sender: group.sender });
    if (!group.text && descriptions.length === 0) {
      logger.info({ chatId: group.chatId }, "[Field] Nothing usable in the message, skipped");
      return;
    }
    const [doc] = await db
      .insert(documents)
      .values({
        filename: `field-note-${group.sentAt.toISOString().slice(0, 10)}-${group.messageIds[0]}.txt`,
        mimeType: FIELD_NOTE_MIME,
        sizeBytes: Buffer.byteLength(text, "utf8"),
        extractedText: text,
        status: "extracted",
        errorMessage: null,
      })
      .returning();
    await db.insert(fieldNotes).values({
      source: "telegram",
      chatId: String(group.chatId),
      messageId: String(group.messageIds[0]),
      updateId: group.updateIds[0],
      sender: group.sender ?? null,
      text: group.text || null,
      media,
      documentId: doc.id,
      status: "filed",
    });
    // Field material jumps the queue: it is news today and stale next week.
    await jobQueue.addJob("library_extract_ideas" as JobType, { documentId: doc.id }, { priority: 1 });
    logger.info({ documentId: doc.id, photos: media.length, chatId: group.chatId }, "[Field] Note filed");
    await this.say(group.chatId, ackText(this.config.locale), group.messageIds[0]);
  }

  async say(chatId: number, text: string, replyTo?: number): Promise<void> {
    try {
      await tg(this.config.token, "sendMessage", {
        chat_id: chatId,
        text,
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        disable_web_page_preview: false,
      });
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] Could not answer in the group (non-fatal)");
    }
  }
}

let desk: FieldDesk | null = null;

export function startFieldDesk(config: FieldConfig | null = fieldConfigFromEnv()): FieldDesk | null {
  if (!config) return null;
  if (desk) return desk;
  desk = new FieldDesk(config);
  void desk.start();
  return desk;
}

export function stopFieldDesk(): void {
  desk?.stop();
  desk = null;
}

/** The photos a field note brought, for the article written from it. */
export async function fieldMediaForDocument(documentId: string): Promise<FieldMedia[]> {
  const rows = await db
    .select({ media: fieldNotes.media })
    .from(fieldNotes)
    .where(eq(fieldNotes.documentId, documentId))
    .limit(1);
  const media = rows[0]?.media;
  return Array.isArray(media) ? (media as FieldMedia[]).filter(m => m && typeof m.url === "string") : [];
}

/**
 * The article went live: tell the group that sent the material. Best-effort
 * and never in the publish path's way.
 */
export async function notifyFieldSource(contentId: string, slug: string, articlePathPrefix: string): Promise<boolean> {
  const config = fieldConfigFromEnv();
  if (!config) return false;
  try {
    const [item] = await db
      .select({ documentId: libraryItems.documentId })
      .from(libraryItems)
      .where(eq(libraryItems.contentId, contentId))
      .limit(1);
    if (!item) return false;
    const [note] = await db
      .select({ chatId: fieldNotes.chatId, messageId: fieldNotes.messageId })
      .from(fieldNotes)
      .where(and(eq(fieldNotes.documentId, item.documentId), eq(fieldNotes.source, "telegram")))
      .limit(1);
    if (!note) return false;
    const base = SITE_URL ?? "";
    const url = `${base}${articlePathPrefix}/${slug}`;
    const carrier = desk ?? new FieldDesk(config);
    await carrier.say(Number(note.chatId), `${liveText(config.locale)}\n${url}`, Number(note.messageId) || undefined);
    await db.update(fieldNotes).set({ status: "published", updatedAt: new Date() }).where(eq(fieldNotes.documentId, item.documentId));
    return true;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, "[Field] Could not report the published article (non-fatal)");
    return false;
  }
}
