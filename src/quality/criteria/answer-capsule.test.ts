import { describe, expect, it } from "vitest";

import { DEFAULT_QUALITY_GATE_CONFIG } from "../config.js";
import { countWords, scoreAnswerCapsule } from "./answer-capsule.js";

const config = DEFAULT_QUALITY_GATE_CONFIG;
const words = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? "المدينة" : "عرض")).join(" ");

describe("answer capsule criterion", () => {
  it("is skipped, not passed, when the caller never supplied a capsule", () => {
    expect(scoreAnswerCapsule({ title: "t" }, config).status).toBe("skipped");
  });

  it("blocks a missing capsule", () => {
    const c = scoreAnswerCapsule({ title: "t", answerCapsule: "" }, config);
    expect(c).toMatchObject({ status: "fail", blocking: true, score: 0 });
  });

  it("blocks the 25-word teaser the editor flagged on the first live batch", () => {
    const c = scoreAnswerCapsule({ title: "t", answerCapsule: words(25) }, config);
    expect(c).toMatchObject({ status: "fail", blocking: true });
    expect(c.details[0]).toContain("25 words");
  });

  it("blocks an introduction masquerading as a capsule", () => {
    const c = scoreAnswerCapsule({ title: "t", answerCapsule: words(75) }, config);
    expect(c).toMatchObject({ status: "fail", blocking: true });
  });

  it("passes the 40-60 band, in a non-Latin script, ignoring HTML", () => {
    const c = scoreAnswerCapsule({ title: "t", answerCapsule: `<p>${words(48)}</p>` }, config);
    expect(c).toMatchObject({ status: "pass", blocking: false, score: 1 });
  });

  it("counts words, not punctuation", () => {
    expect(countWords("مرحبا, عالم - 2026!")).toBe(3);
  });
});
