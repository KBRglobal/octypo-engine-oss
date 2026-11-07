/**
 * Fixtures here follow live DataForSEO responses from the runs described in
 * `ai-answers.ts`: Perplexity `sonar` answering three buying questions for an
 * events company that it never names (text and hosts rewritten as neutral
 * examples, shape unchanged), and ChatGPT `gpt-5.4-nano` answering three for
 * note taking apps, where it names Notion every time. Both paths matter — the one
 * that must say "not named" and the one that must say "named" — and a matcher
 * tuned on invented text would be tuned on the wrong thing.
 *
 * Nothing here touches the network.
 */

import { describe, expect, it } from "vitest";

import { readEnvelope, type SeoClient } from "../client.js";
import {
  answerAnnotations,
  answerText,
  buildAiAnswersSection,
  buyingQuestions,
  chooseModel,
  domainsNamed,
  enginesFromIndex,
  excerptFrom,
  findingsFrom,
  namesTarget,
  type AiAnswerReading,
} from "./ai-answers.js";

/** Real `/ai_optimization/endpoints`, trimmed to the lines that matter. */
const ENDPOINTS = [
  "v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
  "v3/ai_optimization/chat_gpt/llm_responses/live",
  "v3/ai_optimization/chat_gpt/llm_responses/models",
  "v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
  "v3/ai_optimization/claude/llm_responses/live",
  "v3/ai_optimization/claude/llm_responses/models",
  "v3/ai_optimization/gemini/llm_responses/live",
  "v3/ai_optimization/gemini/llm_responses/models",
  "v3/ai_optimization/llm_mentions/search/live",
  "v3/ai_optimization/perplexity/llm_responses/live",
  "v3/ai_optimization/perplexity/llm_responses/models",
];

/** Real `/ai_optimization/perplexity/llm_responses/models`, in its order. */
const PERPLEXITY_MODELS = [
  { model_name: "sonar-reasoning-pro", reasoning: false, web_search_supported: true },
  { model_name: "sonar-pro", reasoning: false, web_search_supported: true },
  { model_name: "sonar", reasoning: false, web_search_supported: true },
];

/** Real `/ai_optimization/chat_gpt/llm_responses/models`, head of the list. */
const CHAT_GPT_MODELS = [
  { model_name: "o4-mini", reasoning: true, web_search_supported: true },
  { model_name: "o3-mini", reasoning: true, web_search_supported: false },
  { model_name: "gpt-5.5", reasoning: true, web_search_supported: true },
  { model_name: "gpt-5.4-nano", reasoning: true, web_search_supported: true },
  { model_name: "gpt-5.4-nano-2026-03-17", reasoning: true, web_search_supported: true },
  { model_name: "gpt-5.4-mini", reasoning: true, web_search_supported: true },
];

/** The shape of a Perplexity sonar answer to a buying question. */
const SAMPLE_ANSWER =
  "To choose an event production company, first define the type of event you are planning (corporate, wedding, conference, etc.) and where it will take place, then contact companies or sites that gather recommended suppliers by event type and area[4][7][9][16].  \n" +
  "In practice, most people start by searching recommendation databases (review sites, comparison pages, wedding sites) and pick 2–3 producers for an introductory meeting before deciding[1][2][16][19].  \n\n" +
  "### Where to look for recommended event producers\n\n" +
  "- **For all event types, by area:**\n" +
  "  - The *ReviewHub* site (reviewhub.co.uk) – includes a list of recommended event managers and producers by area, with customer reviews and ratings[1].  \n" +
  "  - A business directory such as *Golden Pages* (event production companies category) – a broad database of companies[2].";

/** The citations that came with it, as returned. */
const SAMPLE_ANNOTATIONS = [
  {
    title: "Recommended event managers and producers - 296 reviews on the site ...",
    url: "https://www.reviewhub.co.uk/Content/SectorPortal/171",
    start_index: null,
    end_index: null,
    text: null,
  },
  { title: "Find event production companies in your area", url: "https://www.pages.co.uk/h-c2805-e0-p0-l0/" },
  {
    title: "Corporate event production – top recommended companies (2026) - Expert",
    url: "https://www.expert.co.uk/reviews/event/",
  },
  { title: "How to choose an event production company without getting burned", url: "https://evento.plus/how-to-choose/" },
  // Gemini's shape: the bare host as the title, the real site in direct_url,
  // and Google's grounding proxy in url.
  {
    title: "mantel.co.uk",
    url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH13",
    direct_url: "https://mantel.co.uk/",
  },
];

/** ChatGPT gpt-5.4-nano, "I am choosing a note taking app…" — verbatim. */
const NOTION_ANSWER =
  "Here are some of the leading note-taking apps (popular, widely used, and well-regarded), grouped by ecosystem:\n\n" +
  "### Cross-platform (Windows/Mac/Linux/Web/iOS/Android)\n" +
  "- **Evernote** – long-time popular choice; strong search and organization.\n" +
  "- **OneNote (Microsoft)** – best if you’re in the Microsoft ecosystem; free-form notebooks, great for clipping.\n" +
  "- **Notion** – very popular; notes + wiki + databases; great for organizing knowledge.\n" +
  "- **Google Keep** – simple, fast notes; integrates well with Google.\n" +
  "- **Obsidian** – power-user favorite; local markdown files.";

/** A live envelope, built the way the provider builds it. */
function envelope(result: unknown[], cost = 0): Record<string, unknown> {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost,
    tasks: [{ id: "fixture", status_code: 20000, status_message: "Ok.", cost, result }],
  };
}

function llmResponse(model: string, text: string, annotations: unknown[] | null, cost: number) {
  return envelope(
    [
      {
        model_name: model,
        input_tokens: 29,
        output_tokens: 588,
        web_search: annotations !== null,
        money_spent: cost,
        items: [{ type: "message", sections: [{ type: "text", text, annotations }] }],
      },
    ],
    cost
  );
}

/** Real keyword volume payload for "note taking app", US/English. */
const VOLUME = envelope(
  [
    {
      location_code: 2840,
      language_code: "en",
      items_count: 1,
      items: [
        { keyword: "note taking app", ai_search_volume: 1966 },
        // A phrase the provider has nothing for. It must not become a zero row.
        { keyword: "note taking app for lawyers", ai_search_volume: null },
      ],
    },
  ],
  0.0101
);

interface StubOptions {
  answer?: (engine: string, question: string) => Record<string, unknown>;
  failGet?: string;
  failPost?: string;
  volume?: Record<string, unknown> | null;
}

/** A client that answers from the fixtures above and never opens a socket. */
function stubClient(options: StubOptions = {}): SeoClient {
  const models: Record<string, unknown[]> = {
    chat_gpt: CHAT_GPT_MODELS,
    claude: [{ model_name: "claude-haiku-4-5", web_search_supported: true }],
    gemini: [{ model_name: "gemini-2.5-flash-lite", web_search_supported: true }],
    perplexity: PERPLEXITY_MODELS,
  };

  return {
    async get(path: string) {
      if (options.failGet && path.includes(options.failGet)) throw new Error("provider down");
      if (path.endsWith("/endpoints")) return readEnvelope(envelope([ENDPOINTS]));
      const engine = path.split("/")[2];
      return readEnvelope(envelope(models[engine] ?? []));
    },
    async post(path: string, params: Record<string, unknown>) {
      if (options.failPost && path.includes(options.failPost)) throw new Error("provider down");
      if (path.includes("keywords_search_volume")) {
        if (options.volume === null) throw new Error("Internal Error.");
        return readEnvelope(options.volume ?? VOLUME);
      }
      const engine = path.split("/")[2];
      const question = String(params.user_prompt ?? "");
      return readEnvelope(
        options.answer?.(engine, question) ??
          llmResponse("sonar", SAMPLE_ANSWER, SAMPLE_ANNOTATIONS, 0.013604)
      );
    },
  } as unknown as SeoClient;
}

describe("answerText", () => {
  it("reads the message and leaves the model's private reasoning out of it", () => {
    // ChatGPT returns its scratchpad as `reasoning` items. Quoting that to a
    // client would show them the model talking about them, not answering.
    const items = [
      { type: "reasoning", sections: [{ type: "summary_text", text: "**Searching for event companies**" }] },
      { type: "reasoning", sections: null },
      { type: "message", sections: [{ type: "text", text: NOTION_ANSWER, annotations: null }] },
    ];
    const text = answerText(items);
    expect(text).toBe(NOTION_ANSWER);
    expect(text).not.toContain("Searching for event companies");
  });

  it("survives a shape it has never seen", () => {
    expect(answerText([null, "text", { type: "message" }, { type: "message", sections: 7 }])).toBe("");
  });
});

describe("answerAnnotations", () => {
  it("collects the citations off the message sections", () => {
    const items = [{ type: "message", sections: [{ type: "text", text: "x", annotations: SAMPLE_ANNOTATIONS }] }];
    expect(answerAnnotations(items)).toHaveLength(SAMPLE_ANNOTATIONS.length);
    expect(answerAnnotations([{ type: "message", sections: [{ type: "text", annotations: null }] }])).toEqual([]);
  });
});

describe("enginesFromIndex", () => {
  it("reads the engines that can take a prompt, and nothing else", () => {
    expect(enginesFromIndex(ENDPOINTS)).toEqual(["chat_gpt", "claude", "gemini", "perplexity"]);
  });

  it("is empty rather than guessing when the index is not a list", () => {
    expect(enginesFromIndex(null)).toEqual([]);
    expect(enginesFromIndex({ endpoints: ENDPOINTS })).toEqual([]);
  });
});

describe("chooseModel", () => {
  it("takes the plain small model over the dearer sibling that shares its name", () => {
    // Measured: picking the first "sonar" in the list picks sonar-reasoning-pro
    // and triples the bill for the same answer.
    expect(chooseModel(PERPLEXITY_MODELS, true)).toBe("sonar");
  });

  it("prefers the rolling alias over a dated snapshot of the same model", () => {
    expect(chooseModel(CHAT_GPT_MODELS, true)).toBe("gpt-5.4-nano");
  });

  it("will not pick a model that cannot search when searching was asked for", () => {
    const onlyStatic = [{ model_name: "o3-mini", web_search_supported: false }];
    expect(chooseModel(onlyStatic, true)).toBeNull();
    expect(chooseModel(onlyStatic, false)).toBe("o3-mini");
  });

  it("returns null rather than an empty name", () => {
    expect(chooseModel([], true)).toBeNull();
    expect(chooseModel([{ reasoning: true }], true)).toBeNull();
  });
});

describe("namesTarget", () => {
  const prospect = { brand: "Eventra", domain: "acme-events.co.uk", seed: "event production" };

  it("reads a real answer that never names the prospect as not naming them", () => {
    expect(namesTarget(SAMPLE_ANSWER, prospect)).toBe(false);
  });

  it("finds the bare domain however it is written", () => {
    expect(namesTarget(`${SAMPLE_ANSWER}\n- Eventra (acme-events.co.uk)`, prospect)).toBe(true);
    expect(namesTarget("see https://www.Acme-Events.co.uk/about", prospect)).toBe(true);
  });

  it("finds the brand on a word boundary, and not inside a longer word", () => {
    expect(namesTarget("The company Eventra produces conferences.", prospect)).toBe(true);
    expect(namesTarget("Eventrainers are another community altogether.", prospect)).toBe(false);
  });

  it("holds the same boundary in a script outside ASCII", () => {
    const arabic = { brand: "\u0646\u0648\u0631", domain: "" }; // "Nour"
    expect(namesTarget("\u0634\u0631\u0643\u0629 \u0646\u0648\u0631 \u0644\u0644\u0641\u0639\u0627\u0644\u064A\u0627\u062A", arabic)).toBe(true);
    expect(namesTarget("\u0627\u0644\u0646\u0648\u0631\u0627\u0646\u064A", arabic)).toBe(false);
  });

  it("names Notion from a real ChatGPT answer", () => {
    expect(namesTarget(NOTION_ANSWER, { brand: "Notion", domain: "notion.so", seed: "note taking app" })).toBe(
      true
    );
  });

  it("does not turn the English noun into a mention of the brand", () => {
    // The expensive error: a client reads "you are named" and finds this.
    expect(
      namesTarget("I have no notion of which app is best.", {
        brand: "Notion",
        domain: "notion.so",
        seed: "note taking app",
      })
    ).toBe(false);
  });

  it("ignores a brand made only of its own category words", () => {
    expect(
      namesTarget("We recommend professional Event Production.", {
        brand: "Event Production",
        domain: "example.co.uk",
        seed: "event production",
      })
    ).toBe(false);
  });

  it("will not match on a two-letter brand", () => {
    expect(namesTarget("we like AB and CD", { brand: "AB", domain: "" })).toBe(false);
  });
});

describe("domainsNamed", () => {
  it("lists the domains a real answer pointed at, text first then citations", () => {
    const named = domainsNamed(SAMPLE_ANSWER, SAMPLE_ANNOTATIONS, "acme-events.co.uk");
    expect(named[0]).toBe("reviewhub.co.uk");
    expect(named).toContain("pages.co.uk");
    expect(named).toContain("expert.co.uk");
    expect(named).toContain("evento.plus");
  });

  it("credits Gemini's citation to the real site, not to Google's redirector", () => {
    const named = domainsNamed("", SAMPLE_ANNOTATIONS, "acme-events.co.uk");
    expect(named).toContain("mantel.co.uk");
    expect(named).not.toContain("vertexaisearch.cloud.google.com");
  });

  it("leaves out the prospect's own domain and the global platforms", () => {
    const text = "see acme-events.co.uk, www.acme-events.co.uk, facebook.com and youtube.com plus rival.co.uk";
    expect(domainsNamed(text, [], "acme-events.co.uk")).toEqual(["rival.co.uk"]);
  });

  it("does not mistake a file name or an e-mail host for a competitor", () => {
    expect(domainsNamed("open index.html or mail info@rival.co.uk", [], "acme-events.co.uk")).toEqual([]);
  });
});

describe("excerptFrom", () => {
  it("keeps the quote short and strips markup the renderer would show raw", () => {
    const excerpt = excerptFrom(SAMPLE_ANSWER, { brand: "Eventra", domain: "acme-events.co.uk" });
    expect(excerpt).not.toBeNull();
    expect(excerpt!.length).toBeLessThanOrEqual(310);
    expect(excerpt).not.toContain("**");
    expect(excerpt).not.toContain("[4]");
  });

  it("centres the quote on the prospect when they are named", () => {
    const long = `${"x ".repeat(300)}and then they recommend acme-events.co.uk as a supplier.${" y".repeat(300)}`;
    const excerpt = excerptFrom(long, { brand: "Eventra", domain: "acme-events.co.uk" });
    expect(excerpt).toContain("acme-events.co.uk");
  });

  it("is null for an empty answer rather than an empty quote", () => {
    expect(excerptFrom("   ", {})).toBeNull();
  });
});

describe("buyingQuestions", () => {
  it("keeps the seed as given, in whatever language it came", () => {
    const seed = "\u30A4\u30D9\u30F3\u30C8\u5236\u4F5C"; // "event production" in Japanese
    const questions = buyingQuestions(seed);
    expect(questions).toHaveLength(5);
    expect(questions.every((question) => question.includes(seed))).toBe(true);
  });

  it("asks in English", () => {
    expect(buyingQuestions("note taking app")[0]).toBe(
      "What are the best note taking app options available today?"
    );
  });

  it("asks nothing without a category", () => {
    expect(buyingQuestions("  ")).toEqual([]);
  });
});

describe("findingsFrom", () => {
  const reading = (mentions: boolean, namedInstead: string[] = []): AiAnswerReading => ({
    engine: "perplexity",
    model: "sonar",
    question: "q",
    mentionsProspect: mentions,
    namedInstead,
    excerpt: "…",
  });

  it("says nothing at all when nothing was measured", () => {
    expect(findingsFrom([], null, [], "Eventra")).toEqual([]);
  });

  it("spells out a single assistant instead of gluing a digit to the noun", () => {
    const findings = findingsFrom(
      [reading(false)],
      { questionsAsked: 1, timesNamed: 0, enginesCovered: 1 },
      [],
      "Eventra"
    );
    expect(findings[0].detail).toContain("one AI assistant");
    expect(findings[0].detail).not.toContain("1 AI");
  });

  it("ranks the sites named instead by how often they came up", () => {
    const findings = findingsFrom(
      [reading(false, ["a.co.uk", "b.co.uk"]), reading(false, ["b.co.uk"])],
      { questionsAsked: 2, timesNamed: 0, enginesCovered: 1 },
      [],
      "Eventra"
    );
    const rivals = findings.find((finding) => finding.title.includes("did send people to"));
    expect(rivals?.count).toBe(2);
    expect(rivals?.detail).toContain("b.co.uk, a.co.uk");
  });
});

describe("buildAiAnswersSection", () => {
  const input = {
    businessName: "Eventra",
    domain: "acme-events.co.uk",
    seed: "event production",
    market: { locationCode: 2826, languageCode: "en" },
    engines: ["perplexity"],
    questions: 3,
  };

  it("reports the not-named reading a live run produced", async () => {
    const section = await buildAiAnswersSection(stubClient({ volume: null }), input);

    expect(section.engines).toHaveLength(3);
    expect(section.engines[0].engine).toBe("perplexity");
    expect(section.engines[0].model).toBe("sonar");
    expect(section.summary).toEqual({ questionsAsked: 3, timesNamed: 0, enginesCovered: 1 });
    expect(section.engines[0].namedInstead).toContain("reviewhub.co.uk");
    expect(section.findings[0].title).toBe("Your business did not appear in any answer");
    // Three answers at the fixture's own price, and the failed volume call at nothing.
    expect(section.costUsd).toBeCloseTo(0.040812, 6);
    expect(section.unmeasured).toContain("aiSearchVolume");
  });

  it("reports the named reading a live run produced, with real assistant volume", async () => {
    const section = await buildAiAnswersSection(
      stubClient({ answer: () => llmResponse("gpt-5.4-nano-2026-03-17", NOTION_ANSWER, null, 0.001075) }),
      {
        businessName: "Notion",
        domain: "notion.so",
        seed: "note taking app",
        market: { locationCode: 2840, languageCode: "en" },
        engines: ["chat_gpt"],
        questions: 3,
        webSearch: false,
      }
    );

    expect(section.summary).toEqual({ questionsAsked: 3, timesNamed: 3, enginesCovered: 1 });
    expect(section.engines[0].model).toBe("gpt-5.4-nano-2026-03-17");
    expect(section.findings[0].title).toBe("Your business appeared in every answer");
    // Null volume is not a zero row: only the phrase with a real number shows.
    expect(section.aiSearchVolume).toEqual([{ keyword: "note taking app", volume: 1966 }]);
    expect(section.unmeasured).toEqual([]);
  });

  it("asks every engine the account has when none were named", async () => {
    const asked: string[] = [];
    const client = stubClient({
      answer: (engine) => {
        asked.push(engine);
        return llmResponse("m", SAMPLE_ANSWER, SAMPLE_ANNOTATIONS, 0.001);
      },
    });
    const section = await buildAiAnswersSection(client, { ...input, engines: undefined });
    expect(new Set(asked)).toEqual(new Set(["chat_gpt", "claude", "gemini", "perplexity"]));
    expect(section.summary?.enginesCovered).toBe(4);
  });

  it("omits the section instead of guessing when no category was given", async () => {
    const section = await buildAiAnswersSection(stubClient(), { ...input, seed: "  " });
    expect(section.engines).toEqual([]);
    expect(section.summary).toBeNull();
    expect(section.findings).toEqual([]);
    expect(section.unmeasured).toEqual(["seed"]);
    expect(section.costUsd).toBe(0);
  });

  it("never throws when the provider does, and names what was lost", async () => {
    const section = await buildAiAnswersSection(stubClient({ failPost: "llm_responses" }), input);
    expect(section.summary).toBeNull();
    expect(section.engines).toEqual([]);
    expect(section.unmeasured).toContain("ask:perplexity");
    expect(section.unmeasured).toContain("engines:no-answer");
  });

  it("returns an empty section when the engine index itself is unreachable", async () => {
    const section = await buildAiAnswersSection(stubClient({ failGet: "endpoints" }), input);
    expect(section.unmeasured).toEqual(["engines", "engines:none-available"]);
    expect(section.costUsd).toBe(0);
  });

  it("counts an empty answer as unmeasured, not as a miss", async () => {
    const section = await buildAiAnswersSection(
      stubClient({ answer: () => llmResponse("sonar", "   ", null, 0.002), volume: null }),
      input
    );
    expect(section.engines).toEqual([]);
    expect(section.summary).toBeNull();
    expect(section.unmeasured).toContain("empty:perplexity");
    // The money was still spent, and the section says so.
    expect(section.costUsd).toBeCloseTo(0.006, 6);
  });
});
