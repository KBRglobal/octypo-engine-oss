import { describe, expect, it } from "vitest";
import { keepRelevant, parseVerdicts, RELEVANCE_BATCH_SIZE } from "./keyword-relevance.js";

const kw = (keyword: string) => ({ keyword, searchVolume: 100, competition: null, cpc: null });

describe("keyword relevance", () => {
  it("drops phrases the judge marks off-topic", async () => {
    const judge = async (phrases: string[]) => phrases.map((p) => !p.includes("used"));
    const kept = await keepRelevant([kw("led screen for business"), kw("used business equipment")], judge, "LED screens");
    expect(kept.map((k) => k.keyword)).toEqual(["led screen for business"]);
  });

  it("keeps a batch when the judge fails or answers malformed", async () => {
    const input = [kw("led screen"), kw("mobile stage")];
    expect(await keepRelevant(input, async () => null, "x")).toHaveLength(2);
    expect(await keepRelevant(input, async () => { throw new Error("down"); }, "x")).toHaveLength(2);
  });

  it("judges in batches", async () => {
    const sizes: number[] = [];
    const judge = async (phrases: string[]) => { sizes.push(phrases.length); return phrases.map(() => true); };
    await keepRelevant(Array.from({ length: RELEVANCE_BATCH_SIZE + 5 }, (_, i) => kw(`screen ${i}`)), judge, "x");
    expect(sizes).toEqual([RELEVANCE_BATCH_SIZE, 5]);
  });

  it("parses only a full boolean array", () => {
    expect(parseVerdicts("```json\n[true,false]\n```", 2)).toEqual([true, false]);
    expect(parseVerdicts("[true]", 2)).toBeNull();
    expect(parseVerdicts('["yes","no"]', 2)).toBeNull();
  });
});
