/**
 * Gate 2: Article Approver
 * Reviews written articles and decides: approve, revise, or reject
 *
 * Responsibilities:
 * - Quality assessment
 * - Issue identification
 * - Correction instructions for revision
 * - Final approval for publication
 */

import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import {
  ArticleApprovalInput,
  ArticleApprovalResult,
  QualityIssue,
  CorrectionInstruction,
  ApprovalDecision,
  GatekeeperConfig,
  DEFAULT_GATEKEEPER_CONFIG,
} from "./types.js";
import { logger } from "../../lib/logger.js";
import { CONTENT_DOMAIN, SITE_NAME } from "../../config/domain.js";
import { todayContextBlock } from "../../lib/today.js";
import { publishFixRounds } from "../publish-policy.js";
import {
  applyQualityGate,
  loadQualityGateConfig,
  qualityCorrections,
  qualityEditorNote,
  qualityInputFromApproval,
  qualityIssues,
  scoreArticle,
  type ArticleQualityContext,
  type ArticleQualityReport,
  type QualityGateConfig,
} from "../../quality/index.js";

const GATE2_SYSTEM_PROMPT = `You are a senior content editor for ${SITE_NAME}, a premium publication covering ${CONTENT_DOMAIN}.
Your job is to review AI-generated articles and decide if they're ready for publication.
You evaluate both traditional SEO quality AND Answer Engine Optimization (AEO) quality.

AEO means the content is structured so AI systems (ChatGPT, Perplexity, Google SGE) can easily
cite it as a source when answering reader questions.

## Quality Standards

### Must-Have (Critical - will reject if missing)
- Accurate facts (figures, dates, names, measurable claims)
- No AI-sounding cliches: "nestled", "vibrant tapestry", "embark on a journey", "hidden gem", "bustling", "breathtaking"
- Clear, natural language written in second person ("you can", "you'll find")
- Proper structure that matches the reader's task; FAQ only when research found useful unanswered questions
- Actionable, concrete information for readers; numbers, timeframes, and ranges only when verified

### SEO Must-Have (Major - will require revision if missing)
- Meta title: 50-60 characters, contains primary keyword
- Meta description: 150-160 characters, contains CTA
- Headings framed as questions or using "What", "How", "Why", "When", "Where" formats
- A direct intent answer: cost queries need a verified range or a clear scope-and-quote mechanism; timeline queries need a bounded duration plus conditions

### AEO Must-Have (Major - will require revision if missing)
- Answer Capsule: First 2-3 sentences directly answer the article's main question
- Answer Capsule is concise (max 70 words), direct, scoped, and does not invent precision
- FAQ questions are included only when observed in research and not already answered clearly
- Each included FAQ answer opens with a direct, self-contained answer
- No vague language, padding, copied boilerplate, or unsupported certainty

### Nice-to-Have (Minor - note but don't reject)
- Cultural context
- Personal recommendations
- Alternative options
- Seasonal considerations

## AEO Scoring Rubric (0-100)
Score the AEO quality separately using these criteria:
- Answer Capsule present and direct (0-25 points): 25=perfect 2-3 sentence direct answer; 0=missing or vague
- Intent coverage and useful answer units (0-25 points): 25=the promised task is fully answered; 0=the title promise is avoided
- Evidence quality (0-20 points): 20=consequential claims are verified and calibrated; 0=unsupported or invented claims
- Second-person voice (0-15 points): 15=consistent "you can/you'll" throughout; 0=passive/third-person
- No AI cliches (0-15 points): 15=zero banned phrases; 0=multiple cliches found

## Decision Guidelines

**APPROVE** if:
- Quality score >= 72
- No critical issues
- AEO score >= 60
- Minor issues can be accepted

**REVISE** if:
- Quality score 35-71, OR
- AEO score < 60 (article cannot be cited by AI answer engines)
- Fixable issues identified
- Worth the revision effort
- Max 2 revision rounds

**REJECT** if:
- Quality score < 35
- Fundamental problems (wrong topic, completely off-brand, factually broken)
- Not worth fixing

## Revision Instructions
When requesting revision, provide SPECIFIC, ACTIONABLE corrections:
- BAD: "Make it more engaging"
- GOOD: "Add a sensory description in paragraph 2. Instead of 'The market is busy', describe the sounds of vendors calling and the smell of spices."
- BAD: "Improve AEO"
- GOOD: "The answer capsule says 'X is a popular tool.' Rewrite it as: 'X is a [specific type] that [key fact]. You can use it for [concrete use case]. [One practical tip].'"

Be demanding but constructive. We want excellence, not perfection paralysis.

Respond in JSON format only.`;

const GATE2_REVIEW_PROMPT = `Review this article for publication:

**Title:** {title}
**Meta Title:** {metaTitle} (target: 50-60 characters)
**Meta Description:** {metaDescription} (target: 150-160 characters)

**Summary/Answer Capsule:**
{summary}

**Word Count:** {wordCount}
**Writer:** {writerId}
**Previous Quality Score:** {quality108Score}
**Revision #:** {revisionCount}

**Article Content:**
{content}

---

Evaluate the article on BOTH overall quality AND AEO (Answer Engine Optimization) quality.

AEO CHECKLIST - evaluate each item:
1. Does the article open with a direct 2-3 sentence answer capsule? (Yes/No)
2. Does the answer capsule satisfy the query's intent with verified specificity and necessary conditions? (Yes/No)
3. Are FAQs included only when they add observed, non-duplicative reader value? (Yes/No)
4. Do any included FAQ answers open with a direct self-contained answer? (Yes/No)
5. Are consequential claims supported without invented precision? (Yes/No)
6. Is second-person voice ("you can", "you'll find") used consistently? (Yes/No)
7. Are AI cliches absent ("nestled", "vibrant", "embark", "breathtaking")? (Yes/No)

Score the AEO quality 0-100 using the rubric:
- Answer Capsule present and direct: 0-25 points
- Intent coverage and useful answer units: 0-25 points
- Evidence quality: 0-20 points
- Second-person voice consistency: 0-15 points
- Zero AI cliches: 0-15 points

Respond with this exact JSON structure:
{
  "overallQuality": <0-100>,
  "aeoScore": <0-100>,
  "aeoChecklist": {
    "hasAnswerCapsule": <true|false>,
    "answerCapsuleHasFact": <true|false>,
    "hasFivePlusFaqs": <true|false>,
    "faqAnswersAreDirect": <true|false>,
    "concreteFactsInEverySection": <true|false>,
    "secondPersonVoice": <true|false>,
    "noAiCliches": <true|false>
  },
  "decision": "approve" | "revise" | "reject",
  "issues": [
    {
      "category": "accuracy" | "style" | "seo" | "aeo" | "structure" | "engagement" | "sensitivity",
      "severity": "critical" | "major" | "minor",
      "description": "<what's wrong>",
      "location": "<where in the article>",
      "suggestion": "<how to fix>"
    }
  ],
  "corrections": [
    {
      "section": "<which section to fix>",
      "issue": "<the problem>",
      "instruction": "<specific action to take>",
      "priority": "must_fix" | "should_fix" | "nice_to_have"
    }
  ],
  "publicationReady": true | false,
  "reasoning": "<2-3 sentences explaining your decision, including AEO assessment>",
  "editorNotes": "<notes for the record>"
}

Be thorough but fair. If it's good enough to publish (quality >= 72 AND aeoScore >= 60), approve it. Don't nitpick minor style issues.`;

/** Gate 2 also reports the deterministic breakdown, so an editor sees WHY. */
export type Gate2Result = ArticleApprovalResult & { qualityReport?: ArticleQualityReport };

/**
 * The reviewer quotes the article, and some scripts carry a plain `"` inside a
 * word (acronyms, abbreviations) that the model leaves unescaped, which breaks
 * the JSON and strands the article in review. A quote between two letters is
 * never a JSON delimiter, so it is escaped and stays the character it was.
 */
export function repairInWordQuotes(text: string): string {
  return text.replace(/(?<=\p{L})"(?=\p{L})/gu, '\\"');
}

export class Gate2Approver {
  private readonly config: GatekeeperConfig;
  private readonly qualityConfig: Partial<QualityGateConfig>;

  constructor(
    config: Partial<GatekeeperConfig> = {},
    qualityConfig: Partial<QualityGateConfig> = {}
  ) {
    this.config = { ...DEFAULT_GATEKEEPER_CONFIG, ...config };
    this.qualityConfig = qualityConfig;
  }

  async review(
    input: ArticleApprovalInput,
    revisionCount: number = 0,
    qualityContext: ArticleQualityContext = {}
  ): Promise<Gate2Result> {
    const startTime = Date.now();

    logger.info(
      { title: input.title.substring(0, 50), revisionCount },
      "[Gate2] Reviewing article"
    );

    try {
      // Build the review prompt
      const prompt = this.buildPrompt(input, revisionCount);

      // Call LLM for review
      const response = await this.callLLM(prompt);

      // Parse and validate response
      const review = this.parseResponse(response);

      // Override decision based on config thresholds
      const llmDecision = this.finalizeDecision(review, revisionCount);

      // The LLM's verdict is advisory; the deterministic scorer has the veto.
      // An LLM reviewer cannot be relied on to notice an invented statistic in
      // prose it also finds well written, and it will not give the same answer
      // twice, so what actually reaches a customer's site is decided by a
      // reproducible check a human can re-run and argue with.
      const gate = this.runQualityGate(input, revisionCount, llmDecision, qualityContext);

      // Build revision prompt if needed
      const corrections = [...(review.corrections ?? []), ...gate.corrections];
      let revisionPrompt: string | undefined;
      if (gate.decision === "revise" && corrections.length > 0) {
        revisionPrompt = this.buildRevisionPrompt(input, corrections);
      }

      const editorNotes = [review.editorNotes || "", gate.editorNote].filter(Boolean).join("\n\n");

      const result: Gate2Result = {
        contentId: input.contentId,
        decision: gate.decision,
        overallQuality: review.overallQuality,
        aeoScore: review.aeoScore,
        aeoChecklist: review.aeoChecklist,
        issues: [...(review.issues || []), ...gate.issues],
        corrections: gate.decision === "revise" ? corrections : undefined,
        revisionPrompt,
        maxRevisions: this.config.maxRevisionsAllowed,
        publicationReady: gate.decision === "approve",
        reasoning: gate.reasoning ? `${review.reasoning} ${gate.reasoning}` : review.reasoning,
        editorNotes,
        evaluatedAt: new Date(),
        revisionCount,
        processingTimeMs: Date.now() - startTime,
        qualityReport: gate.report,
      };

      logger.info(
        {
          quality: review.overallQuality,
          aeoScore: review.aeoScore,
          qualityGateScore: gate.report?.score,
          decision: gate.decision,
        },
        "[Gate2] Review complete"
      );

      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "[Gate2] Review failed"
      );
      throw error;
    }
  }

  /**
   * Scores the article deterministically and decides whether that score is
   * allowed to overrule an "approve". Never turns a hold into a publish: the
   * gate can only ever be more conservative than the reviewer it follows.
   */
  private runQualityGate(
    input: ArticleApprovalInput,
    revisionCount: number,
    llmDecision: ApprovalDecision,
    context: ArticleQualityContext
  ): {
    decision: ApprovalDecision;
    report?: ArticleQualityReport;
    issues: QualityIssue[];
    corrections: CorrectionInstruction[];
    editorNote: string;
    reasoning: string;
  } {
    const gateConfig = loadQualityGateConfig(this.qualityConfig);
    if (!gateConfig.enabled) {
      return { decision: llmDecision, issues: [], corrections: [], editorNote: "", reasoning: "" };
    }

    const report = scoreArticle(qualityInputFromApproval(input, context), this.qualityConfig);
    // The gate's findings are mechanical (lengths, links, keyword placement),
    // so an article the reviewer approved gets extra editor rounds for them
    // before it is rejected; one round was not enough and approved articles
    // were rejected one after another.
    const decision = applyQualityGate(
      llmDecision,
      report,
      revisionCount,
      this.config.maxRevisionsAllowed + (llmDecision === "approve" ? publishFixRounds() : 0)
    );

    if (decision === llmDecision) {
      return { decision, report, issues: [], corrections: [], editorNote: "", reasoning: "" };
    }

    logger.warn(
      {
        contentId: input.contentId,
        qualityGateScore: report.score,
        threshold: report.threshold,
        blocking: report.blockingFailures,
        decision,
      },
      "[Gate2] Deterministic quality gate held an article the reviewer approved"
    );

    return {
      decision,
      report,
      issues: qualityIssues(report),
      corrections: qualityCorrections(report),
      editorNote: qualityEditorNote(report),
      reasoning: `Held by the deterministic quality gate: ${report.summary}`,
    };
  }

  private buildPrompt(input: ArticleApprovalInput, revisionCount: number): string {
    // Extract text content from blocks
    const contentText = this.extractContentText(input.blocks);

    return GATE2_REVIEW_PROMPT.replace("{title}", input.title)
      .replace("{metaTitle}", input.metaTitle || input.title)
      .replace("{metaDescription}", input.metaDescription || "")
      .replace("{summary}", input.answerCapsule || input.summary || "")
      .replace("{wordCount}", String(input.wordCount || 0))
      .replace("{writerId}", input.writerId || "Unknown")
      .replace("{quality108Score}", String(input.quality108Score || "N/A"))
      .replace("{revisionCount}", String(revisionCount))
      .replace("{content}", contentText);
  }

  private extractContentText(blocks: any[]): string {
    if (!blocks || !Array.isArray(blocks)) {
      return "No content available";
    }

    const textParts: string[] = [];

    for (const block of blocks) {
      const extracted = this.extractBlockText(block);
      if (extracted) textParts.push(extracted);
    }

    // Limit content length for LLM context
    const fullText = textParts.join("\n\n");
    if (fullText.length > 15000) {
      return fullText.substring(0, 15000) + "\n\n[Content truncated for review...]";
    }

    return fullText;
  }

  private extractBlockText(block: any): string | null {
    switch (block.type) {
      case "paragraph":
        return block.data?.text || null;
      case "text":
        return block.data?.content || null;
      case "heading":
        return block.data?.text ? `\n## ${block.data.text}\n` : null;
      case "list":
        return block.data?.items
          ? block.data.items.map((item: string) => `- ${item}`).join("\n")
          : null;
      case "faq":
        return block.data?.items
          ? block.data.items.map((faq: any) => `Q: ${faq.question}\nA: ${faq.answer}\n`).join("")
          : null;
      default:
        return null;
    }
  }

  private async callLLM(prompt: string): Promise<string> {
    const preferredProviders = [this.config.preferredEngine, ...this.config.fallbackEngines];
    const triedEngines = new Set<string>();
    const MAX_RETRIES = 3;
    const timeoutMs = this.config.timeoutMs || 120000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Get next engine using round-robin from preferred providers
      const engine =
        preferFastForReview(triedEngines) ||
        EngineRegistry.getNextByProviderPreference(preferredProviders, triedEngines) ||
        EngineRegistry.getNextFromQueue(triedEngines);

      if (!engine) {
        throw new Error("No available engine for Gate2 review");
      }

      triedEngines.add(engine.id);

      if (!engine.isHealthy) {
        continue;
      }

      try {
        // Wrap with timeout to prevent Gate2 reviews from hanging indefinitely
        // The reviewer once rejected a real story as "a fictional future
        // event in 2026" — it had no clock. Now it does, on every call.
        const response = await Promise.race([
          generateWithEngine(engine, `${GATE2_SYSTEM_PROMPT}\n\n${todayContextBlock()}`, prompt),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Gate2 LLM timeout after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
        EngineRegistry.reportSuccess(engine.id);
        return response;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        EngineRegistry.reportError(engine.id, errorMsg);
        logger.warn({ engineId: engine.id, error: errorMsg }, "[Gate2] Engine failed, trying next");
        continue;
      }
    }

    throw new Error("All LLM engines failed for Gate2 review");
  }

  /**
   * Pull the verdict object out of whatever the model actually returned.
   *
   * A greedy `{...}` match spans from the first brace to the *last* one in the
   * whole response, so a model that adds a second object — a worked example, a
   * trailing note — produces a string that is two objects glued together and
   * cannot parse. Scanning for the first balanced object instead is what makes
   * the difference between a review and a failed job, and a failed Gate 2 means
   * an article that never publishes.
   *
   * Braces inside strings do not count, and a `\"` inside a string is not a
   * closing quote: an article quoting a measurement hits both.
   */
  private extractFirstObject(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i];

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  private parseResponse(raw: string): any {
    try {
      return this.parseCandidates(raw);
    } catch {
      return this.parseCandidates(repairInWordQuotes(raw));
    }
  }

  private parseCandidates(response: string): any {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
    const candidates = [
      fenced ? this.extractFirstObject(fenced[1]) : null,
      this.extractFirstObject(response),
      fenced ? fenced[1].trim() : null,
      response.trim(),
    ].filter((c): c is string => Boolean(c));

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // Try the next shape.
      }
    }

    // Without the response there is nothing to debug: the same article fails
    // the same way every retry and the log says only that it failed.
    logger.error(
      { head: response.slice(0, 600), length: response.length },
      "[Gate2] Failed to parse LLM response"
    );
    throw new Error("Failed to parse Gate2 review response");
  }

  private finalizeDecision(review: any, revisionCount: number): ApprovalDecision {
    const quality = review.overallQuality || 0;
    // AEO score defaults to 50 if LLM did not return it (treat as partial AEO compliance)
    const aeoScore: number = typeof review.aeoScore === "number" ? review.aeoScore : 50;

    // Auto-reject if quality is truly broken
    if (quality < this.config.autoRejectBelowQuality) {
      return "reject";
    }

    // After max revisions: approve floor-quality content instead of rejecting
    // AI content that's been revised 2+ times and scores >= 55 is good enough to publish
    if (revisionCount >= this.config.maxRevisionsAllowed) {
      if (quality >= 55) {
        logger.info(
          { revisionCount, quality, aeoScore },
          "[Gate2] Max revisions reached - approving floor-quality content"
        );
        return "approve";
      }
      logger.warn(
        { revisionCount, quality, aeoScore },
        "[Gate2] Max revisions reached, quality too low, rejecting"
      );
      return "reject";
    }

    // Approve if quality AND AEO both meet thresholds
    if (quality >= this.config.minQualityForApproval) {
      // Check for critical issues
      const criticalIssues = (review.issues || []).filter(
        (i: QualityIssue) => i.severity === "critical"
      );
      if (criticalIssues.length > 0) {
        // Has critical issues, needs revision even with good quality score
        return "revise";
      }
      // If AEO score is too low, send for revision to improve answer engine discoverability
      if (aeoScore < 60) {
        logger.info(
          { quality, aeoScore },
          "[Gate2] Quality passes but AEO score too low - requesting revision"
        );
        return "revise";
      }
      return "approve";
    }

    // Quality between reject and approve thresholds - send for revision
    return "revise";
  }

  private buildRevisionPrompt(
    original: ArticleApprovalInput,
    corrections: CorrectionInstruction[]
  ): string {
    const mustFix = corrections.filter(c => c.priority === "must_fix");
    const shouldFix = corrections.filter(c => c.priority === "should_fix");

    let prompt = `REVISION REQUIRED for article: "${original.title}"

The editor has reviewed your article and identified issues that need to be fixed.

## MUST FIX (Critical - article will be rejected without these fixes):
${
  mustFix.length > 0
    ? mustFix
        .map((c, i) => `${i + 1}. **${c.section}**: ${c.issue}\n   → ${c.instruction}`)
        .join("\n\n")
    : "None"
}

## SHOULD FIX (Important - significantly improves quality):
${
  shouldFix.length > 0
    ? shouldFix
        .map((c, i) => `${i + 1}. **${c.section}**: ${c.issue}\n   → ${c.instruction}`)
        .join("\n\n")
    : "None"
}

## Original Article Summary:
${original.summary || original.metaDescription || ""}

## Instructions:
1. Address ALL "must fix" items
2. Address as many "should fix" items as possible
3. Maintain the same overall structure and tone
4. Keep the word count similar (currently: ${original.wordCount})
5. Do not introduce new issues while fixing existing ones

Please rewrite the article with these corrections applied.`;

    return prompt;
  }

  /**
   * Quick quality check without full review
   * Used for batch processing or pre-screening
   */
  async quickCheck(input: ArticleApprovalInput): Promise<{
    estimatedQuality: number;
    hasObviousIssues: boolean;
    recommendation: "likely_pass" | "needs_review" | "likely_fail";
  }> {
    // Simple heuristics for quick check
    const issues: string[] = [];

    // Check word count
    if (input.wordCount < 500) {
      issues.push("Too short");
    }
    if (input.wordCount > 3000) {
      issues.push("Too long");
    }

    // Check meta
    if (!input.metaTitle || input.metaTitle.length < 30) {
      issues.push("Meta title too short or missing");
    }
    if (!input.metaDescription || input.metaDescription.length < 100) {
      issues.push("Meta description too short or missing");
    }

    // Check for AI patterns in title
    const aiPatterns = ["nestled", "vibrant", "tapestry", "embark", "unveil", "discover the"];
    const titleLower = input.title.toLowerCase();
    if (aiPatterns.some(p => titleLower.includes(p))) {
      issues.push("AI-sounding title");
    }

    // Use quality108 score if available
    let estimatedQuality = 70; // Base estimate
    if (input.quality108Score) {
      estimatedQuality = Math.round((input.quality108Score * 100) / 108);
    }

    // Adjust based on issues
    estimatedQuality -= issues.length * 10;
    estimatedQuality = Math.max(0, Math.min(100, estimatedQuality));

    let recommendation: "likely_pass" | "needs_review" | "likely_fail";
    if (estimatedQuality >= 80) {
      recommendation = "likely_pass";
    } else if (estimatedQuality >= 50) {
      recommendation = "needs_review";
    } else {
      recommendation = "likely_fail";
    }

    return {
      estimatedQuality,
      hasObviousIssues: issues.length > 0,
      recommendation,
    };
  }
}

// Singleton instance
let gate2Instance: Gate2Approver | null = null;

export function getGate2Approver(
  config?: Partial<GatekeeperConfig>,
  qualityConfig?: Partial<QualityGateConfig>
): Gate2Approver {
  if (!gate2Instance || config || qualityConfig) {
    gate2Instance = new Gate2Approver(config, qualityConfig);
  }
  return gate2Instance;
}

/**
 * Reviewing an article is judgement, not writing.
 *
 * The strong model is what makes the article good; it is not what decides
 * whether the article is good, and running the review on it doubled the time
 * for every publish. The cheap tier answers the same question in seconds.
 */
function preferFastForReview(tried: Set<string>) {
  const fast = EngineRegistry.getFastEngine();
  return fast && !tried.has(fast.id) && fast.isHealthy ? fast : null;
}
