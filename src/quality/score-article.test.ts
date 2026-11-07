import { describe, it, expect } from "vitest";

import { scoreArticle } from "./score-article.js";
import { DEFAULT_QUALITY_GATE_CONFIG } from "./config.js";
import type { ArticleQualityInput, CriterionId, ArticleQualityReport } from "./types.js";
import {
  goodArticle,
  keywordStuffedArticle,
  fabricatedStatArticle,
  brokenSchemaArticle,
  incompleteSchemaArticle,
  missingFaqSchemaArticle,
  PUBLISHED_SLUGS,
} from "./__fixtures__/articles.js";

function criterion(report: ArticleQualityReport, id: CriterionId) {
  const found = report.criteria.find(c => c.id === id);
  if (!found) throw new Error(`criterion ${id} missing from report`);
  return found;
}

describe("scoreArticle — the control case", () => {
  const report = scoreArticle(goodArticle);

  it("passes a genuinely good article", () => {
    expect(report.passed).toBe(true);
    expect(report.blockingFailures).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(DEFAULT_QUALITY_GATE_CONFIG.threshold);
  });

  it("reports every criterion so a human can see the breakdown", () => {
    const ids = report.criteria.map(c => c.id).sort();
    expect(ids).toEqual(
      [
        "answer-capsule",
        "fabricated-stats",
        "hero-image",
        "internal-links",
        "keyword-density",
        "keyword-placement",
        "meta-lengths",
        "serp-alignment",
        "slug-readable",
        "source-primary",
        "structured-data",
        "title-freshness",
        "word-count",
      ].sort()
    );
    for (const c of report.criteria) {
      expect(c.status).toBe("pass");
    }
  });

  it("is deterministic — the same input always yields the same verdict", () => {
    const a = scoreArticle(goodArticle);
    const b = scoreArticle(goodArticle);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(goodArticle);
    scoreArticle(goodArticle);
    expect(JSON.stringify(goodArticle)).toBe(snapshot);
  });
});

describe("keyword placement", () => {
  it("wants the keyword in title, H1, meta description, first 100 words and an H2", () => {
    const c = criterion(scoreArticle(goodArticle), "keyword-placement");
    expect(c.status).toBe("pass");
    expect(c.evidence).toMatchObject({
      inTitle: true,
      inH1: true,
      inMetaDescription: true,
      inFirst100Words: true,
      inAnyH2: true,
    });
  });

  it("fails when the keyword never reaches an H2", () => {
    const input: ArticleQualityInput = {
      ...goodArticle,
      blocks: (goodArticle.blocks ?? []).map(b =>
        b.type === "heading" ? { ...b, data: { ...b.data, text: "Some Generic Heading" } } : b
      ),
    };
    const c = criterion(scoreArticle(input), "keyword-placement");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/H2/i);
  });

  it("fails when the meta description drops the keyword", () => {
    const c = criterion(
      scoreArticle({ ...goodArticle, metaDescription: "Everything a renter needs to know about getting money back at the end of a tenancy agreement." }),
      "keyword-placement"
    );
    expect(c.status).toBe("fail");
    expect(c.evidence).toMatchObject({ inMetaDescription: false });
  });

  it("blocks publication when the keyword is essentially absent", () => {
    const report = scoreArticle({
      ...goodArticle,
      title: "Getting Your Money Back",
      metaTitle: "Getting Your Money Back",
      metaDescription: "How renters recover what they are owed at the end of a tenancy without a fight.",
      blocks: [{ type: "text", id: "t", data: { content: "<p>Ask for the breakdown in writing.</p>" } }],
    });
    expect(report.blockingFailures).toContain("keyword-placement");
    expect(report.passed).toBe(false);
  });

  it("skips rather than silently passes when no keyword was supplied", () => {
    const c = criterion(scoreArticle({ ...goodArticle, primaryKeyword: null }), "keyword-placement");
    expect(c.status).toBe("skipped");
  });
});

describe("keyword density", () => {
  it("accepts a sane band", () => {
    const c = criterion(scoreArticle(goodArticle), "keyword-density");
    expect(c.status).toBe("pass");
    const density = (c.evidence as { densityPercent: number }).densityPercent;
    expect(density).toBeGreaterThanOrEqual(DEFAULT_QUALITY_GATE_CONFIG.keywordDensityMin);
    expect(density).toBeLessThanOrEqual(DEFAULT_QUALITY_GATE_CONFIG.keywordDensityMax);
  });

  it("fails and blocks a keyword-stuffed article", () => {
    const report = scoreArticle(keywordStuffedArticle);
    const c = criterion(report, "keyword-density");
    expect(c.status).toBe("fail");
    expect((c.evidence as { densityPercent: number }).densityPercent).toBeGreaterThan(
      DEFAULT_QUALITY_GATE_CONFIG.keywordDensityMax
    );
    expect(report.blockingFailures).toContain("keyword-density");
    expect(report.passed).toBe(false);
  });

  // Google publishes no keyword-density figure at all, and its systems match
  // synonyms, so a minimum density is folklore — enforcing one pushes the writer
  // toward the unnatural repetition that IS a stated spam signal. Total absence
  // is still reported (the keyword-placement criterion covers relevance), but it
  // no longer fails the article on a number Google never stated.
  it("reports absence without failing on a density figure Google never published", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        blocks: [
          {
            type: "text",
            id: "t",
            data: {
              content:
                "<p>Ask for the breakdown in writing, item by item, with the invoice behind each line. Put your own evidence next to it and push the disputed amount to adjudication, which costs nothing at all.</p>",
            },
          },
        ],
      }),
      "keyword-density"
    );
    expect(c.status).not.toBe("fail");
    expect((c.evidence as { occurrences: number }).occurrences).toBe(0);
  });

  it("counts visible prose only, never markup or image URLs", () => {
    const withMarkupNoise: ArticleQualityInput = {
      ...goodArticle,
      blocks: [
        ...(goodArticle.blocks ?? []),
        {
          type: "image",
          id: "noise",
          data: {
            // The words "deposit deduction" appear here 3 times, all invisible.
            url: "https://cdn.example.com/deposit-deduction/deposit-deduction.jpg",
            alt: "",
          },
        },
      ],
    };
    const base = criterion(scoreArticle(goodArticle), "keyword-density");
    const noisy = criterion(scoreArticle(withMarkupNoise), "keyword-density");
    expect((noisy.evidence as { occurrences: number }).occurrences).toBe(
      (base.evidence as { occurrences: number }).occurrences
    );
  });
});

describe("meta lengths", () => {
  it("passes a compliant pair", () => {
    expect(criterion(scoreArticle(goodArticle), "meta-lengths").status).toBe("pass");
  });

  it("fails a meta title over 60 characters", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        metaTitle: "Deposit Deduction Rules: Everything A Tenant Must Know Before Moving Out Of A Rental",
      }),
      "meta-lengths"
    );
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/meta title/i);
  });

  it("fails a meta description outside 70-160 characters", () => {
    expect(criterion(scoreArticle({ ...goodArticle, metaDescription: "Deposit deduction guide." }), "meta-lengths").status).toBe("fail");
    expect(
      criterion(
        scoreArticle({
          ...goodArticle,
          metaDescription:
            "A deposit deduction has to be evidenced, reasonable and tied to real damage that goes beyond fair wear and tear, and this guide walks through every single category an adjudicator will look at before deciding.",
        }),
        "meta-lengths"
      ).status
    ).toBe("fail");
  });
});

describe("structured data", () => {
  it("accepts current Article markup while FAQs remain visible", () => {
    expect(criterion(scoreArticle(goodArticle), "structured-data").status).toBe("pass");
  });

  it("blocks JSON-LD carrying an unescaped </script>", () => {
    const report = scoreArticle(brokenSchemaArticle);
    const c = criterion(report, "structured-data");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/script/i);
    expect(report.blockingFailures).toContain("structured-data");
  });

  it("blocks unparseable JSON-LD", () => {
    const report = scoreArticle({ ...goodArticle, structuredData: '[{"@type": "Article",}]' });
    expect(criterion(report, "structured-data").status).toBe("fail");
    expect(report.blockingFailures).toContain("structured-data");
  });

  it("fails an Article entry missing required fields", () => {
    const c = criterion(scoreArticle(incompleteSchemaArticle), "structured-data");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/headline/i);
  });

  it("does not demand FAQPage when the article has visible FAQs", () => {
    const c = criterion(scoreArticle(missingFaqSchemaArticle), "structured-data");
    expect(c.status).toBe("pass");
  });

  it("also accepts Article markup when the article has no FAQs", () => {
    const c = criterion(
      scoreArticle({
        ...missingFaqSchemaArticle,
        blocks: (goodArticle.blocks ?? []).filter(b => b.type !== "faq"),
      }),
      "structured-data"
    );
    expect(c.status).toBe("pass");
  });

  it("fails legacy FAQPage markup while keeping visible FAQs", () => {
    const article = JSON.parse(String(goodArticle.structuredData))[0];
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        structuredData: [
          article,
          { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] },
        ],
      }),
      "structured-data"
    );
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/legacy|current commercial-article policy/i);
  });

  it("blocks when structured data is missing entirely", () => {
    const report = scoreArticle({ ...goodArticle, structuredData: null });
    expect(criterion(report, "structured-data").status).toBe("fail");
    expect(report.blockingFailures).toContain("structured-data");
  });
});

describe("hero image", () => {
  it("accepts a hero with topical alt text", () => {
    expect(criterion(scoreArticle(goodArticle), "hero-image").status).toBe("pass");
  });

  it("fails a missing hero image", () => {
    const c = criterion(scoreArticle({ ...goodArticle, heroImage: null }), "hero-image");
    expect(c.status).toBe("fail");
    expect(c.score).toBe(0);
  });

  it("fails empty alt text", () => {
    expect(criterion(scoreArticle({ ...goodArticle, heroImageAlt: "  " }), "hero-image").status).toBe("fail");
  });

  it("fails alt text that is just the filename", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        heroImage: "https://cdn.example.com/octypo/deposit-deduction-inventory-desk.jpg",
        heroImageAlt: "deposit deduction inventory desk",
      }),
      "hero-image"
    );
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/filename/i);
  });

  it("fails generic alt text", () => {
    const c = criterion(scoreArticle({ ...goodArticle, heroImageAlt: "Featured image" }), "hero-image");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/generic/i);
  });

  it("fails alt text that describes nothing to do with the topic", () => {
    const c = criterion(
      scoreArticle({ ...goodArticle, heroImageAlt: "A golden retriever running along a beach at sunrise" }),
      "hero-image"
    );
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/topic/i);
  });
});

describe("internal links", () => {
  it("accepts three or more links to real published slugs", () => {
    const c = criterion(scoreArticle(goodArticle), "internal-links");
    expect(c.status).toBe("pass");
    expect((c.evidence as { verified: number }).verified).toBeGreaterThanOrEqual(3);
  });

  it("fails links that point at slugs which do not exist", () => {
    const c = criterion(
      scoreArticle({ ...goodArticle, publishedSlugs: ["something-else-entirely"] }),
      "internal-links"
    );
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/not published|does not exist|dead/i);
  });

  it("ignores external links when counting", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        blocks: [
          {
            type: "text",
            id: "t",
            data: {
              content: `<p>A deposit deduction guide with only outbound links:
              <a href="https://gov.example/deposits">one</a>,
              <a href="https://news.example/story">two</a>,
              <a href="https://other.example/three">three</a>.</p>`,
            },
          },
          { type: "heading", id: "h", data: { text: "Fair Deposit Deduction Rules", level: 2 } },
        ],
      }),
      "internal-links"
    );
    expect(c.status).toBe("fail");
    expect((c.evidence as { internal: number }).internal).toBe(0);
  });

  it("counts an absolute link back to the same site as internal", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        blocks: (goodArticle.blocks ?? []).map(b =>
          b.type === "text" && typeof b.data?.content === "string"
            ? {
                ...b,
                data: {
                  ...b.data,
                  content: (b.data.content as string).replace(
                    /href="\/guides\//g,
                    'href="https://octypo.example/guides/'
                  ),
                },
              }
            : b
        ),
      }),
      "internal-links"
    );
    expect(c.status).toBe("pass");
  });

  it("says so plainly when it has no slug list to verify against", () => {
    const c = criterion(scoreArticle({ ...goodArticle, publishedSlugs: null }), "internal-links");
    expect(c.details.join(" ")).toMatch(/could not be verified|unverified/i);
  });
});

describe("word count", () => {
  it("accepts a length inside the article's target range", () => {
    expect(criterion(scoreArticle(goodArticle), "word-count").status).toBe("pass");
  });

  it("fails a thin article", () => {
    const c = criterion(scoreArticle({ ...goodArticle, targetWordCount: { min: 2000, max: 2500 } }), "word-count");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/short/i);
  });

  it("fails a bloated article", () => {
    const c = criterion(scoreArticle({ ...goodArticle, targetWordCount: { min: 100, max: 150 } }), "word-count");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/long/i);
  });
});

describe("fabricated statistics — the highest-value check", () => {
  it("passes an article whose numbers all trace back to the source", () => {
    const c = criterion(scoreArticle(goodArticle), "fabricated-stats");
    expect(c.status).toBe("pass");
  });

  it("blocks an invented percentage", () => {
    const report = scoreArticle(fabricatedStatArticle);
    const c = criterion(report, "fabricated-stats");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toContain("68%");
    expect(report.blockingFailures).toContain("fabricated-stats");
    expect(report.passed).toBe(false);
  });

  it("blocks an invented currency figure", () => {
    const c = criterion(scoreArticle(fabricatedStatArticle), "fabricated-stats");
    expect(c.details.join(" ")).toContain("1,240");
  });

  it("blocks an invented authority", () => {
    const c = criterion(scoreArticle(fabricatedStatArticle), "fabricated-stats");
    expect(c.details.join(" ")).toMatch(/National Renters Institute/);
  });

  it("blocks unnamed-authority phrasing outright, source or not", () => {
    const report = scoreArticle({
      ...goodArticle,
      sourceMaterial: null,
      blocks: [
        ...(goodArticle.blocks ?? []),
        {
          type: "text",
          id: "extra",
          data: { content: "<p>Studies show a deposit deduction is usually reduced on appeal.</p>" },
        },
      ],
    });
    const c = criterion(report, "fabricated-stats");
    expect(c.status).toBe("fail");
    expect(c.details.join(" ")).toMatch(/studies show/i);
    expect(report.blockingFailures).toContain("fabricated-stats");
  });

  it("accepts a figure that really is in the source", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        sourceMaterial: "Adjudicators reduced 42% of cleaning claims last year, according to the Tenancy Deposit Scheme.",
        blocks: [
          ...(goodArticle.blocks ?? []),
          {
            type: "text",
            id: "extra",
            data: {
              content:
                '<p>Roughly 42% of cleaning claims are reduced on review, according to the Tenancy Deposit Scheme.</p>',
            },
          },
        ],
      }),
      "fabricated-stats"
    );
    expect(c.status).toBe("pass");
  });

  it("cannot verify numbers without source material, and says so instead of guessing", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        sourceMaterial: null,
        blocks: [
          ...(goodArticle.blocks ?? []),
          { type: "text", id: "extra", data: { content: "<p>Around 42% of claims are reduced.</p>" } },
        ],
      }),
      "fabricated-stats"
    );
    expect(c.status).not.toBe("fail");
    expect(c.details.join(" ")).toMatch(/could not be verified|no source material/i);
  });

  it("does not fire on ordinary prose numbers", () => {
    const c = criterion(
      scoreArticle({
        ...goodArticle,
        blocks: [
          ...(goodArticle.blocks ?? []),
          {
            type: "text",
            id: "extra",
            data: { content: "<p>Follow the 3 steps below and allow 10 minutes for each one.</p>" },
          },
        ],
      }),
      "fabricated-stats"
    );
    expect(c.status).toBe("pass");
  });
});

describe("threshold and configuration", () => {
  it("is configurable", () => {
    const strict = scoreArticle(goodArticle, { threshold: 101 });
    expect(strict.threshold).toBe(101);
    expect(strict.passed).toBe(false);
  });

  it("still holds an article on a blocking failure even at threshold 0", () => {
    const report = scoreArticle(brokenSchemaArticle, { threshold: 0 });
    expect(report.passed).toBe(false);
    expect(report.blockingFailures.length).toBeGreaterThan(0);
  });

  it("renormalises the weights when criteria are skipped", () => {
    const report = scoreArticle({ ...goodArticle, primaryKeyword: null });
    expect(report.score).toBeGreaterThanOrEqual(DEFAULT_QUALITY_GATE_CONFIG.threshold);
    expect(report.score).toBeLessThanOrEqual(100);
  });

  it("explains the verdict in one line", () => {
    expect(scoreArticle(keywordStuffedArticle).summary).toMatch(/held|fail/i);
    expect(scoreArticle(goodArticle).summary).toMatch(/pass/i);
  });
});

describe("fixture sanity", () => {
  it("the good fixture links only to slugs that exist", () => {
    const c = criterion(scoreArticle(goodArticle), "internal-links");
    expect((c.evidence as { unknownSlugs: string[] }).unknownSlugs).toEqual([]);
    expect(PUBLISHED_SLUGS.length).toBeGreaterThan(3);
  });
});
