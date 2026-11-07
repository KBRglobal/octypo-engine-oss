import { describe, it, expect, afterEach, vi } from "vitest";

// The module reaches the database and the job queue only inside the desk;
// the pure pieces under test never do, so both are stubbed away.
vi.mock("../../db.js", () => ({ db: {}, client: {}, closeDb: async () => undefined }));
vi.mock("../../job-queue.js", () => ({ jobQueue: { addJob: async () => undefined } }));
import { needsConversion, webpKeyFor } from "./repair.js";
import {
  ackText,
  altFor,
  buildFieldNoteText,
  fieldConfigFromEnv,
  isUsable,
  largestPhoto,
  liveText,
  messageOf,
  unknownGroupText,
  type TelegramMessage,
} from "./telegram.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const base: TelegramMessage = {
  message_id: 7,
  date: 1_788_000_000,
  chat: { id: -1001, type: "supergroup", title: "Field team" },
  from: { id: 5, first_name: "Sam" },
};

describe("fieldConfigFromEnv", () => {
  it("is off without a token, and reads the chat list when there is one", () => {
    expect(fieldConfigFromEnv({})).toBeNull();
    const c = fieldConfigFromEnv({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_FIELD_CHAT_IDS: "-1001, -1002\n-1003", OCTYPO_LOCALE: "ar" });
    expect(c?.chatIds).toEqual(new Set(["-1001", "-1002", "-1003"]));
    expect(c?.locale).toBe("ar");
  });
  it("an empty chat list means nobody is listened to, not everybody", () => {
    const c = fieldConfigFromEnv({ TELEGRAM_BOT_TOKEN: "t" });
    expect(c?.chatIds.size).toBe(0);
    expect(c?.locale).toBe("en");
  });
});

describe("what counts as material", () => {
  it("takes text, a caption, or a photo; drops bots, commands and empty messages", () => {
    expect(isUsable({ ...base, text: "We are at the fairground with the crew" })).toBe(true);
    expect(isUsable({ ...base, caption: "Screen at the entrance", photo: [{ file_id: "a", width: 100, height: 100 }] })).toBe(true);
    expect(isUsable({ ...base, photo: [{ file_id: "a", width: 100, height: 100 }] })).toBe(true);
    expect(isUsable({ ...base, text: "/start" })).toBe(false);
    expect(isUsable({ ...base, text: "hi", from: { id: 9, is_bot: true } })).toBe(false);
    expect(isUsable({ ...base })).toBe(false);
  });
  it("picks the largest rendition of a photo", () => {
    const sizes = [
      { file_id: "s", width: 90, height: 90 },
      { file_id: "l", width: 1280, height: 960 },
      { file_id: "m", width: 320, height: 240 },
    ];
    expect(largestPhoto(sizes)?.file_id).toBe("l");
    expect(largestPhoto(undefined)).toBeNull();
  });
  it("reads a message or a channel post", () => {
    expect(messageOf({ update_id: 1, message: base })).toBe(base);
    expect(messageOf({ update_id: 1, channel_post: base })).toBe(base);
    expect(messageOf({ update_id: 1 })).toBeNull();
  });
});

describe("the note the library mines", () => {
  it("carries the date, the words, and what the photos show, and says it is first-hand", () => {
    const text = buildFieldNoteText({
      text: "We are at the fairground with the crew, the screen is showing greetings from home",
      descriptions: ["Crew in uniforms facing a large screen on a truck", "Sunset behind a fence"],
      sentAt: new Date("2026-09-02T14:00:00Z"),
      chatTitle: "Field team",
      sender: "Sam",
    });
    expect(text).toContain("FIELD NOTE");
    expect(text).toContain("2026-09-02");
    expect(text).toContain("Field team");
    expect(text).toContain("WHAT THEY WROTE:\nWe are at the fairground");
    expect(text).toContain("Photo 1: Crew in uniforms");
    expect(text).toContain("Photo 2: Sunset");
    expect(text).toContain("first-hand");
  });
  it("leaves out sections that are empty", () => {
    const text = buildFieldNoteText({ text: "", descriptions: ["x"], sentAt: new Date("2026-09-02T14:00:00Z") });
    expect(text).not.toContain("WHAT THEY WROTE");
    expect(text).toContain("Photo 1: x");
  });
});

describe("the alt text the gate accepts", () => {
  it("prefers the caption, then the words, then a dated line, and never leaves the 20 to 180 range", () => {
    const at = new Date("2026-09-02T14:00:00Z");
    expect(altFor("فريق بالزي الموحد أمام شاشة كبيرة على شاحنة", "x", at, "ar")).toMatch(/^فريق/);
    expect(altFor("", "We are at the fairground with the crew tonight", at, "en")).toMatch(/^We are/);
    const fallback = altFor("", "hi", at, "ar");
    expect(fallback.length).toBeGreaterThanOrEqual(20);
    expect(fallback).toContain("2026-09-02");
    expect(altFor("a".repeat(400), "", at, "en").length).toBeLessThanOrEqual(180);
  });
});

describe("what the bot says", () => {
  it("answers in the install's language and falls back to English", () => {
    expect(ackText("ar")).toMatch(/استلمت/);
    expect(liveText("ar")).toMatch(/نُشرت/);
    expect(unknownGroupText("ar")).toMatch(/معرّف/);
    expect(ackText("fr")).toMatch(/Got it/);
  });
});

describe("field media repair", () => {
  it("knows which photos the gate will refuse, and where their WebP copy goes", () => {
    expect(needsConversion("https://pub.r2.dev/field/acme/2026-09-02-4-1-bc8ebc75b8.jpg")).toBe(true);
    expect(needsConversion("https://pub.r2.dev/field/acme/2026-09-02-4-1-aa11bb22cc.webp")).toBe(false);
    expect(needsConversion("not a url")).toBe(false);
    expect(webpKeyFor("https://pub.r2.dev/field/acme/2026-09-02-4-1-bc8ebc75b8.jpg")).toBe("field/acme/2026-09-02-4-1.webp");
    expect(webpKeyFor("https://pub.r2.dev/field/acme/a.png")).toBe("field/acme/a.webp");
  });
});
