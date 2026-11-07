import { describe, it, expect, vi } from "vitest";

// job-handlers pulls in the DB and job queue at import time; none of that is
// exercised here, so stub the heavy modules and test the pure helpers.
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../../job-queue.js", () => ({ jobQueue: {}, JobType: {} }));

const { isEnglishLanguage, sectionHeadings, slugifyConcise, stripSiteSuffix } = await import("./job-handlers.js");
const { judgeSlug } = await import("../../quality/criteria/slug-readable.js");

describe("slugifyConcise with headlines in any script", () => {
  it("still handles latin titles exactly as before", () => {
    expect(slugifyConcise("Harbor Grand Prix Northport 2026 tickets are now on sale")).toBe(
      "harbor-grand-prix-northport-2026-tickets"
    );
  });

  it("folds accents instead of cutting the word", () => {
    expect(slugifyConcise("Café Müller à Besançon")).toBe("cafe-muller-besancon");
  });

  it("keeps a non-Latin headline's own words instead of only its digits", () => {
    const arabic = slugifyConcise("هل ستخفض شركات الطيران أسعار التذاكر؟ - شبكة 13");
    expect(arabic).not.toBe("13");
    expect(arabic.split("-").length).toBeGreaterThanOrEqual(3);
    expect(arabic).toContain("الطيران");
    expect(slugifyConcise("東京都の地下鉄 2026")).toBe("東京都の地下鉄-2026");
  });

  it("leaves a native slug for the readable-slug gate to hold, visibly", () => {
    expect(judgeSlug(slugifyConcise("東京都の地下鉄 2026")).ok).toBe(false);
  });

  it("keeps a mixed title's latin words", () => {
    expect(slugifyConcise("SailGP الموسم 2026: بيع التذاكر")).toBe("sailgp-2026");
  });
});

describe("site language", () => {
  it("compares against the configured language, whatever it is", () => {
    expect(isEnglishLanguage(" english ")).toBe(true);
    expect(isEnglishLanguage("Japanese")).toBe(false);
  });

  it("strips the configured site name and nothing else", () => {
    expect(stripSiteSuffix("Opening dates | Northport Daily", "Northport Daily")).toBe("Opening dates");
    expect(stripSiteSuffix("開業日 - ノースポート", "ノースポート")).toBe("開業日");
    expect(stripSiteSuffix("Opening dates - a guide", "Northport Daily")).toBe("Opening dates - a guide");
    expect(stripSiteSuffix("Opening dates - a guide", "")).toBe("Opening dates - a guide");
  });

  it("takes the FAQ heading from the install's headings, defaulting to English", () => {
    expect(sectionHeadings({} as NodeJS.ProcessEnv).faq).toBe("Frequently Asked Questions");
    expect(sectionHeadings({ SECTION_HEADINGS_JSON: '{"faq":"よくある質問"}' } as NodeJS.ProcessEnv).faq).toBe("よくある質問");
  });
});
