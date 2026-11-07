import { describe, expect, it } from "vitest";
import { textDirection } from "./text-direction.js";

describe("textDirection", () => {
  it.each(["ar", "fa", "ur", "ps", "he", "yi", "dv", "ckb", "sd", "ug", "syr", "nqo", "ar-EG"])(
    "reads %s as right-to-left",
    (language) => expect(textDirection(language)).toBe("rtl")
  );

  it.each(["en", "en-US", "ja", "zh", "de", "ru", "ko", "hi"])("reads %s as left-to-right", (language) =>
    expect(textDirection(language)).toBe("ltr")
  );

  it("lets an explicit script override the language's usual one", () => {
    expect(textDirection("az-Arab")).toBe("rtl");
    expect(textDirection("az")).toBe("ltr");
    expect(textDirection("ku-Arab")).toBe("rtl");
  });

  it("falls back to left-to-right on a tag it cannot parse", () => {
    expect(textDirection("")).toBe("ltr");
    expect(textDirection("not a tag!")).toBe("ltr");
  });
});
