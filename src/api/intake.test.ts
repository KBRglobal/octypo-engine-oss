import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ db: {} }));

import { DEFAULT_SECTIONS } from "../intake/questions.js";
import { renderQuestionnaire } from "./intake.js";

const render = () => renderQuestionnaire(DEFAULT_SECTIONS, "token-token-token", "Acme Bakery", {});

afterEach(() => {
  delete process.env.SITE_LANGUAGE;
  delete process.env.INTAKE_COPY;
});

describe("questionnaire page", () => {
  it("is English and left-to-right by default", () => {
    const html = render();
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toContain("<h1>Content questionnaire</h1>");
    expect(html).toContain("Part 1 of 6");
  });

  it("derives the language and direction from the site's language", () => {
    process.env.SITE_LANGUAGE = "ar";
    expect(render()).toContain('<html lang="ar" dir="rtl">');
    process.env.SITE_LANGUAGE = "ja";
    expect(render()).toContain('<html lang="ja" dir="ltr">');
  });

  it("ignores a language value that is not a tag", () => {
    process.env.SITE_LANGUAGE = '"><script>';
    expect(render()).toContain('<html lang="en" dir="ltr">');
  });

  it("takes its words from INTAKE_COPY, escaped in the inline script too", () => {
    process.env.INTAKE_COPY = JSON.stringify({
      title: "アンケート",
      saving: "</script><b>",
    });
    const html = render();
    expect(html).toContain("<h1>アンケート</h1>");
    expect(html).not.toContain("</script><b>");
  });

  it("emits an inline script that parses", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(render())?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
  });
});
