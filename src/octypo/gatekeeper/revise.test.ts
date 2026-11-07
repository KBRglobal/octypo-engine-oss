import { describe, it, expect, vi } from "vitest";

vi.mock("../../config/domain.js", () => ({
  CONTENT_LANGUAGE: "Portuguese",
  LANGUAGE_RULE: "ABSOLUTE RULE: Write ALL content in Portuguese only.",
}));

const { applyRevision, buildRevisionPrompts, reviseArticle, scriptShare, scriptSwitch, toEditable } = await import("./revise.js");

const prose = (n: number) =>
  Array.from({ length: n }, () => "The park combines culture pavilions, markets, live shows and street food stalls from around the world.").join(" ");

const original = {
  title: "Direct flights ban to Northport extended until October 2026",
  metaTitle: "Direct flights ban to Northport extended until October 2026 - everything to know before booking",
  metaDescription: "The transport ministry extended the direct flights ban.",
  answerCapsule: "The transport ministry extended the direct flights ban to Northport until the end of October 2026. You can still fly via Easton or Westbay.",
  blocks: [
    { type: "text", id: "intro-1", data: { content: `<p>${prose(6)}</p>` } },
    { type: "image", id: "img-1", data: { url: "https://cdn/x.webp", alt: "x" } },
    { type: "heading", id: "h-1", data: { text: "What this means for travellers", level: 2 } },
    { type: "text", id: "t-1", data: { content: `<p>${prose(8)}</p>` } },
    { type: "faq", id: "faq-1", data: { items: [{ question: "Until when?", answer: "Until the end of October 2026." }] } },
  ],
};

const corrections = [
  { section: "Meta title", issue: "69 chars", instruction: "Shorten to 50-60 characters", priority: "should_fix" as const },
  { section: "Answer capsule", issue: "39 words", instruction: "Expand to 40-60 words", priority: "must_fix" as const },
];

function editorResponse(overrides: Record<string, unknown> = {}) {
  const e = toEditable(original);
  return JSON.stringify({
    ...e,
    metaTitle: "Direct flights ban to Northport extended until October 2026",
    answerCapsule:
      "The transport ministry extended the direct flights ban to Northport until the end of October 2026, for the third time this year. Meanwhile you can arrive via Easton, Westbay or Eastport, on a journey of six to eight hours instead of three and a half. Before booking, check the latest official notice.",
    sections: e.sections.map(s => (s.id === "t-1" ? { ...s, text: `<p>${prose(9)}</p>` } : s)),
    ...overrides,
  });
}

describe("toEditable", () => {
  it("serialises headings, text and FAQ with ids, and leaves images out", () => {
    const e = toEditable(original);
    expect(e.sections.map(s => s.id)).toEqual(["intro-1", "h-1", "t-1"]);
    expect(e.sections[1]).toEqual({ id: "h-1", kind: "heading", text: "What this means for travellers" });
    expect(e.faqs).toHaveLength(1);
  });
});

describe("buildRevisionPrompts", () => {
  it("carries the clock, the language rule, the corrections and the ids", () => {
    const { system, user } = buildRevisionPrompts(toEditable(original), corrections, "Strong piece.", new Date("2026-09-15T08:00:00Z"));
    expect(system).toContain("CURRENT DATE: 2026-09-15");
    expect(system).toContain("Portuguese");
    expect(system).toContain("You EDIT the existing article");
    expect(user).toContain("[must_fix] Answer capsule");
    expect(user).toContain('"id": "t-1"');
    expect(user).toContain("Strong piece.");
  });
});

describe("applyRevision", () => {
  it("writes the edits back into the same blocks and keeps the image", () => {
    const out = applyRevision(original, "```json\n" + editorResponse() + "\n```");
    expect(out.ok).toBe(true);
    const a = out.article!;
    expect(a.metaTitle).toBe("Direct flights ban to Northport extended until October 2026");
    expect(a.blocks.map(b => b.id)).toEqual(["intro-1", "img-1", "h-1", "t-1", "faq-1"]);
    expect(String(a.blocks[3].data!.content)).toContain(prose(1));
    expect(a.blocks[1]).toEqual(original.blocks[1]);
    expect(a.wordCount).toBeGreaterThan(150);
  });

  it("keeps the original text of sections a cut-short reply did not return", () => {
    const e = toEditable(original);
    const out = applyRevision(original, JSON.stringify({ ...e, sections: e.sections.slice(0, 2) }));
    expect(out.ok).toBe(true);
    expect(out.article!.blocks.find(b => b.id === "t-1")).toEqual(original.blocks.find(b => b.id === "t-1"));
  });

  it("refuses a reply that returned none of the article's sections", () => {
    const e = toEditable(original);
    const out = applyRevision(original, JSON.stringify({ ...e, sections: [] }));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("dropped section(s)");
  });

  it("refuses a revision that switched language", () => {
    const e = toEditable(original);
    const japanese = e.sections.map(s => ({ ...s, text: "<p>運輸省はノースポートへの直行便の禁止措置を二〇二六年十月末まで延長しました。経由便は引き続き利用できますが、所要時間は長くなり、運賃も高くなります。</p>" }));
    const out = applyRevision(original, JSON.stringify({ ...e, title: "直行便の禁止を延長", answerCapsule: "禁止措置が延長されました。", sections: japanese, faqs: [{ question: "いつまで?", answer: "十月末まで。" }] }));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("out of Latin");
  });

  it("refuses the same switch on a non-Latin article", () => {
    const arabic = "يجمع المنتزه بين أجنحة الثقافة والأسواق والعروض الحية وأكشاك طعام الشارع من حول العالم. ";
    const article = { ...original, title: "تمديد حظر الرحلات المباشرة", metaTitle: "تمديد الحظر", metaDescription: "تمديد الحظر", answerCapsule: arabic, blocks: [{ type: "text", id: "intro-1", data: { content: `<p>${arabic.repeat(6)}</p>` } }] };
    const e = toEditable(article);
    const english = e.sections.map(s => ({ ...s, text: `<p>${prose(6)}</p>` }));
    const out = applyRevision(article, JSON.stringify({ ...e, title: "Flight ban extended", answerCapsule: "The ban was extended.", sections: english }));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("into Latin");
  });

  it("refuses a revision that shrank the article", () => {
    const e = toEditable(original);
    const out = applyRevision(original, JSON.stringify({ ...e, sections: e.sections.map(s => ({ ...s, text: s.kind === "text" ? "<p>Short.</p>" : s.text })) }));
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("shrank");
  });

  it("refuses non-JSON with a reason instead of throwing", () => {
    expect(applyRevision(original, "Sorry, I cannot do that.").reason).toContain("no JSON");
  });
});

describe("reviseArticle", () => {
  it("runs prompt → call → apply and reports a failed call", async () => {
    const good = await reviseArticle(original, corrections, undefined, async () => editorResponse());
    expect(good.ok).toBe(true);
    const bad = await reviseArticle(original, corrections, undefined, async () => {
      throw new Error("LLM call timeout after 45000ms");
    });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("timeout");
  });
});

describe("the language fingerprint", () => {
  it("measures the share of a script", () => {
    expect(scriptShare("مرحبا world", /\p{Script=Arabic}/gu)).toBeCloseTo(5 / 10, 2);
    expect(scriptShare("", /\p{Script=Arabic}/gu)).toBe(0);
  });

  it("sees a switch between any two scripts and nothing else", () => {
    expect(scriptSwitch("новости города сегодня", "最新のニュースをお届けします")).toContain("out of Cyrillic");
    expect(scriptSwitch("the city news today, in depth", "the city news today with a مرحبا مرحبا مرحبا مرحبا")).toContain("into Arabic");
    expect(scriptSwitch("the city news today", "the news of the city today, edited")).toBeNull();
    expect(scriptSwitch("東京都のニュース", "東京都の最新ニュース")).toBeNull();
  });
});
