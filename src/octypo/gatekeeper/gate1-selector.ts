/**
 * Gate 1: Content Selector
 * Evaluates RSS items and decides what's worth writing about
 *
 * Responsibilities:
 * - Analyze SEO potential (40%)
 * - Analyze AEO potential (35%)
 * - Analyze Virality potential (25%)
 * - Classify into S1/S2/S3 tiers
 * - Match to best writer
 * - Generate writer prompt
 */

import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import { WRITERS } from "../../config/writers.config.js";
import {
  ContentSelectionInput,
  ContentSelectionResult,
  SEOAnalysis,
  AEOAnalysis,
  ViralityAnalysis,
  ContentTier,
  SelectionDecision,
  GatekeeperConfig,
  DEFAULT_GATEKEEPER_CONFIG,
} from "./types.js";
import { logger } from "../../lib/logger.js";
import { getDeduplicationEngine } from "./deduplication/index.js";
import { EVALUATOR_PROMPTS } from "./prompts/evaluator-prompts.js";
import { passesRequiredAngle, requiredAngle } from "./required-angle.js";
import { repairInWordQuotes } from "./gate2-approver.js";

// Use the 2026-optimized prompts from the prompts module
const GATE1_SYSTEM_PROMPT = EVALUATOR_PROMPTS.SYSTEM;

// User prompt template from the 2026 optimized prompts
const GATE1_EVALUATION_PROMPT = EVALUATOR_PROMPTS.USER_TEMPLATE;

export class Gate1Selector {
  private readonly config: GatekeeperConfig;

  constructor(config: Partial<GatekeeperConfig> = {}) {
    this.config = { ...DEFAULT_GATEKEEPER_CONFIG, ...config };
  }

  async evaluate(input: ContentSelectionInput): Promise<ContentSelectionResult> {
    const startTime = Date.now();

    logger.info({ title: input.title.substring(0, 50) }, "[Gate1] Evaluating content");

    try {
      // Step 0: Deduplication check (before spending LLM resources)
      const dedupEngine = getDeduplicationEngine();
      const dedupResult = await dedupEngine.checkContent(
        input.title,
        input.summary,
        input.sourceUrl
      );

      if (!dedupResult.isOriginal) {
        logger.info(
          {
            title: input.title.substring(0, 50),
            similarity: Math.round((dedupResult.duplicateOf?.similarity || 0) * 100),
            duplicateOf: dedupResult.duplicateOf?.sourceTitle?.substring(0, 50),
          },
          "[Gate1] Duplicate content detected - skipping"
        );

        // Return early with skip decision
        return {
          feedItemId: input.feedItemId,
          seoAnalysis: {
            score: 0,
            searchVolumePotential: "low",
            competitionLevel: "high",
            keywordOpportunities: [],
            audienceJourneyStage: "awareness",
            eeaTScore: 0,
            reasoning: "Duplicate content",
          },
          aeoAnalysis: {
            score: 0,
            extractability: "low",
            schemaPotential: [],
            answerBoxPotential: false,
            semanticClarity: 0,
            entityAuthority: [],
            reasoning: "Duplicate content",
          },
          viralityAnalysis: {
            score: 0,
            emotionalTriggers: [],
            culturalRelevance: "low",
            timeliness: "stale",
            shareability: 0,
            reasoning: "Duplicate content",
          },
          totalScore: 0,
          tier: "S3",
          decision: "skip",
          recommendedWriterId: "",
          writerName: "",
          estimatedValue: "low",
          estimatedCost: "low",
          valueMatrixQuadrant: "skip",
          reasoning: `Duplicate content (${Math.round((dedupResult.duplicateOf?.similarity || 0) * 100)}% similar to: ${dedupResult.duplicateOf?.sourceTitle || "existing content"})`,
          contentType: "article",
          evaluatedAt: new Date(),
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Market screen first: off-market news is skipped before the full evaluation is paid for.
      if (!(await passesRequiredAngle(input.title, input.summary || ""))) {
        const reason = `Not about ${requiredAngle()}`;
        logger.info({ title: input.title.substring(0, 50), angle: requiredAngle() }, "[Gate1] Skipped: outside the required news angle");
        return {
          feedItemId: input.feedItemId,
          seoAnalysis: {
            score: 0,
            searchVolumePotential: "low",
            competitionLevel: "high",
            keywordOpportunities: [],
            audienceJourneyStage: "awareness",
            eeaTScore: 0,
            reasoning: reason,
          },
          aeoAnalysis: {
            score: 0,
            extractability: "low",
            schemaPotential: [],
            answerBoxPotential: false,
            semanticClarity: 0,
            entityAuthority: [],
            reasoning: reason,
          },
          viralityAnalysis: {
            score: 0,
            emotionalTriggers: [],
            culturalRelevance: "low",
            timeliness: "stale",
            shareability: 0,
            reasoning: reason,
          },
          totalScore: 0,
          tier: "S3",
          decision: "skip",
          recommendedWriterId: "",
          writerName: "",
          estimatedValue: "low",
          estimatedCost: "low",
          valueMatrixQuadrant: "skip",
          reasoning: reason,
          contentType: "article",
          evaluatedAt: new Date(),
          processingTimeMs: Date.now() - startTime,
        };
      }

      // Build the evaluation prompt
      const prompt = this.buildPrompt(input);

      // Call LLM for evaluation
      const response = await this.callLLM(prompt);

      // Parse and validate response
      const evaluation = this.parseResponse(response);

      // Calculate weighted score
      const totalScore = this.calculateTotalScore(
        evaluation.seoAnalysis,
        evaluation.aeoAnalysis,
        evaluation.viralityAnalysis
      );

      // Determine tier based on score
      const tier = this.determineTier(totalScore);

      // Make final decision
      const decision = this.makeDecision(totalScore, tier, evaluation);

      // Match to best writer (prompt returns recommendedWriterType)
      const writer = this.matchWriter(
        evaluation.recommendedWriterType || evaluation.recommendedWriterCategory,
        input.category
      );

      // Determine value matrix quadrant
      const valueMatrixQuadrant = this.determineValueQuadrant(
        evaluation.estimatedValue,
        evaluation.estimatedCost
      );

      const result: ContentSelectionResult = {
        feedItemId: input.feedItemId,
        seoAnalysis: evaluation.seoAnalysis,
        aeoAnalysis: evaluation.aeoAnalysis,
        viralityAnalysis: evaluation.viralityAnalysis,
        totalScore,
        tier,
        decision,
        recommendedWriterId: writer.id,
        writerName: writer.name,
        estimatedValue: evaluation.estimatedValue,
        estimatedCost: evaluation.estimatedCost,
        valueMatrixQuadrant,
        reasoning: evaluation.reasoning,
        contentType: evaluation.contentType || "article",
        evaluatedAt: new Date(),
        processingTimeMs: Date.now() - startTime,
      };

      logger.info({ totalScore, tier, decision }, "[Gate1] Evaluation complete");

      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : "Unknown" },
        "[Gate1] LLM evaluation failed, using heuristic fallback"
      );

      // Instead of throwing (which silently skips the item in batch mode),
      // use a heuristic fallback so items are not lost
      return this.heuristicFallback(input, startTime);
    }
  }

  /**
   * Heuristic fallback when all LLM engines fail.
   * Uses simple keyword/length signals to make a conservative decision
   * so that items are not silently dropped from the pipeline.
   */
  private heuristicFallback(
    input: ContentSelectionInput,
    startTime: number
  ): ContentSelectionResult {
    const text = `${input.title} ${input.summary || ""}`.toLowerCase();
    const titleLength = input.title.length;

    // Simple scoring heuristic
    let seoScore = 40;
    let aeoScore = 35;
    let viralityScore = 30;

    // Boost for longer, more descriptive titles (more likely to be quality content)
    if (titleLength > 40) seoScore += 10;
    if (titleLength > 80) seoScore += 5;

    // Boost for newsworthiness keywords (generic signals of substantive items)
    const signalKeywords = [
      "launch",
      "announce",
      "report",
      "study",
      "research",
      "record",
      "growth",
      "decline",
      "acquisition",
      "merger",
      "regulation",
      "breakthrough",
      "release",
      "update",
      "opening",
      "new",
    ];
    const matchedKeywords = signalKeywords.filter(kw => text.includes(kw));
    seoScore += Math.min(matchedKeywords.length * 5, 20);
    aeoScore += Math.min(matchedKeywords.length * 3, 15);

    // Timeliness boost
    const isRecent =
      input.publishedDate && Date.now() - input.publishedDate.getTime() < 48 * 60 * 60 * 1000; // 48 hours
    if (isRecent) viralityScore += 15;

    // Cap scores at 100
    seoScore = Math.min(seoScore, 100);
    aeoScore = Math.min(aeoScore, 100);
    viralityScore = Math.min(viralityScore, 100);

    const totalScore = this.calculateTotalScore(
      { score: seoScore } as SEOAnalysis,
      { score: aeoScore } as AEOAnalysis,
      { score: viralityScore } as ViralityAnalysis
    );

    const tier = this.determineTier(totalScore);
    // Be conservative with heuristic - only write S2+ to avoid flooding with low-quality
    const decision: SelectionDecision = tier === "S1" ? "write" : tier === "S2" ? "queue" : "skip";

    const writer = this.matchWriter(input.category || "", input.category);

    logger.info(
      { totalScore, tier, decision, matchedKeywords: matchedKeywords.length },
      "[Gate1] Heuristic fallback result"
    );

    return {
      feedItemId: input.feedItemId,
      seoAnalysis: {
        score: seoScore,
        searchVolumePotential: seoScore >= 60 ? "medium" : "low",
        competitionLevel: "medium",
        keywordOpportunities: matchedKeywords.slice(0, 3),
        audienceJourneyStage: "awareness",
        eeaTScore: 40,
        reasoning: "Heuristic evaluation (LLM unavailable)",
      },
      aeoAnalysis: {
        score: aeoScore,
        extractability: aeoScore >= 50 ? "medium" : "low",
        schemaPotential: [],
        answerBoxPotential: false,
        semanticClarity: 40,
        entityAuthority: [],
        reasoning: "Heuristic evaluation (LLM unavailable)",
      },
      viralityAnalysis: {
        score: viralityScore,
        emotionalTriggers: [],
        culturalRelevance: "medium",
        timeliness: isRecent ? "trending" : "evergreen",
        shareability: 0.5,
        reasoning: "Heuristic evaluation (LLM unavailable)",
      },
      totalScore,
      tier,
      decision,
      recommendedWriterId: writer.id,
      writerName: writer.name,
      estimatedValue: totalScore >= 60 ? "medium" : "low",
      estimatedCost: "low",
      valueMatrixQuadrant: totalScore >= 60 ? "gap_filler" : "skip",
      reasoning: `Heuristic fallback (LLM engines unavailable). Score based on ${matchedKeywords.length} keyword matches, title length ${titleLength}.`,
      contentType: "article",
      evaluatedAt: new Date(),
      processingTimeMs: Date.now() - startTime,
    };
  }

  private buildPrompt(input: ContentSelectionInput): string {
    return GATE1_EVALUATION_PROMPT.replace("{title}", input.title)
      .replace("{summary}", input.summary || "No summary available")
      .replace("{sourceName}", input.sourceName || "Unknown")
      .replace("{sourceCredibility}", "medium") // Defaults to medium; source credibility scoring based on domain reputation deferred
      .replace("{category}", input.category || "General")
      .replace("{topic}", input.topicId || "Not specified")
      .replace("{publishedDate}", input.publishedDate?.toISOString() || "Unknown");
  }

  private async callLLM(prompt: string): Promise<string> {
    const preferredProviders = [this.config.preferredEngine, ...this.config.fallbackEngines];
    const triedEngines = new Set<string>();
    const errors: Array<{ engine: string; provider: string; error: string }> = [];

    // Try all available engines (up to total engine count)
    const totalEngines = EngineRegistry.getEngineCount();
    const MAX_RETRIES = Math.max(totalEngines, 5);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const engine =
        EngineRegistry.getNextByProviderPreference(preferredProviders, triedEngines) ||
        EngineRegistry.getNextFromQueue(triedEngines);

      if (!engine) {
        break; // No more engines to try
      }

      triedEngines.add(engine.id);

      if (!engine.isHealthy) {
        errors.push({
          engine: engine.id,
          provider: engine.provider,
          error: "Engine unhealthy (previously failed)",
        });
        continue;
      }

      try {
        const response = await Promise.race([
          generateWithEngine(engine, GATE1_SYSTEM_PROMPT, prompt),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("Gate1 timeout after 30000ms")), 30000)
          ),
        ]);
        EngineRegistry.reportSuccess(engine.id);
        return response;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        EngineRegistry.reportError(engine.id, errorMsg);
        errors.push({ engine: engine.id, provider: engine.provider, error: errorMsg });
        logger.warn(
          { engineId: engine.id, provider: engine.provider, error: errorMsg },
          "[Gate1] Engine failed, trying next"
        );
        continue;
      }
    }

    const errorSummary = errors.map(e => `${e.engine}(${e.provider}): ${e.error}`).join("; ");
    throw new Error(
      `All LLM engines failed (${triedEngines.size} tried, ${totalEngines} total). Errors: ${errorSummary}`
    );
  }

  private parseResponse(response: string): any {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response;

    const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(response);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    // Try to find JSON object directly
    const objectMatch = /\{[\s\S]*\}/.exec(jsonStr);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    try {
      return JSON.parse(jsonStr);
    } catch {
      // Same unescaped in-word quote that strands Gate 2 reviews.
      try {
        return JSON.parse(repairInWordQuotes(jsonStr));
      } catch {
        // Fall through to the logged failure.
      }
      logger.error("[Gate1] Failed to parse LLM response");
      throw new Error("Failed to parse Gate1 evaluation response");
    }
  }

  private calculateTotalScore(
    seo: SEOAnalysis,
    aeo: AEOAnalysis,
    virality: ViralityAnalysis
  ): number {
    const weightedScore =
      (seo.score * this.config.seoWeight) / 100 +
      (aeo.score * this.config.aeoWeight) / 100 +
      (virality.score * this.config.viralityWeight) / 100;

    return Math.round(weightedScore);
  }

  private determineTier(score: number): ContentTier {
    if (score >= this.config.minScoreForS1) return "S1";
    if (score >= this.config.minScoreForS2) return "S2";
    return "S3";
  }

  private makeDecision(score: number, tier: ContentTier, evaluation: any): SelectionDecision {
    // Skip if below threshold
    if (score < this.config.skipBelowScore) {
      return "skip";
    }

    // Skip if stale content
    if (evaluation.viralityAnalysis?.timeliness === "stale") {
      return "skip";
    }

    // Write S1 and S2 immediately
    if (tier === "S1" || tier === "S2") {
      return "write";
    }

    // S3: Check value matrix
    if (evaluation.estimatedValue === "low" && evaluation.estimatedCost === "high") {
      return "skip";
    }

    // S3 with decent value: queue for later
    if (tier === "S3" && score >= this.config.minScoreForS3) {
      return "queue";
    }

    return "skip";
  }

  private matchWriter(
    recommendedCategory: string,
    inputCategory?: string
  ): { id: string; name: string } {
    const category = recommendedCategory?.toLowerCase() || inputCategory?.toLowerCase() || "";

    // Category to writer mapping based on WRITERS config
    const categoryMap: Record<string, string> = {
      // News Reporter
      news: "news-reporter",
      breaking: "news-reporter",
      report: "news-reporter",
      announcement: "news-reporter",

      // Analyst
      analysis: "analyst",
      market: "analyst",
      business: "analyst",
      economy: "analyst",
      data: "analyst",

      // How-To Writer
      howto: "how-to-writer",
      "how-to": "how-to-writer",
      guide: "how-to-writer",
      tutorial: "how-to-writer",

      // Reviewer
      review: "reviewer",
      comparison: "reviewer",
      versus: "reviewer",
      evaluation: "reviewer",

      // Trends Writer
      trend: "trends-writer",
      emerging: "trends-writer",
      forecast: "trends-writer",

      // Storyteller
      story: "storyteller",
      feature: "storyteller",
      profile: "storyteller",
      interview: "storyteller",

      // Listicle Writer
      list: "listicle-writer",
      roundup: "listicle-writer",
      top: "listicle-writer",

      // Deep-Dive Researcher
      research: "deep-dive-researcher",
      "deep-dive": "deep-dive-researcher",
      investigation: "deep-dive-researcher",
      explainer: "deep-dive-researcher",
    };

    // Find matching writer
    for (const [keyword, writerId] of Object.entries(categoryMap)) {
      if (category.includes(keyword)) {
        const writer = WRITERS.find(w => w.id === writerId);
        if (writer) {
          return { id: writer.id, name: writer.name };
        }
      }
    }

    // Default to the News Reporter (general authority)
    const defaultWriter = WRITERS.find(w => w.id === "news-reporter") || WRITERS[0];
    if (!defaultWriter) {
      return { id: "news-reporter", name: "News Reporter" };
    }
    return { id: defaultWriter.id, name: defaultWriter.name };
  }

  private determineValueQuadrant(
    value: "high" | "medium" | "low",
    cost: "high" | "medium" | "low"
  ): "quick_win" | "strategic_investment" | "gap_filler" | "skip" {
    if (value === "high" && (cost === "low" || cost === "medium")) {
      return "quick_win";
    }
    if (value === "high" && cost === "high") {
      return "strategic_investment";
    }
    if ((value === "low" || value === "medium") && cost === "low") {
      return "gap_filler";
    }
    return "skip";
  }

  /**
   * Batch evaluate multiple items
   */
  async evaluateBatch(
    items: ContentSelectionInput[],
    maxConcurrent: number = this.config.maxConcurrentEvaluations
  ): Promise<ContentSelectionResult[]> {
    const results: ContentSelectionResult[] = [];

    // Process in batches
    for (let i = 0; i < items.length; i += maxConcurrent) {
      const batch = items.slice(i, i + maxConcurrent);
      const batchResults = await Promise.all(
        batch.map(item =>
          this.evaluate(item).catch(error => {
            logger.error({ error: error.message }, "[Gate1] Batch item failed");
            return null;
          })
        )
      );

      results.push(...batchResults.filter((r): r is ContentSelectionResult => r !== null));
    }

    return results;
  }
}

// Singleton instance
let gate1Instance: Gate1Selector | null = null;

export function getGate1Selector(config?: Partial<GatekeeperConfig>): Gate1Selector {
  if (!gate1Instance || config) {
    gate1Instance = new Gate1Selector(config);
  }
  return gate1Instance;
}
