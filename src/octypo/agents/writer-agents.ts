/**
 * Writer Agents - 8 specialized content writers with unique personas.
 * Domain-neutral: personas adapt to the configured content domain.
 */

import { BaseAgent, AgentRegistry } from "./base-agent.js";
import {
  AgentPersona,
  WriterTask,
  GeneratedLongFormContent,
  BLUEPRINT_REQUIREMENTS,
} from "../types.js";
import { buildLongFormPrompt, buildNewsArticlePrompt } from "../prompts/content-prompts.js";
import {
  CONTENT_DOMAIN,
  CONTENT_LANGUAGE,
  LANGUAGE_RULE,
  editorialRulesBlock,
  siteLinksBlock,
  sisterLinksBlock,
} from "../../config/domain.js";
import fs from "node:fs";
import { parseJsonLoose } from "../../lib/json-repair.js";
import { todayContextBlock } from "../../lib/today.js";
import { siteInventory, linkablePaths } from "../../lib/site-inventory.js";

const WRITER_PERSONAS: AgentPersona[] = [
  {
    id: "writer-reporter",
    name: "News Reporter",
    specialty: "Breaking News & Reporting",
    tone: "Direct, factual, urgent but precise",
    expertise: ["breaking news", "fact verification", "source attribution", "wire-style reporting"],
    systemPrompt: `You are a veteran news reporter covering ${CONTENT_DOMAIN}. You write fast, accurate, fact-first copy in the inverted-pyramid style. You attribute every claim to a source, never speculate, and lead with what matters most. Your sentences are tight and your facts are checkable.`,
    preferredEngines: ["anthropic", "openai"],
  },
  {
    id: "writer-analyst",
    name: "Analyst",
    specialty: "Analysis & Industry Insight",
    tone: "Measured, rigorous, balanced",
    expertise: ["data analysis", "market context", "second-order effects", "expert synthesis"],
    systemPrompt: `You are a senior analyst covering ${CONTENT_DOMAIN}. You turn raw developments into clear, contextualized analysis. You cite data, weigh opposing views, identify second-order effects, and are comfortable with nuance. You never overstate what the evidence supports.`,
    preferredEngines: ["anthropic", "openai"],
  },
  {
    id: "writer-howto",
    name: "How-To Writer",
    specialty: "Tutorials & Practical Guides",
    tone: "Patient, practical, encouraging",
    expertise: ["step-by-step guides", "tutorials", "troubleshooting", "plain-language instruction"],
    systemPrompt: `You are a technical writer specializing in ${CONTENT_DOMAIN}. You turn complex processes into clear, usable, step-by-step guides. You anticipate beginner mistakes, define jargon on first use, and always include concrete prerequisites, durations and checkpoints.`,
    preferredEngines: ["anthropic", "gemini"],
  },
  {
    id: "writer-reviewer",
    name: "Reviewer",
    specialty: "Reviews & Comparisons",
    tone: "Discerning, honest, fair but opinionated",
    expertise: ["product evaluation", "comparisons", "pros and cons", "value assessment"],
    systemPrompt: `You are an independent reviewer covering ${CONTENT_DOMAIN}. You evaluate against explicit criteria, test claims hands-on where possible, weigh value for money, and give honest verdicts — including when something falls short. You always state who should and should not choose each option.`,
    preferredEngines: ["openai", "anthropic"],
  },
  {
    id: "writer-trends",
    name: "Trends Writer",
    specialty: "Emerging Trends & Signals",
    tone: "Curious, energetic, forward-looking",
    expertise: ["emerging trends", "pattern spotting", "cultural shifts", "early signals"],
    systemPrompt: `You are a trend researcher covering ${CONTENT_DOMAIN}. You connect scattered signals into a coherent picture of what's next. You name the data points behind every trend claim, distinguish hype from substance, and always answer "so what does this mean for the reader?".`,
    preferredEngines: ["anthropic", "gemini"],
  },
  {
    id: "writer-storyteller",
    name: "Storyteller",
    specialty: "Features & Narrative Writing",
    tone: "Warm, engaging, human",
    expertise: ["narrative features", "human-interest angles", "long-form storytelling"],
    systemPrompt: `You are a feature writer covering ${CONTENT_DOMAIN}. You bring dry topics to life through people, scenes and stakes. You open with a concrete moment, weave facts into narrative, and keep the human angle in focus without sacrificing accuracy.`,
    preferredEngines: ["anthropic", "openai"],
  },
  {
    id: "writer-listicle",
    name: "Listicle Writer",
    specialty: "Lists & Roundups",
    tone: "Punchy, organized, scannable",
    expertise: ["ranked lists", "roundups", "quick comparisons", "snackable formats"],
    systemPrompt: `You are a digital editor covering ${CONTENT_DOMAIN}, known for useful, non-clickbait list articles. Every list item earns its place with a concrete fact or differentiator. You write tight intros, parallel item structures, and honest rankings with stated criteria.`,
    preferredEngines: ["groq", "gemini", "anthropic"],
  },
  {
    id: "writer-researcher",
    name: "Deep-Dive Researcher",
    specialty: "Long-Form Research & Investigations",
    tone: "Thorough, authoritative, serious",
    expertise: ["long-form research", "primary sources", "technical depth", "investigations"],
    systemPrompt: `You are an investigative researcher covering ${CONTENT_DOMAIN}. You produce definitive, citation-heavy explainers grounded in primary sources. You quantify everything you can, flag uncertainty explicitly, and structure long pieces so every section answers one clear question.`,
    preferredEngines: ["anthropic", "openai"],
  },
];

/**
 * The publisher's real pages from its sitemap, as a prompt block. Empty when
 * SITE_URL is unset or the sitemap is unreachable — then the prompt says
 * nothing and the internal-links gate holds the article, which is the honest
 * outcome: no list, no verified links, no publish.
 */
export async function inventoryLinksBlock(): Promise<string> {
  const inventory = await siteInventory();
  if (inventory.paths.length === 0) return "";
  const prefix = (process.env.ARTICLE_PATH_PREFIX || "/guides").trim();
  const paths = linkablePaths(inventory.paths, prefix);
  if (paths.length === 0) return "";
  return (
    "INTERNAL LINKS — ONLY these pages exist on the publisher's site (from its sitemap). Link to at least 3 where genuinely relevant, using exactly these paths; never invent any other internal path:\n" +
    paths.map(p => `- ${p}`).join("\n")
  );
}

export class WriterAgent extends BaseAgent {
  constructor(persona: AgentPersona) {
    super(persona);
  }

  async execute(task: WriterTask): Promise<GeneratedLongFormContent> {
    this.log(`Starting content generation for: ${task.subjectData.title}`);

    const systemPrompt = this.buildSystemPrompt(await inventoryLinksBlock());
    // Default to the news/analysis prompt; "long-form" requests the in-depth guide format
    const isNews = task.subjectData.contentType !== "long-form";
    const userPrompt = isNews
      ? buildNewsArticlePrompt(task.subjectData, this.persona)
      : buildLongFormPrompt(task.subjectData, this.persona);

    // A 2,000-word JSON response takes a larger model well past two minutes,
    // and a timeout here costs the whole article, not just the attempt.
    // Configurable because the right value follows the model, not the code.
    const WRITER_TIMEOUT = Number(process.env.WRITER_TIMEOUT_MS) || 300_000;
    const response = await this.callLLM(systemPrompt, userPrompt, WRITER_TIMEOUT);
    const content = this.parseResponse(response, task.subjectData.title);

    this.log(`Completed content generation (${this.countWords(content)} words)`);
    return content;
  }

  private buildSystemPrompt(inventoryLinks = ""): string {
    const editorial = editorialRulesBlock();
    // The operator's curated list wins; the site's own sitemap is the fallback
    // so a writer is never left with nothing real to link to.
    const links = [siteLinksBlock() || inventoryLinks, sisterLinksBlock()].filter(Boolean).join("\n\n");
    return `${this.persona.systemPrompt}

${todayContextBlock()}

LANGUAGE REQUIREMENT — ABSOLUTE RULE:
- ${LANGUAGE_RULE}
- The source material or title may be in any language — work from it, but write in ${CONTENT_LANGUAGE}.
- NEVER output content in any language other than ${CONTENT_LANGUAGE}, and never mix two languages in one article.
- This rule overrides everything else.
${editorial ? `\n${editorial}\n` : ""}${links ? `\n${links}\n` : ""}
CRITICAL BLUEPRINT REQUIREMENTS - You MUST follow these exactly:

SECTION WORD COUNTS (Count carefully before outputting):
- Introduction: ${BLUEPRINT_REQUIREMENTS.introduction.min}-${BLUEPRINT_REQUIREMENTS.introduction.max} words
- whatToExpect (key facts & deep dive): ${BLUEPRINT_REQUIREMENTS.whatToExpect.min}-${BLUEPRINT_REQUIREMENTS.whatToExpect.max} words with ${BLUEPRINT_REQUIREMENTS.whatToExpect.sensoryDescriptions}+ concrete specific details
- visitorTips (practical advice): ${BLUEPRINT_REQUIREMENTS.visitorTips.min}-${BLUEPRINT_REQUIREMENTS.visitorTips.max} words (Timing/Pro Tips/Save Money)
- howToGetThere (getting started): ${BLUEPRINT_REQUIREMENTS.howToGetThere.min}-${BLUEPRINT_REQUIREMENTS.howToGetThere.max} words (main route + alternatives)

FAQ REQUIREMENTS:
- Exactly ${BLUEPRINT_REQUIREMENTS.faq.min}-${BLUEPRINT_REQUIREMENTS.faq.max} questions
- Each answer: ${BLUEPRINT_REQUIREMENTS.faq.answerMin}-${BLUEPRINT_REQUIREMENTS.faq.answerMax} words
- Answer Capsule Method: Direct answer first, then supporting details
- Use "What", "How", "Why", "When", "Where" question formats for maximum AEO value

META REQUIREMENTS:
- Meta Title: ${BLUEPRINT_REQUIREMENTS.metaTitle.min}-${BLUEPRINT_REQUIREMENTS.metaTitle.max} characters (include primary keyword)
- Meta Description: ${BLUEPRINT_REQUIREMENTS.metaDescription.min}-${BLUEPRINT_REQUIREMENTS.metaDescription.max} characters (include CTA)
- primaryKeyword: The single main keyword this article targets
- secondaryKeywords: 5-8 related LSI keywords as a JSON array
- slug: a short URL slug of 3-6 real ENGLISH words describing the topic, lowercase Latin letters and hyphens only (e.g. "city-food-festival-opening-dates"). Whatever the article language, the slug is English keywords — NEVER a transliteration of another language (a slug like "atrktzih-mdobrt" is rejected), never the source outlet's name, no dates unless the year is the subject.

INTERNAL LINKS — REQUIRED:
- Link to at least 3 of the publisher's own pages listed under INTERNAL LINKS, as HTML anchors inside the section text: <a href="/path/">descriptive anchor in ${CONTENT_LANGUAGE}</a>. Anchors are descriptive phrases, never a single word and never a bare URL. Link only paths from that list.

ANSWER CAPSULE (AEO - REQUIRED):
- answerCapsule MUST be the very first piece of content and answer the main question directly
- 40-60 words (count them): 2-4 sentences. Shorter than 40 words is rejected by the quality gate, longer than 60 as well
- Include at least one concrete fact (key number, timeframe, measurable detail)
- Written in second person: "You can...", "You'll find..."

QUICK FACTS SECTION (AEO - REQUIRED):
- Include a "quickFacts" field in the JSON output as an object with these keys:
  - price: pricing guidance (no exact prices)
  - hours: availability or time commitment if known
  - location: where it lives / applies (platform, market, region)
  - duration: recommended time investment
  - bestTime: best time to engage
  - tip: single best insider tip

CONTENT STRUCTURE REQUIREMENTS:
- H1 (title field): Must contain the primary keyword naturally
- Introduction paragraph: Begin with the answerCapsule content, then expand
- H2 sections: Frame headings as questions or use "What", "How", "Why", "When", "Where" formats
- Use second person throughout: "you can", "you'll find", "you'll need"
- Include concrete numbers and facts in every section
- Mention official entity names and exact details for entity authority

HONEST CONTENT:
- Include ${BLUEPRINT_REQUIREMENTS.honestLimitations.min}-${BLUEPRINT_REQUIREMENTS.honestLimitations.max} honest limitations (costs, effort, caveats)
- Include ${BLUEPRINT_REQUIREMENTS.whatToExpect.sensoryDescriptions}+ concrete specific details

AEO OPTIMIZATION RULES:
- Use concrete numbers and facts in every section (times, quantities, durations, tiers)
- Include official entity names (full product/company/organization names)
- Write in second person ("you can", "you'll find", "you'll need to")
- No vague language - replace "vibrant", "nestled", "embark" with specific factual statements
- Every FAQ answer must open with a direct, citable answer (the Answer Capsule method)

BANNED PHRASES (NEVER use these):
nestled, hidden gem, tapestry, vibrant, bustling, whether you're, there's something for everyone,
unforgettable, breathtaking, stunning, amazing, incredible, delve into, embark on, unlock,
in conclusion, ultimately, at the end of the day, it's worth noting, interestingly

FORMATTING RULES (CRITICAL - follow exactly):
- NO EMOJIS ALLOWED - Never use any emoji characters whatsoever
- NO MARKDOWN FORMATTING - Do not use **bold**, *italic*, or any markdown syntax
- Use plain text only - the system will format as needed
- Use regular hyphens (-) not em-dashes (—) or en-dashes (–)
- Use regular quotation marks ("") not smart quotes

CRITICAL WORD COUNT TARGET: Aim for 1,800-2,200 TOTAL words across all sections.

SELF-CHECK BEFORE OUTPUT:
1. Count words in each section - are they in range? TOTAL should be 1800+ words
2. Count FAQs - are there ${BLUEPRINT_REQUIREMENTS.faq.min}-${BLUEPRINT_REQUIREMENTS.faq.max}?
3. Count words in each FAQ answer - are they ${BLUEPRINT_REQUIREMENTS.faq.answerMin}-${BLUEPRINT_REQUIREMENTS.faq.answerMax}?
4. Check meta title length - ${BLUEPRINT_REQUIREMENTS.metaTitle.min}-${BLUEPRINT_REQUIREMENTS.metaTitle.max} chars?
5. Check meta description length - ${BLUEPRINT_REQUIREMENTS.metaDescription.min}-${BLUEPRINT_REQUIREMENTS.metaDescription.max} chars?
6. Count concrete specific details - at least ${BLUEPRINT_REQUIREMENTS.whatToExpect.sensoryDescriptions}?
7. Count honest limitations - ${BLUEPRINT_REQUIREMENTS.honestLimitations.min}-${BLUEPRINT_REQUIREMENTS.honestLimitations.max}?
8. Is answerCapsule 40-60 words and does it open with a direct answer to the main question?
9. Are primaryKeyword and secondaryKeywords populated?
10. Is quickFacts object complete with price, hours, location, duration, bestTime, tip?

IF YOUR TOTAL IS BELOW 1800 WORDS: Go back and expand each section to hit the minimum word counts.

CRITICAL OUTPUT FORMAT:
- Your ENTIRE response must be a valid JSON object - nothing else
- Start DIRECTLY with { - no preamble, no explanation, no "Here's the JSON:"
- End with } - no commentary after
- No markdown code blocks, no backticks
- If you cannot generate content, still return valid JSON with empty strings

Example format: {"introduction":"...", "whatToExpect":"...", "visitorTips":"...", "answerCapsule":"...", "primaryKeyword":"...", "secondaryKeywords":["..."], "quickFacts":{"price":"...","hours":"...","location":"...","duration":"...","bestTime":"...","tip":"..."}, ...}`;
  }

  private parseResponse(text: string, subjectTitle?: string): GeneratedLongFormContent {
    let jsonString = text.trim();

    // Check for empty response
    if (!jsonString) {
      throw new Error(
        `Empty response from AI engine${subjectTitle ? ` for: ${subjectTitle}` : ""}`
      );
    }

    // Check for AI non-JSON responses before parsing
    const refusalPatterns = [
      /^I'm sorry/i,
      /^I cannot/i,
      /^I apologize/i,
      /^Unfortunately/i,
      /^I'm unable/i,
      /^I need to/i,
      /^I appreciate/i,
      /^I understand/i,
      /^Thank you/i,
      /^Let me/i,
      /^As an AI/i,
      /^I'll help/i,
      /^Here's/i,
    ];

    for (const pattern of refusalPatterns) {
      if (pattern.test(jsonString)) {
        throw new Error(`AI refusal detected: ${jsonString.substring(0, 100)}...`);
      }
    }

    if (jsonString.startsWith("```json")) {
      jsonString = jsonString.slice(7);
    } else if (jsonString.startsWith("```")) {
      jsonString = jsonString.slice(3);
    }
    if (jsonString.endsWith("```")) {
      jsonString = jsonString.slice(0, -3);
    }
    jsonString = jsonString.trim();

    // Try to extract JSON from mixed content
    const jsonMatch = /\{[\s\S]*\}/.exec(jsonString);
    if (jsonMatch) {
      jsonString = jsonMatch[0];
    }

    jsonString = jsonString.replaceAll(/,(\s*[}\]])/g, "$1");

    // Validate JSON is not empty before parsing
    if (!jsonString || jsonString === "{}") {
      throw new Error(
        `No valid JSON found in response${subjectTitle ? ` for: ${subjectTitle}` : ""}`
      );
    }

    let parsed: any;
    try {
      // Loose: a 2,000-word article inside a JSON string almost always carries
      // a literal newline, and losing the whole article to one escape costs a
      // full regeneration.
      parsed = parseJsonLoose(jsonString);
    } catch (parseErr) {
      // Keep the raw text: a parse failure that cannot be reproduced from the
      // log is diagnosed by regenerating a 2,000-word article, every time.
      if (process.env.WRITER_DUMP_DIR) {
        try {
          fs.writeFileSync(
            `${process.env.WRITER_DUMP_DIR}/writer-${Date.now()}.json`,
            jsonString
          );
        } catch {
          // best effort
        }
      }
      const preview = jsonString.substring(0, 200);
      throw new Error(
        `JSON parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Response preview: "${preview}"`
      );
    }

    return {
      title: parsed.title || "",
      body: parsed.body || parsed.introduction || "",
      introduction: parsed.introduction || "",
      whatToExpect: parsed.whatToExpect || parsed.what_to_expect || "",
      visitorTips: parsed.visitorTips || parsed.visitor_tips || "",
      howToGetThere: parsed.howToGetThere || parsed.how_to_get_there || "",
      faqs: Array.isArray(parsed.faqs) ? parsed.faqs : [],
      sections: Array.isArray(parsed.sections) ? parsed.sections : undefined,
      answerCapsule: parsed.answerCapsule || parsed.answer_capsule || "",
      metaTitle: parsed.metaTitle || parsed.meta_title || "",
      slug: typeof parsed.slug === "string" ? parsed.slug : "",
      metaDescription: parsed.metaDescription || parsed.meta_description || "",
      primaryKeyword: parsed.primaryKeyword || parsed.primary_keyword || "",
      secondaryKeywords: Array.isArray(parsed.secondaryKeywords)
        ? parsed.secondaryKeywords
        : Array.isArray(parsed.secondary_keywords)
          ? parsed.secondary_keywords
          : [],
      quickFacts: parsed.quickFacts || parsed.quick_facts || {},
      schemaPayload: parsed.schemaPayload || parsed.schema_payload || {},
      honestLimitations: parsed.honestLimitations || parsed.honest_limitations || [],
      sensoryDescriptions: parsed.sensoryDescriptions || parsed.sensory_descriptions || [],
    };
  }

  private countWords(content: GeneratedLongFormContent): number {
    const allText = [
      content.introduction,
      content.whatToExpect,
      content.visitorTips,
      content.howToGetThere,
      ...(content.sections || []).map(s => `${s.heading} ${s.content}`),
      ...content.faqs.map(f => `${f.question} ${f.answer}`),
    ].join(" ");

    return allText.split(/\s+/).filter(w => w.length > 0).length;
  }
}

export function initializeWriterAgents(): void {
  for (const persona of WRITER_PERSONAS) {
    const agent = new WriterAgent(persona);
    AgentRegistry.register(agent);
  }
}

/**
 * Pick the best writer agent for a content category.
 */
export function getWriterForCategory(category: string): WriterAgent | null {
  const categoryMap: Record<string, string> = {
    news: "writer-reporter",
    breaking: "writer-reporter",
    report: "writer-reporter",
    analysis: "writer-analyst",
    market: "writer-analyst",
    business: "writer-analyst",
    economy: "writer-analyst",
    howto: "writer-howto",
    "how-to": "writer-howto",
    guide: "writer-howto",
    tutorial: "writer-howto",
    review: "writer-reviewer",
    comparison: "writer-reviewer",
    versus: "writer-reviewer",
    trend: "writer-trends",
    trends: "writer-trends",
    emerging: "writer-trends",
    story: "writer-storyteller",
    feature: "writer-storyteller",
    profile: "writer-storyteller",
    list: "writer-listicle",
    listicle: "writer-listicle",
    roundup: "writer-listicle",
    top: "writer-listicle",
    research: "writer-researcher",
    "deep-dive": "writer-researcher",
    investigation: "writer-researcher",
    explainer: "writer-researcher",
  };

  const lowerCategory = category.toLowerCase();
  for (const [keyword, writerId] of Object.entries(categoryMap)) {
    if (lowerCategory.includes(keyword)) {
      return AgentRegistry.get(writerId) as WriterAgent | null;
    }
  }

  return AgentRegistry.get("writer-reporter") as WriterAgent | null;
}
