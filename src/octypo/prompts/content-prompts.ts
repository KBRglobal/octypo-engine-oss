/**
 * Content Prompts - MASTER PROMPTs for content generation.
 * Domain-neutral: the configured content domain (CONTENT_DOMAIN) steers the
 * prompts; nothing here is tied to a specific vertical.
 */

import { SubjectData, AgentPersona } from "../types.js";
import { CONTENT_DOMAIN, LANGUAGE_RULE, SITE_NAME } from "../../config/domain.js";

const AI_BANNED_PHRASES = [
  "nestled",
  "hidden gem",
  "tapestry",
  "vibrant",
  "bustling",
  "whether you're",
  "there's something for everyone",
  "unforgettable",
  "breathtaking",
  "stunning",
  "amazing",
  "incredible",
  "delve into",
  "embark on",
  "unlock",
  "in conclusion",
  "ultimately",
  "at the end of the day",
  "it's worth noting",
  "interestingly",
  "it is important to note",
  "one cannot help but",
  "serves as a testament",
  "truly unique",
  "like no other",
  "world-class",
  "second to none",
  "state-of-the-art",
  "cutting-edge",
  "iconic",
  "legendary",
  "paradise",
  "oasis",
  "sanctuary",
  "mecca",
  "crown jewel",
  "jewel in the crown",
  "feast for the senses",
  "treat for the senses",
  "a treat for",
  "a feast for",
  "once-in-a-lifetime",
  "must-see",
  "absolutely stunning",
  "truly amazing",
];

/**
 * Long-form evergreen guide prompt (in-depth piece about a single subject).
 */

/**
 * How long an article should be.
 *
 * The 1,800–2,200 target was tuned for English, where it is a normal guide
 * length. The same word count in some languages is roughly twice the tokens and twice
 * the generation time, for an article most readers will not finish. Making it a
 * setting lets an install choose the length its readers actually want instead
 * of the length the first market happened to need.
 */
const TARGET_WORDS = Number(process.env.TARGET_WORD_COUNT) || 2000;
const WORD_FLOOR = Math.round(TARGET_WORDS * 0.9);
const WORD_CEILING = Math.round(TARGET_WORDS * 1.1);
const section = (share: number) => Math.round(TARGET_WORDS * share);

export function buildLongFormPrompt(subject: SubjectData, persona: AgentPersona): string {
  const currentYear = new Date().getFullYear();
  const subjectName = subject.title?.split(":")[0]?.trim() || "this subject";

  return `You are an expert content writer covering ${CONTENT_DOMAIN}. Your mission is to create
an authoritative, trustworthy in-depth guide that serves as the ultimate
research resource on this subject — NOT a sales page.

${LANGUAGE_RULE}

════════════════════════════════════════════════════════════════════════
## CRITICAL: WORD COUNT REQUIREMENTS (READ THIS FIRST)
════════════════════════════════════════════════════════════════════════

Your output MUST be ${WORD_FLOOR}-${WORD_CEILING} TOTAL words. This is NON-NEGOTIABLE.

SECTION MINIMUMS (you must hit or exceed these):
• Introduction: ${section(0.1)} words minimum (aim for ${section(0.125)})
• whatToExpect (key facts & deep dive): ${section(0.2)} words minimum (aim for ${section(0.25)})
• visitorTips (practical advice): ${section(0.15)} words minimum (aim for ${section(0.2)})
• howToGetThere (how to engage / get started): ${section(0.1)} words minimum (aim for ${section(0.125)})
• Each FAQ answer: 50 words minimum × 10 questions = 500 words
• TOTAL: 1,800+ words

COUNTING METHOD:
- Write detailed, substantive paragraphs for each section
- Each section should have 3-5 full paragraphs, not just bullet lists
- FAQ answers should be 2-3 sentences each, not one-liners
- If your total is below 1,800 words, EXPAND each section before outputting

═══════════════════════════════════════════════════════════════════════

## SUBJECT DATA

Name: ${subject.title}
Topic: ${subject.topicName || "general"}
Category: ${subject.primaryCategory || subject.category || "General"}
Domain: ${CONTENT_DOMAIN}

Source Description (rewrite completely, never copy):
${subject.description || "No source material provided"}

═══════════════════════════════════════════════════════════════════════

## WRITING PHILOSOPHY: TRUSTED ADVISOR, NOT SALESPERSON

YOU ARE:
- A knowledgeable expert with years of hands-on experience in this field
- Honest about limitations and "not worth it" scenarios
- Focused on practical intelligence over generic praise
- Data-driven: cite specific numbers, timeframes, measurements

YOU ARE NOT:
- A marketer trying to sell anything
- A generic blog recycling encyclopedia facts
- Afraid to say "skip this if..." or "honestly, it's overrated for..."

═══════════════════════════════════════════════════════════════════════

## SECTION-BY-SECTION WRITING INSTRUCTIONS

### SECTION 1: INTRODUCTION (200-250 words)
GOAL: Answer "Why should I care about this subject?"
1. Opening hook (1-2 sentences): what makes this subject significant — use specific superlatives ONLY if true
2. Core substance (2-3 sentences): what the reader will actually learn or gain — be hyper-specific
3. Honest context (2-3 sentences): "Here's the thing..." — address the elephant in the room: trade-offs, hype vs reality
4. Effort/logistics snapshot (1 sentence): time, cost tier, or learning curve at a glance

WRITING RULES:
- Lead with WHY (significance), not WHAT (basic facts)
- Use conversational markers: "Here's the thing", "The reality is", "But"
- Include 1 limitation/honest warning
- No generic hype phrases

FACTUAL INTEGRITY (ABSOLUTE — violating this fails the article):
- NEVER invent statistics, percentages, study results, survey figures, or "experts say" claims.
- Only state a number, percentage, or research finding if it appears in the Source Material above OR is a genuinely well-known, verifiable fact. If you cite a study/body/law, it must be real and nameable — and prefer to point the reader to it rather than paraphrase a figure you are unsure of.
- When you don't have a verified number, write qualitatively ("often", "in many cases", "a common cause") — do NOT fabricate precision.
- No fake authorities, no made-up institutions, no invented "according to X" attributions.

### SECTION 2: whatToExpect — KEY FACTS & DEEP DIVE (400-500 words)
GOAL: Paint a vivid, concrete picture of the subject
A) THE BASICS (50-75 words): what it is, where it fits, first impressions
B) THE DETAILS (200-250 words): walk through it logically, step by step
   Use CONCRETE WRITING RULES: specific facts and observable details (numbers only if verifiable / from the source)
C) HIGHLIGHT MOMENTS (100-150 words): the 2-3 things people remember most — be specific about why
D) HONEST LIMITATIONS (50-75 words): what might disappoint — costs, complexity, caveats

### SECTION 3: visitorTips — PRACTICAL ADVICE (300-400 words)
GOAL: Insider knowledge that saves time, money, or frustration
A) TIMING ADVICE: when to act / start / buy (with reasoning), and what to avoid
B) INSIDER ADVICE: 5-7 non-obvious tips most people don't know; common mistakes to avoid
C) MONEY-SAVING ADVICE: how to get more for less WITHOUT citing exact prices ("look for bundle deals", "early commitment usually offers 10-15% savings")

### SECTION 4: howToGetThere — HOW TO ENGAGE / GET STARTED (200-250 words)
GOAL: Concrete first steps, alternatives and access paths
- The main route in (with specifics)
- Alternative options and when to choose them
- What to prepare beforehand

### SECTION 5: FAQ (8-10 questions, 50-80 words per answer)
ANSWER FORMAT (Answer Capsule Method):
1. Direct answer in first sentence
2. Supporting details (2-3 sentences)
3. End with action step or pro tip

REQUIRED QUESTION TYPES (adapt wording to the subject):
1. How much does it cost? (guidance only, no exact prices)
2. Is it worth it?
3. What's the best time to start / use / engage with it?
4. How long does it take?
5. Can I do it without prior preparation?
6. Who is it suitable for?
7. What do I need beforehand?
8. What are the main alternatives?
+ 2 unique questions specific to this subject (What/How/Why/When/Where format)

═══════════════════════════════════════════════════════════════════════

## PRICING POLICY (CRITICAL)

NEVER include specific prices in the content.
INSTEAD, use guidance language:
"Paid product — multiple pricing tiers available"
"Committing early typically offers 10-15% savings"

═══════════════════════════════════════════════════════════════════════

## TONE & STYLE GUIDELINES

VOICE: Knowledgeable friend in the field (informative + conversational)

MANDATORY STYLE REQUIREMENTS (QUALITY CHECKS WILL FAIL WITHOUT THESE):

1. 8+ CONTRACTIONS throughout the text (not just in FAQs):
   REQUIRED: "you'll", "it's", "don't", "won't", "can't", "we'll", "you're", "that's", "here's", "there's"

2. 3+ CONVERSATIONAL PHRASES naturally integrated:
   USE THESE EXACT PHRASES: "Here's the thing", "The reality is", "But honestly", "Worth noting", "To be fair"

3. 1-3 HONEST LIMITATIONS in the honestLimitations JSON field:
   Format: "Skip this if you..." or "Be aware that..."

4. 5+ SPECIFIC NUMBERS with units:
   Examples: "15 minutes", "40% less", "3 hours", "version 2.0", "500 users"

USE:
- Conversational bridges: "Here's the thing", "The reality is", "But honestly"
- Contractions (MINIMUM 8 uses)
- Direct address: "you", "your" (at least 5 times)
- Active voice: "You'll see" not "Can be seen"
- Specific numbers

AVOID:
- Marketing fluff and vague claims ("very popular", "many people")
- Passive voice
- These banned phrases: ${AI_BANNED_PHRASES.slice(0, 15).join(", ")}

═══════════════════════════════════════════════════════════════════════

## OUTPUT FORMAT - JSON ONLY

Return ONLY valid JSON with this exact structure:

{
  "introduction": "Your 200-250 word introduction here. Begin with the answerCapsule content then expand...",
  "whatToExpect": "Your 400-500 word deep-dive with concrete details...",
  "visitorTips": "Your 300-400 word practical advice with TIMING, INSIDER, and MONEY-SAVING parts...",
  "howToGetThere": "Your 200-250 word getting-started section with main route and alternatives...",
  "faqs": [
    {"question": "How much does ${subjectName} cost?", "answer": "50-80 word answer with guidance, no specific prices. Open with direct answer."},
    {"question": "Is ${subjectName} worth it in ${currentYear}?", "answer": "50-80 word honest answer starting with yes/no/it depends and reasoning."},
    {"question": "What is the best way to start with ${subjectName}?", "answer": "50-80 word answer with specifics."},
    {"question": "How long does ${subjectName} take?", "answer": "50-80 word answer with a breakdown."},
    {"question": "Do I need preparation for ${subjectName}?", "answer": "50-80 word answer with specific advice."},
    {"question": "Who is ${subjectName} suitable for?", "answer": "50-80 word answer with specifics."},
    {"question": "What do I need before starting with ${subjectName}?", "answer": "50-80 word practical answer."},
    {"question": "What are alternatives to ${subjectName}?", "answer": "50-80 word answer naming concrete alternatives."},
    {"question": "Unique question specific to this subject - use What/How/Why/When/Where format", "answer": "50-80 word answer"},
    {"question": "Another unique question specific to this subject - use What/How/Why/When/Where format", "answer": "50-80 word answer"}
  ],
  "answerCapsule": "2-3 sentence direct answer (max 60 words) to: What is ${subjectName} and why does it matter? Include one concrete fact. Written in second person.",
  "metaTitle": "${subjectName} ${currentYear}: Complete Guide | ${SITE_NAME}",
  "metaDescription": "150-160 character description of ${subjectName} with what it is, key fact, why it matters, and CTA. Include primary keyword.",
  "primaryKeyword": "The single main keyword phrase this article targets (e.g. '${subjectName} guide')",
  "secondaryKeywords": [
    "${subjectName} explained",
    "${subjectName} cost",
    "${subjectName} tips",
    "how to use ${subjectName}",
    "${subjectName} ${currentYear}",
    "${subjectName} alternatives",
    "best time to start ${subjectName}"
  ],
  "quickFacts": {
    "price": "Pricing guidance (e.g. 'Paid - multiple tiers; commit early for savings')",
    "hours": "Availability or time commitment if known",
    "location": "Where it lives / applies (platform, market, region)",
    "duration": "Recommended time investment",
    "bestTime": "Best time to engage, with reasoning",
    "tip": "Single best insider tip for newcomers"
  },
  "honestLimitations": [
    "First honest limitation (effort, requirements, learning curve)",
    "Second honest limitation (costs or value concerns)",
    "Third honest limitation (access, compatibility or timing)"
  ],
  "sensoryDescriptions": [
    "Specific concrete detail from whatToExpect",
    "Another specific concrete detail",
    "A third specific concrete detail"
  ],
  "schemaPayload": {
    "@context": "https://schema.org",
    "@type": "Article",
    "name": "${subject.title}",
    "description": "Use answerCapsule text here"
  }
}

═══════════════════════════════════════════════════════════════════════

## FINAL CHECKLIST

Before outputting, verify:
- [ ] ${WORD_FLOOR}-${WORD_CEILING} words total across all sections
- [ ] answerCapsule is 2-3 sentences, max 60 words, starts with direct answer
- [ ] At least 3 concrete specific details
- [ ] At least 3 honest limitations mentioned
- [ ] 10+ specific numbers/measurements cited
- [ ] 10 FAQ questions with substantial answers using What/How/Why/When/Where formats
- [ ] NO specific prices mentioned (use guidance language)
- [ ] metaTitle is 50-60 characters and contains primaryKeyword
- [ ] metaDescription is 150-160 characters and contains CTA
- [ ] primaryKeyword is set (single main keyword phrase)
- [ ] secondaryKeywords has 5-8 related LSI keywords
- [ ] quickFacts object is complete with all 6 fields
- [ ] Conversational tone with "you/your" throughout
- [ ] No banned phrases used

OUTPUT: Valid JSON only. No markdown code blocks. No text before or after the JSON.`;
}

export function buildCorrectionPrompt(
  originalContent: any,
  issues: Array<{ section: string; message: string; fix: string }>
): string {
  return `Fix these specific issues in the content:

${issues
  .map(
    (issue, i) => `${i + 1}. [${issue.section}] ${issue.message}
   → ${issue.fix}`
  )
  .join("\n\n")}

ORIGINAL CONTENT:
${JSON.stringify(originalContent, null, 2)}

INSTRUCTIONS:
1. Fix ONLY the listed issues
2. Keep everything else exactly the same
3. Return the complete corrected JSON
4. Ensure valid JSON formatting

OUTPUT: Valid JSON only.`;
}

export function buildNewsArticlePrompt(subject: SubjectData, persona: AgentPersona): string {
  const currentYear = new Date().getFullYear();
  const topic = subject.title || "this topic";
  const region = subject.topicName || "";

  return `You are writing a NEWS ARTICLE / ANALYSIS PIECE about ${CONTENT_DOMAIN}, NOT a marketing page.
This is journalism, not promotion. Write with authority, cite real entities,
and provide substantive analysis.

${LANGUAGE_RULE}

═══════════════════════════════════════════════════════════════════════
## CONTENT TYPE: NEWS / ANALYSIS ARTICLE
═══════════════════════════════════════════════════════════════════════

Topic: ${topic}
${region ? `Topic area: ${region}` : ""}
Category: ${subject.primaryCategory || subject.category || "News"}
Domain: ${CONTENT_DOMAIN}
Year: ${currentYear}

Source Material (rewrite completely, never copy):
${subject.description || "No source material"}

═══════════════════════════════════════════════════════════════════════
## STRICT RULES — WHAT THIS ARTICLE IS NOT
═══════════════════════════════════════════════════════════════════════

NEVER INCLUDE:
- "How to Get There" style logistics sections
- "What to Expect" physical walkthrough sections
- Pricing guidance or purchase instructions
- "strategic intelligence you need"
- "directly improves your decisions"
- "saves X%" without citing a source
- "worth your time" or similar marketing fluff
- Any duplicate content — each section MUST be unique
- These banned phrases: ${AI_BANNED_PHRASES.slice(0, 15).join(", ")}

FACTUAL INTEGRITY (ABSOLUTE — violating this fails the article):
- NEVER invent statistics, percentages, study results, survey numbers, or "according to X" attributions.
- Use a number, percentage, or research finding ONLY if it appears in the Source Material OR is a genuinely well-known, verifiable fact with a real, nameable source. If you reference a study, law, or institution, it must be real — and if you're not certain of an exact figure, point the reader to the source instead of stating a number you cannot verify.
- When you lack a verified figure, write qualitatively ("often", "a frequent cause", "many tenants") rather than fabricating precision.
- Fabricated authorities, invented institutions, or made-up data are an automatic failure.

═══════════════════════════════════════════════════════════════════════
## ARTICLE STRUCTURE
═══════════════════════════════════════════════════════════════════════

TOTAL WORD COUNT: 1,200–1,800 words. NON-NEGOTIABLE.

### INTRODUCTION (150–220 words ONLY)
- Open with a clear, specific thesis — backed by data ONLY if it comes from the
  Source Material or is verifiable. Do NOT manufacture statistics to sound authoritative.
- NO marketing language, NO fluff
- State a clear thesis in the last sentence
- Cite a source only if it is real and named (and present in the source or
  genuinely well-known); never invent "according to X" attributions

### SECTIONS (exactly 3 sections)
Each section MUST have:
- An H2 heading that is SEO intent-based:
  "Why X", "How X Works", "Best X vs Y", "What X Means for Y",
  "The Real Economics Behind X"
- NOT generic headings like "Overview" or "Background"
- 300–600 words of substantive analysis
- Real entities where relevant: brand names, company names, research firms,
  industry bodies, named individuals with titles — but ONLY ones that are real
- Concrete specifics are good, but numbers/percentages/data points ONLY when
  verifiable or drawn from the source — never invented for effect

### FAQs (4–6 questions)
- Questions must be SPECIFIC to the article topic
- NO generic questions like "How much does it cost?" or "Is it worth it?"
- Direct answer in the FIRST sentence of each answer
- 3–5 sentences max per answer
- NO marketing language, NO repetition of the question in the answer

═══════════════════════════════════════════════════════════════════════
## TONE & STYLE
═══════════════════════════════════════════════════════════════════════

VOICE: Informed journalist / industry analyst
- Use contractions naturally (you'll, it's, don't)
- Active voice preferred
- Cite real entities: "According to Gartner...", "The company's CEO noted..."
- Include opposing viewpoints where relevant
- NO conversational filler like "Here's the thing" or "But honestly"
  (this is journalism, not a blog post)

═══════════════════════════════════════════════════════════════════════
## ANTI-AI-DETECTION WRITING RULES (CRITICAL)
═══════════════════════════════════════════════════════════════════════

AI detection tools (Originality.ai, GPTZero, Ahrefs) flag content that has uniform
sentence length, predictable paragraph patterns, or transition-word chains.

YOU MUST:

1. VARY SENTENCE LENGTH DRAMATICALLY within each section:
   Short punchy sentences: 4-8 words. Like this one.
   Medium sentences providing context: 12-18 words feels natural and readable.
   Long complex sentences with subordinate clauses, specific data, and parenthetical
   detail that gives real texture to your argument can run 30-40 words without issue.

2. NEVER start 2+ consecutive sentences with the same word or sentence structure.
   Vary openers: gerunds ("Building a model..."), time markers ("By late 2025..."),
   concessions ("To be fair..."), numbers ("Three factors explain...").

3. INCLUDE HEDGING AND OPINION: Journalists have views.
   Use: "Arguably...", "Some analysts dispute this, but...",
   "Whether that holds in practice remains to be seen.",
   "The evidence, such as it is, suggests..."

4. STRUCTURAL ASYMMETRY: Each section must differ in structure.
   Section 1: lead with quote or stat, then narrative paragraphs.
   Section 2: start with historical context, end with a question.
   Section 3: shorter and punchier — include a 2-sentence paragraph.

5. USE EM DASHES AND PARENTHETICALS to break up thoughts:
   "The launch—announced with little fanfare last December—drew immediate attention."
   "Revenue figures (up 23% year-over-year) tell only part of the story."

6. BANNED TRANSITION WORDS at paragraph openings:
   Never: Furthermore, Additionally, Moreover, In conclusion, Ultimately, Subsequently, Nevertheless
   Instead: start with the substance, or use "But", "And", "Still", "Yet", "Even so"

7. INCLUDE ONE SPECIFIC SCENE OR ANECDOTE grounded in a real detail:
   Example: "When sign-ups opened in January, the waiting list hit 40,000 within 72 hours."

═══════════════════════════════════════════════════════════════════════
## OUTPUT FORMAT — JSON ONLY
═══════════════════════════════════════════════════════════════════════

Return ONLY valid JSON with this exact structure:

{
  "introduction": "150–220 words. Bold claim + 2–3 real data points. Clear thesis. No marketing.",
  "sections": [
    {
      "heading": "SEO Intent H2 (e.g. 'Why X Is Shifting in ${currentYear}', 'The Real Economics Behind X')",
      "content": "400–600 words of substantive analysis with real entities"
    },
    {
      "heading": "Second SEO Intent H2",
      "content": "400–600 words"
    },
    {
      "heading": "Third SEO Intent H2",
      "content": "300–400 words"
    }
  ],
  "faqs": [
    {
      "question": "Specific question about the topic",
      "answer": "Direct answer first sentence. 2–3 supporting sentences. No marketing."
    }
  ],
  "metaTitle": "50-60 chars. Format: [Topic] [Year]: [Hook] | ${SITE_NAME}. Must include primary keyword.",
  "metaDescription": "150-160 chars. Include primary keyword, key fact, and clear CTA. No generic phrases.",
  "answerCapsule": "40-60 word direct answer to the main question of the article. Start with the answer, not 'It depends'. Second person voice."
}

═══════════════════════════════════════════════════════════════════════
## FINAL CHECKLIST
═══════════════════════════════════════════════════════════════════════

Before outputting, verify:
- [ ] 1,200–1,800 words total
- [ ] Introduction is 150–220 words (NOT more)
- [ ] Exactly 3 sections with SEO intent-based H2 headings
- [ ] Each section has real entities (brands, firms, people)
- [ ] 4–6 FAQs, direct answer in first sentence, 3–5 sentences each
- [ ] NO logistics/marketing sections
- [ ] NO marketing fluff or banned phrases
- [ ] NO duplicate content between sections
- [ ] Sentence lengths vary dramatically within each section
- [ ] NO two consecutive paragraphs start with the same word
- [ ] At least one em-dash (—) used in the article
- [ ] At least one hedging phrase ("arguably", "some dispute", "remains to be seen")
- [ ] NO transition words (Furthermore, Additionally, Moreover) at paragraph openings
- [ ] metaTitle under 65 characters
- [ ] metaDescription under 150 characters
- [ ] answerCapsule is 40–60 words

OUTPUT: Valid JSON only. No markdown code blocks. No text before or after the JSON.`;
}

export { AI_BANNED_PHRASES };
