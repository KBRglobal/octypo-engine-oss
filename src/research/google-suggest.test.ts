import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { expandSeeds } from "./google-suggest.js";

function recorder(suggestions: string[] = ["a result"]) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string) => {
    urls.push(new URL(input));
    return new Response(JSON.stringify(["q", suggestions]), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

describe("expandSeeds", () => {
  it("sends the caller's language and country", async () => {
    const { urls, fetchImpl } = recorder();
    await expandSeeds(["hotel"], { language: "de", country: "DE", fetchImpl });
    expect(urls[0].searchParams.get("hl")).toBe("de");
    expect(urls[0].searchParams.get("gl")).toBe("de");
  });

  it("uses English question words only for English", async () => {
    const english = recorder();
    await expandSeeds(["hotel"], { language: "en", country: "US", deep: true, fetchImpl: english.fetchImpl });
    expect(english.urls.map((url) => url.searchParams.get("q"))).toContain("how hotel");

    const german = recorder();
    await expandSeeds(["hotel"], { language: "de", country: "DE", deep: true, fetchImpl: german.fetchImpl });
    const asked = german.urls.map((url) => url.searchParams.get("q"));
    expect(asked).not.toContain("how hotel");
    expect(asked).toContain("hotel a");
  });

  it("asks only the bare seed in a script it has no alphabet for", async () => {
    const seed = "ホテル";
    const { urls, fetchImpl } = recorder();
    await expandSeeds([seed], { language: "ja", country: "JP", deep: true, fetchImpl });
    expect(urls.map((url) => url.searchParams.get("q"))).toEqual([seed]);
  });

  it("expands with the prefixes and letters the caller passes", async () => {
    const seed = "ホテル";
    const { urls, fetchImpl } = recorder();
    await expandSeeds([seed], {
      language: "ja",
      country: "JP",
      deep: true,
      prefixes: ["東京"],
      letters: ["あ"],
      fetchImpl,
    });
    expect(urls.map((url) => url.searchParams.get("q"))).toEqual([seed, `東京 ${seed}`, `${seed} あ`]);
  });

  it("decodes a legacy charset the endpoint declares", async () => {
    const bytes = new Uint8Array([0x5b, 0x22, 0x71, 0x22, 0x2c, 0x5b, 0x22, 0xc7, 0xe4, 0x22, 0x5d, 0x5d]);
    const fetchImpl = (async () =>
      new Response(bytes, { headers: { "content-type": "text/javascript; charset=windows-1251" } })) as unknown as typeof fetch;
    expect(await expandSeeds(["q"], { language: "ru", country: "RU", fetchImpl })).toEqual(["Зд"]);
  });
});
