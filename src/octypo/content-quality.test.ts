import { describe, expect, it } from "vitest";

import {
  corpusDuplicateIssues,
  editorialStyleIssues,
  intentAnswerIssues,
} from "./content-quality.js";

const text = (content: string) => [{ type: "text", data: { content: `<p>${content}</p>` } }];

describe("intent answer gate", () => {
  it("holds a cost article that avoids both price and pricing mechanism", () => {
    expect(intentAnswerIssues({
      title: "How Much Does a Website Cost?",
      answerCapsule: "Website projects vary and every business is different.",
      blocks: text("Many factors affect the work."),
    }).map(issue => issue.code)).toContain("INTENT_COST");
  });

  it("accepts a fixed-price mechanism with concrete scope drivers", () => {
    expect(intentAnswerIssues({
      title: "How Much Does a Website Cost?",
      answerCapsule: "After a short brief, the team gives a fixed price for a defined starter, custom, store, or portal scope.",
      blocks: text("Discovery, build, launch, and maintenance are priced separately."),
    })).toEqual([]);
  });

  it("holds a timeline answer without a range and conditions", () => {
    expect(intentAnswerIssues({
      title: "How Long Does It Take to Build a Website?",
      answerCapsule: "The timeline varies.",
      blocks: text("Every project is different."),
    }).map(issue => issue.code)).toContain("INTENT_TIMELINE");
  });

  it("accepts bounded timeline units with conditions", () => {
    expect(intentAnswerIssues({
      title: "How Long Does It Take to Build a Website?",
      answerCapsule: "A starter can take days and a custom build can take weeks when content and approvals are ready.",
      blocks: text("Integrations and migration can extend the schedule to months."),
    })).toEqual([]);
  });
});

describe("editorial style gate", () => {
  it("holds a joined article and noun", () => {
    expect(editorialStyleIssues({
      title: "Business websites",
      blocks: text("Abusiness website should state its offer clearly."),
    }).map(issue => issue.code)).toContain("TEXT_JOIN");
  });

  it("holds exact-keyword repetition across subheadings", () => {
    expect(editorialStyleIssues({
      title: "Website checklist",
      primaryKeyword: "business website checklist",
      blocks: [
        { type: "heading", data: { text: "Business website checklist essentials" } },
        { type: "heading", data: { text: "Business website checklist misses" } },
      ],
    }).map(issue => issue.code)).toContain("HEADING_STUFFING");
  });

  it("accepts the exact keyword in one subheading", () => {
    expect(editorialStyleIssues({
      title: "Website checklist",
      primaryKeyword: "business website checklist",
      blocks: [
        { type: "heading", data: { text: "Business website checklist essentials" } },
        { type: "heading", data: { text: "Common misses" } },
      ],
    })).toEqual([]);
  });
});

describe("corpus duplicate gate", () => {
  it("holds copied long editorial passages", () => {
    const copied = "Record the outcome, evidence, boundaries, ownership and acceptance criteria before implementation so the decision does not drift during delivery.";
    const issues = corpusDuplicateIssues(
      { title: "New", blocks: text(copied) },
      [{ id: "old", slug: "old-page", blocks: text(copied) }]
    );
    expect(issues[0]?.code).toBe("CORPUS_DUPLICATE");
    expect(issues[0]?.matchedSlugs).toEqual(["old-page"]);
  });

  it("ignores repeated source-list entries", () => {
    const blocks = [
      { type: "heading", data: { text: "Sources and further reading" } },
      ...text("Creating helpful, reliable, people-first content from Google Search Central and other official documentation."),
    ];
    expect(corpusDuplicateIssues(
      { title: "New", blocks },
      [{ id: "old", slug: "old-page", blocks }]
    )).toEqual([]);
  });

  it("holds a copied heading skeleton even when the body is rewritten", () => {
    const structure = (prefix: string) => [
      { type: "heading", data: { text: "The operating principles" } },
      ...text(`${prefix} explains one original and sufficiently detailed editorial idea for this article.`),
      { type: "heading", data: { text: "A practical roadmap" } },
      ...text(`${prefix} provides a different and sufficiently detailed roadmap for this article and its reader.`),
      { type: "heading", data: { text: "What weakens the strategy" } },
      ...text(`${prefix} documents unique risks and evidence without copying a sentence from the other page.`),
    ];
    const issues = corpusDuplicateIssues(
      { title: "New", blocks: structure("Candidate") },
      [{ id: "old", slug: "old-page", blocks: structure("Existing") }]
    );
    expect(issues.map(issue => issue.code)).toContain("CORPUS_STRUCTURE");
  });
});
