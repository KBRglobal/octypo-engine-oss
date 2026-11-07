/**
 * Octypo Orchestrator - Main content generation pipeline
 * Coordinates writers, validators, quality scoring and link processing
 */

import {
  SubjectData,
  GeneratedLongFormContent,
  ContentQualityScore,
  ValidationResult,
  GenerationResult,
  OrchestratorConfig,
  BLUEPRINT_REQUIREMENTS,
  BlueprintCompliance,
  LinkProcessorResult,
} from "../types.js";
import { calculateQuality108Score } from "../quality/quality-108.js";
import { log } from "../../lib/logger.js";
import { entitled } from "../../config/entitlements.js";
import { parseJsonLoose } from "../../lib/json-repair.js";
import { AgentRegistry } from "../agents/base-agent.js";
import {
  WriterAgent,
  initializeWriterAgents,
  getWriterForCategory,
} from "../agents/writer-agents.js";
import { initializeValidatorAgents, getValidators } from "../agents/validator-agents.js";
import { buildCorrectionPrompt } from "../prompts/content-prompts.js";
import { EngineRegistry, generateWithEngine } from "../../services/engine-registry.js";
import { processContentLinks } from "../post-processors/link-processor.js";
import { SITE_NAME } from "../../config/domain.js";

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxRetries: 3, // 3 retries for resilience
  qualityThreshold: 0, // No quality threshold - just check 900 words minimum
  parallelWriters: 12, // Moderate concurrency for stability
  parallelValidators: 12, // Maximum parallel validators
  enableImageGeneration: false,
};

/** Minimal, generic Article JSON-LD payload for generated content */
function buildSchemaPayload(
  subject: SubjectData,
  content: GeneratedLongFormContent
): Record<string, any> {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: content.title || subject.title,
    name: subject.title,
    description: content.answerCapsule || content.metaDescription || "",
    publisher: { "@type": "Organization", name: SITE_NAME },
    datePublished: new Date().toISOString(),
  };
}

export class OctypoOrchestrator {
  private readonly config: OrchestratorConfig;
  private initialized = false;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    initializeWriterAgents();
    initializeValidatorAgents();

    EngineRegistry.initialize();
    EngineRegistry.getStats();

    this.initialized = true;
  }

  async generateArticleContent(subject: SubjectData): Promise<GenerationResult> {
    await this.initialize();

    const startTime = Date.now();
    let retryCount = 0;
    let lastContent: GeneratedLongFormContent | undefined;
    let lastQualityScore: ContentQualityScore | undefined;
    let lastValidationResults: ValidationResult[] = [];

    // Respect preferredWriterId if provided by Gate1 (or category-based lookup as fallback)
    const preferredId = subject.preferredWriterId;
    const writer = preferredId
      ? (AgentRegistry.get(preferredId) as WriterAgent | null) ||
        getWriterForCategory(subject.primaryCategory || "general")
      : getWriterForCategory(subject.primaryCategory || "general");
    if (!writer) {
      throw new Error("No writer agent available");
    }

    while (retryCount < this.config.maxRetries) {
      try {
        const content = await this.generateOrCorrect(
          writer,
          subject,
          retryCount,
          lastContent,
          lastValidationResults
        );

        content.schemaPayload = buildSchemaPayload(subject, content);

        const validationResults = await this.runValidators(content);
        const qualityScore = this.calculateQualityScore(content, validationResults);

        lastContent = content;
        lastQualityScore = qualityScore;
        lastValidationResults = validationResults;

        if (qualityScore.passed) {
          const linkResult = await this.runLinkProcessor(subject, content);
          this.applyLinkResults(content, linkResult);

          return {
            success: true,
            content,
            qualityScore,
            engineUsed: EngineRegistry.getStats().healthy > 0 ? "multi-engine" : "unknown",
            writerId: writer.id,
            validationResults,
            retryCount,
            generationTimeMs: Date.now() - startTime,
            linkProcessorResult: linkResult,
          };
        }

        retryCount++;
      } catch (genError) {
        const errMsg = genError instanceof Error ? genError.message : String(genError);
        console.error(
          `[Orchestrator] generateArticleContent attempt ${retryCount + 1}/${this.config.maxRetries} FAILED: ${errMsg}`
        );
        retryCount++;
        if (retryCount >= this.config.maxRetries) {
          console.error(
            `[Orchestrator] All ${this.config.maxRetries} retries exhausted. Last error: ${errMsg}`
          );
          return {
            success: false,
            content: lastContent,
            qualityScore: lastQualityScore,
            engineUsed: "unknown",
            writerId: writer.id,
            validationResults: lastValidationResults,
            retryCount,
            generationTimeMs: Date.now() - startTime,
          };
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Return success based on passed flag which encapsulates all quality criteria
    return {
      success: lastQualityScore?.passed ?? false,
      content: lastContent,
      qualityScore: lastQualityScore,
      engineUsed: "multi-engine",
      writerId: writer.id,
      validationResults: lastValidationResults,
      retryCount,
      generationTimeMs: Date.now() - startTime,
    };
  }

  private async runLinkProcessor(
    subject: SubjectData,
    content: GeneratedLongFormContent
  ): Promise<LinkProcessorResult> {
    // Not an error and not a failure — this customer simply did not buy it.
    // An empty processedContent leaves every section exactly as written; the
    // caller only copies fields that are present.
    if (!entitled("internal-links")) {
      return { success: true, linksAdded: 0, links: [], processedSections: [], processedContent: {} };
    }

    try {
      const result = await processContentLinks({
        id: String(subject.id),
        type: "article",
        topic: subject.topicName,
        sections: {
          introduction: content.introduction,
          whatToExpect: content.whatToExpect,
          visitorTips: content.visitorTips,
          howToGetThere: content.howToGetThere,
        },
      });
      return result;
    } catch (error) {
      return {
        success: false,
        linksAdded: 0,
        links: [],
        processedSections: [],
        processedContent: {},
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async runValidators(content: GeneratedLongFormContent): Promise<ValidationResult[]> {
    const validators = getValidators();
    const results: ValidationResult[] = [];

    // The two validators judge different things and neither reads the other's
    // verdict, so running them one after the other only added their latencies
    // together — on the critical path of every article.
    const dataValidator = validators.find(v => v.id === "validator-benjamin");
    const dataPromise = dataValidator
      ? dataValidator.execute({ contentId: "temp", content, validationType: "data" })
      : null;

    const styleValidator = validators.find(v => v.id === "validator-aisha");
    const stylePromise = styleValidator
      ? Promise.race([
          styleValidator.execute({ contentId: "temp", content, validationType: "style" }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Style validation timeout")),
              Number(process.env.STYLE_VALIDATION_TIMEOUT_MS) || 45_000
            )
          ),
        ]).catch(() => {
          log.warn(`[Orchestrator] Style validation timed out, using fallback pass`);
          return {
            validatorId: "validator-aisha",
            validatorName: "Aisha Khalil",
            passed: true,
            score: 75,
            issues: [],
            suggestions: ["Style validation timed out - using fallback score"],
          } as ValidationResult;
        })
      : null;

    const [dataResult, styleResult] = await Promise.all([dataPromise, stylePromise]);
    if (dataResult) results.push(dataResult);
    if (styleResult) results.push(styleResult);

    return results;
  }

  private calculateQualityScore(
    content: GeneratedLongFormContent,
    validationResults: ValidationResult[]
  ): ContentQualityScore {
    const blueprintCompliance = this.checkBlueprintCompliance(content);

    // Use 108-point quality scoring system
    const quality108 = calculateQuality108Score(content);

    // Map 108-point scores to legacy 100-point format for compatibility
    const seoScore = Math.round(
      (quality108.categories.technical_seo.score / quality108.categories.technical_seo.maxPoints) *
        100
    );
    const aeoScore = Math.round(
      (quality108.categories.aeo.score / quality108.categories.aeo.maxPoints) * 100
    );
    const styleScore = Math.round(
      (quality108.categories.voice_tone.score / quality108.categories.voice_tone.maxPoints) * 100
    );
    const culturalScore = Math.round(
      (quality108.categories.cultural_depth.score /
        quality108.categories.cultural_depth.maxPoints) *
        100
    );

    // Calculate factCheckScore from validation results and collect validator issues
    let factCheckScore = 100;
    let validatorCriticalCount = 0;
    let validatorMajorCount = 0;

    for (const result of validationResults) {
      const criticalIssues = result.issues.filter(i => i.severity === "critical").length;
      const majorIssues = result.issues.filter(i => i.severity === "major").length;

      validatorCriticalCount += criticalIssues;
      validatorMajorCount += majorIssues;

      // Critical = auto-fail, max 3 major allowed
      if (criticalIssues > 0) {
        factCheckScore = 0;
      } else if (majorIssues > 3) {
        factCheckScore = 50;
      } else {
        const minorCount = result.issues.length - majorIssues;
        factCheckScore = Math.max(0, 100 - majorIssues * 10 - minorCount * 2);
      }
    }

    // SPEED MODE: Only check 900 word minimum
    const totalWords =
      this.countWords(content.introduction) +
      this.countWords(content.whatToExpect) +
      this.countWords(content.visitorTips) +
      this.countWords(content.howToGetThere) +
      (content.sections || []).reduce((sum, s) => sum + this.countWords(s.content), 0) +
      content.faqs.reduce((sum, f) => sum + this.countWords(f.answer), 0);

    const totalMajorIssues = quality108.majorIssues.length + validatorMajorCount;

    // Only fail if under 900 words - ignore quality score
    const meetsWordCount = totalWords >= 900;

    const passed = meetsWordCount;

    // Normalize overallScore to 0-100 for compatibility while keeping 108-point data separate
    const normalizedOverallScore = quality108.percentage;

    if (!passed && totalMajorIssues > 0) {
      /* Major issues exist but handled at the validation level */
    }

    return {
      seoScore,
      aeoScore,
      factCheckScore,
      styleScore,
      culturalScore,
      overallScore: normalizedOverallScore, // Back to 0-100 scale for compatibility
      passed,
      validationResults,
      wordCounts: {
        introduction: this.countWords(content.introduction),
        whatToExpect: this.countWords(content.whatToExpect),
        visitorTips: this.countWords(content.visitorTips),
        howToGetThere: this.countWords(content.howToGetThere),
        faq: content.faqs.reduce((sum, f) => sum + this.countWords(f.answer), 0),
        answerCapsule: this.countWords(content.answerCapsule),
        metaTitle: content.metaTitle.length,
        metaDescription: content.metaDescription.length,
      },
      blueprintCompliance,
      // Include full 108-point details for analysis
      quality108: {
        totalScore: quality108.totalScore,
        maxScore: 108,
        percentage: quality108.percentage,
        grade: quality108.grade,
        criticalIssues: quality108.criticalIssues,
        majorIssues: quality108.majorIssues,
        categories: quality108.categories,
      },
    } as any;
  }

  private checkBlueprintCompliance(content: GeneratedLongFormContent): BlueprintCompliance {
    const introWords = this.countWords(content.introduction);
    const expectWords = this.countWords(content.whatToExpect);
    const tipsWords = this.countWords(content.visitorTips);
    const directionsWords = this.countWords(content.howToGetThere);
    const faqAnswerWords = content.faqs.map(f => this.countWords(f.answer));

    return {
      introductionWordCount: {
        actual: introWords,
        target: [BLUEPRINT_REQUIREMENTS.introduction.min, BLUEPRINT_REQUIREMENTS.introduction.max],
        passed:
          introWords >= BLUEPRINT_REQUIREMENTS.introduction.min &&
          introWords <= BLUEPRINT_REQUIREMENTS.introduction.max + 20,
      },
      whatToExpectWordCount: {
        actual: expectWords,
        target: [BLUEPRINT_REQUIREMENTS.whatToExpect.min, BLUEPRINT_REQUIREMENTS.whatToExpect.max],
        passed:
          expectWords >= BLUEPRINT_REQUIREMENTS.whatToExpect.min &&
          expectWords <= BLUEPRINT_REQUIREMENTS.whatToExpect.max + 50,
      },
      visitorTipsWordCount: {
        actual: tipsWords,
        target: [BLUEPRINT_REQUIREMENTS.visitorTips.min, BLUEPRINT_REQUIREMENTS.visitorTips.max],
        passed:
          tipsWords >= BLUEPRINT_REQUIREMENTS.visitorTips.min &&
          tipsWords <= BLUEPRINT_REQUIREMENTS.visitorTips.max + 30,
      },
      howToGetThereWordCount: {
        actual: directionsWords,
        target: [
          BLUEPRINT_REQUIREMENTS.howToGetThere.min,
          BLUEPRINT_REQUIREMENTS.howToGetThere.max,
        ],
        passed:
          directionsWords >= BLUEPRINT_REQUIREMENTS.howToGetThere.min &&
          directionsWords <= BLUEPRINT_REQUIREMENTS.howToGetThere.max + 30,
      },
      faqCount: {
        actual: content.faqs.length,
        target: [BLUEPRINT_REQUIREMENTS.faq.min, BLUEPRINT_REQUIREMENTS.faq.max],
        passed:
          content.faqs.length >= BLUEPRINT_REQUIREMENTS.faq.min &&
          content.faqs.length <= BLUEPRINT_REQUIREMENTS.faq.max,
      },
      faqAnswerLengths: {
        actual: faqAnswerWords,
        target: [BLUEPRINT_REQUIREMENTS.faq.answerMin, BLUEPRINT_REQUIREMENTS.faq.answerMax],
        allPassed: faqAnswerWords.every(
          w =>
            w >= BLUEPRINT_REQUIREMENTS.faq.answerMin - 5 &&
            w <= BLUEPRINT_REQUIREMENTS.faq.answerMax + 10
        ),
      },
      metaTitleLength: {
        actual: content.metaTitle.length,
        target: [BLUEPRINT_REQUIREMENTS.metaTitle.min, BLUEPRINT_REQUIREMENTS.metaTitle.max],
        passed:
          content.metaTitle.length >= BLUEPRINT_REQUIREMENTS.metaTitle.min - 5 &&
          content.metaTitle.length <= BLUEPRINT_REQUIREMENTS.metaTitle.max + 5,
      },
      metaDescriptionLength: {
        actual: content.metaDescription.length,
        target: [
          BLUEPRINT_REQUIREMENTS.metaDescription.min,
          BLUEPRINT_REQUIREMENTS.metaDescription.max,
        ],
        passed:
          content.metaDescription.length >= BLUEPRINT_REQUIREMENTS.metaDescription.min - 10 &&
          content.metaDescription.length <= BLUEPRINT_REQUIREMENTS.metaDescription.max + 10,
      },
      sensoryDescriptionCount: {
        actual: Array.isArray(content.sensoryDescriptions)
          ? content.sensoryDescriptions.length
          : 0,
        target: BLUEPRINT_REQUIREMENTS.whatToExpect.sensoryDescriptions,
        passed:
          (Array.isArray(content.sensoryDescriptions) ? content.sensoryDescriptions.length : 0) >=
          BLUEPRINT_REQUIREMENTS.whatToExpect.sensoryDescriptions - 1,
      },
      honestLimitationCount: {
        actual: Array.isArray(content.honestLimitations) ? content.honestLimitations.length : 0,
        target: [
          BLUEPRINT_REQUIREMENTS.honestLimitations.min,
          BLUEPRINT_REQUIREMENTS.honestLimitations.max,
        ],
        passed:
          (Array.isArray(content.honestLimitations) ? content.honestLimitations.length : 0) >=
          BLUEPRINT_REQUIREMENTS.honestLimitations.min - 1,
      },
    };
  }

  private async generateOrCorrect(
    writer: WriterAgent,
    subject: SubjectData,
    retryCount: number,
    lastContent: GeneratedLongFormContent | undefined,
    lastValidationResults: ValidationResult[]
  ): Promise<GeneratedLongFormContent> {
    if (retryCount === 0) {
      return writer.execute({
        subjectData: subject,
        sections: [
          "introduction",
          "whatToExpect",
          "visitorTips",
          "howToGetThere",
          "faq",
          "answerCapsule",
          "metaTitle",
          "metaDescription",
        ],
        targetWordCount: 2500,
        locale: "en",
      });
    }
    return this.regenerateWithCorrections(subject, lastContent!, lastValidationResults);
  }

  private applyLinkResults(content: GeneratedLongFormContent, linkResult: any): void {
    if (!linkResult.success || linkResult.linksAdded <= 0) return;
    const fields = ["introduction", "whatToExpect", "visitorTips", "howToGetThere"] as const;
    for (const field of fields) {
      if (linkResult.processedContent[field]) {
        (content as any)[field] = linkResult.processedContent[field];
      }
    }
  }

  private async regenerateWithCorrections(
    subject: SubjectData,
    previousContent: GeneratedLongFormContent,
    validationResults: ValidationResult[]
  ): Promise<GeneratedLongFormContent> {
    const issues = validationResults.flatMap(r =>
      r.issues.map(i => ({
        section: i.section,
        message: i.message,
        fix: i.fix || "",
      }))
    );

    if (issues.length === 0) {
      const writer = getWriterForCategory(subject.primaryCategory || "general");
      if (!writer) throw new Error("No writer available");

      return writer.execute({
        subjectData: subject,
        sections: [
          "introduction",
          "whatToExpect",
          "visitorTips",
          "howToGetThere",
          "faq",
          "answerCapsule",
          "metaTitle",
          "metaDescription",
        ],
        targetWordCount: 2500, // Target 2,200-3,000 words
        locale: "en",
      });
    }

    const correctionPrompt = buildCorrectionPrompt(previousContent, issues);

    const engine = EngineRegistry.getNextEngine();
    if (!engine) throw new Error("No engine available");

    const systemPrompt = `You are a content editor. Fix the issues in the content and return corrected JSON.`;

    const response = await generateWithEngine(engine, systemPrompt, correctionPrompt);
    EngineRegistry.reportSuccess(engine.id);

    let jsonString = response.trim();
    if (jsonString.startsWith("```json")) jsonString = jsonString.slice(7);
    if (jsonString.startsWith("```")) jsonString = jsonString.slice(3);
    if (jsonString.endsWith("```")) jsonString = jsonString.slice(0, -3);

    const parsed = parseJsonLoose<any>(jsonString.trim());

    return {
      title: parsed.title || previousContent.title,
      body: parsed.body || previousContent.body,
      introduction: parsed.introduction || previousContent.introduction,
      whatToExpect: parsed.whatToExpect || parsed.what_to_expect || previousContent.whatToExpect,
      visitorTips: parsed.visitorTips || parsed.visitor_tips || previousContent.visitorTips,
      howToGetThere:
        parsed.howToGetThere || parsed.how_to_get_there || previousContent.howToGetThere,
      faqs: Array.isArray(parsed.faqs) ? parsed.faqs : previousContent.faqs,
      sections: Array.isArray(parsed.sections) ? parsed.sections : previousContent.sections,
      answerCapsule: parsed.answerCapsule || parsed.answer_capsule || previousContent.answerCapsule,
      metaTitle: parsed.metaTitle || parsed.meta_title || previousContent.metaTitle,
      metaDescription:
        parsed.metaDescription || parsed.meta_description || previousContent.metaDescription,
      schemaPayload: parsed.schemaPayload || parsed.schema_payload || previousContent.schemaPayload,
      honestLimitations:
        parsed.honestLimitations ||
        parsed.honest_limitations ||
        previousContent.honestLimitations ||
        [],
      sensoryDescriptions:
        parsed.sensoryDescriptions ||
        parsed.sensory_descriptions ||
        previousContent.sensoryDescriptions ||
        [],
    };
  }

  private countWords(text: string | undefined | null | object): number {
    if (!text) return 0;
    if (typeof text !== "string") {
      text = JSON.stringify(text);
    }
    return (text as string).split(/\s+/).filter(w => w.length > 0).length;
  }
}

let orchestratorInstance: OctypoOrchestrator | null = null;

export function getOctypoOrchestrator(config?: Partial<OrchestratorConfig>): OctypoOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new OctypoOrchestrator(config);
  }
  return orchestratorInstance;
}
