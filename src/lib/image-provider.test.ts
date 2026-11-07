import { describe, it, expect, afterEach } from "vitest";
import { setImageProvider, findArticleBodyImages, NullImageProvider, type ImageProvider, type ArticleImageResult } from "./image-provider.js";

const img = (name: string): ArticleImageResult => ({
  url: `https://cdn.example/${name}.webp`,
  altText: `descriptive alt text for ${name} photograph`,
  source: "bank",
});

/** A bank-like provider: best matches first, however many are asked for. */
function providerWith(ranked: ArticleImageResult[]): ImageProvider {
  return {
    getArticleImage: async () => null,
    getBodyImages: async (_topic: string, _keywords: string[], _category: string, count: number) => ranked.slice(0, count),
  };
}

describe("findArticleBodyImages — the two body slots the site importer insists on", () => {
  afterEach(() => setImageProvider(new NullImageProvider()));

  it("still fills every slot when the article's own hero is among the provider's best picks", async () => {
    // The hero is chosen from the same bank first, so it is usually the top
    // match again here. Asking for exactly `count` and then dropping the hero
    // left one slot empty — and the publish media gate refused the article.
    setImageProvider(providerWith([img("hero"), img("second"), img("third"), img("fourth")]));
    const out = await findArticleBodyImages("led screen", [], "guide", 2, ["https://cdn.example/hero.webp"]);
    expect(out.map((i) => i.url)).toEqual(["https://cdn.example/second.webp", "https://cdn.example/third.webp"]);
  });

  it("never returns more than the requested count", async () => {
    setImageProvider(providerWith([img("a"), img("b"), img("c")]));
    const out = await findArticleBodyImages("led screen", [], "guide", 2, []);
    expect(out).toHaveLength(2);
  });

  it("returns what exists when the provider has fewer images than slots", async () => {
    setImageProvider(providerWith([img("hero"), img("only")]));
    const out = await findArticleBodyImages("led screen", [], "guide", 2, ["https://cdn.example/hero.webp"]);
    expect(out.map((i) => i.url)).toEqual(["https://cdn.example/only.webp"]);
  });
});
