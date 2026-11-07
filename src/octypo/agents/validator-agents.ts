/**
 * Validator Agents - 6 specialized content validators
 * Ported from octypo-main Python patterns
 */

import { BaseAgent, AgentRegistry } from "./base-agent.js";
import { todayContextBlock } from "../../lib/today.js";
import {
  AgentPersona,
  ValidationTask,
  ValidationResult,
  ValidationIssue,
  GeneratedLongFormContent,
  BLUEPRINT_REQUIREMENTS,
  ContentSection,
} from "../types.js";

const VALIDATOR_PERSONAS: AgentPersona[] = [
  {
    id: "validator-james",
    name: "James Walker",
    specialty: "Fact Checking & Accuracy",
    tone: "Meticulous and thorough",
    expertise: ["fact verification", "data accuracy", "source validation", "claims verification"],
    systemPrompt: `You are James Walker, a veteran fact-checker with 20 years at major news organizations. Your job is to identify any factual claims that may be inaccurate, misleading, or unverifiable. Flag specific claims with their issues. Be particularly careful about: prices, distances, opening hours, historical dates, and capacity numbers.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
  {
    id: "validator-benjamin",
    name: "Benjamin Cole",
    specialty: "Data & Technical Validation",
    tone: "Precise and systematic",
    expertise: ["word counts", "structure validation", "schema validation", "format checking"],
    systemPrompt: `You are Benjamin Cole, a technical editor specializing in content structure and data validation. Your job is to verify that content meets all technical requirements: word counts, section structure, JSON schema validity, and formatting standards. You count words precisely and check every structural requirement.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
  {
    id: "validator-grace",
    name: "Grace Anderson",
    specialty: "Legal & Copyright Compliance",
    tone: "Careful and protective",
    expertise: ["copyright", "trademark", "defamation", "liability", "affiliate compliance"],
    systemPrompt: `You are Grace Anderson, a media lawyer specializing in digital publishing. Your job is to identify potential legal issues: copyright concerns, trademark usage, defamatory statements, misleading claims that could create liability, and affiliate disclosure compliance. Flag anything that could expose the publisher to legal risk.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
  {
    id: "validator-aisha",
    name: "Aisha Khalil",
    specialty: "Style & Tone Validation",
    tone: "Discerning and constructive",
    expertise: ["writing quality", "tone consistency", "AI pattern detection", "engagement"],
    systemPrompt: `You are Aisha Khalil, an editorial director with deep editing expertise. Your job is to ensure content reads naturally, maintains consistent tone, and avoids AI-typical patterns. Flag: overused phrases, robotic transitions, inconsistent voice, and content that feels generic rather than specific. Look for concrete details and genuine subject-matter knowledge.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
  {
    id: "validator-hassan",
    name: "Hassan Mahmoud",
    specialty: "Cultural Sensitivity",
    tone: "Respectful and knowledgeable",
    expertise: ["cultural accuracy", "religious sensitivity", "local customs", "representation"],
    systemPrompt: `You are Hassan Mahmoud, a cultural consultant with global expertise. Your job is to ensure content is culturally sensitive, accurate in its cultural references, and respectful of local customs and religious practices. Flag stereotypes, misrepresentations, and potentially offensive content.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
  {
    id: "validator-chris",
    name: "Christopher Davis",
    specialty: "Safety & Accessibility",
    tone: "Protective and thorough",
    expertise: [
      "safety warnings",
      "accessibility info",
      "health considerations",
      "risk advisories",
    ],
    systemPrompt: `You are Christopher Davis, a safety and accessibility consultant. Your job is to ensure content includes appropriate safety information, accessibility details, and risk considerations. Flag missing warnings, unclear accessibility information, and content that could put readers at risk.`,
    preferredEngines: ["anthropic", "openai"],
    role: "validator",
  },
];

export class ValidatorAgent extends BaseAgent {
  constructor(persona: AgentPersona) {
    super(persona);
  }

  async execute(task: ValidationTask): Promise<ValidationResult> {
    this.log(`Starting ${this.specialty} validation`);

    if (this.persona.id === "validator-benjamin") {
      return this.performDataValidation(task.content);
    }

    return this.performLLMValidation(task);
  }

  /** Check a section's word count against min/max requirements */
  private validateWordCount(
    text: string | undefined,
    sectionName: ContentSection | "overall",
    req: { min: number; max: number },
    shortFix: string,
    issues: ValidationIssue[]
  ): void {
    const words = this.countWords(text);
    if (words < req.min) {
      issues.push({
        severity: "major",
        section: sectionName,
        message: `${sectionName} too short: ${words} words (need ${req.min}-${req.max})`,
        fix: shortFix,
      });
    } else if (words > req.max) {
      issues.push({
        severity: "minor",
        section: sectionName,
        message: `${sectionName} too long: ${words} words (target ${req.min}-${req.max})`,
        fix: `Remove ${words - req.max} words from ${sectionName}`,
      });
    }
  }

  /** Check a char-length field (meta title/description) */
  private validateCharLength(
    text: string,
    sectionName: ContentSection | "overall",
    req: { min: number; max: number },
    shortFix: string,
    longFix: string,
    issues: ValidationIssue[]
  ): void {
    const len = text.length;
    if (len < req.min || len > req.max) {
      issues.push({
        severity: "major",
        section: sectionName,
        message: `${sectionName} wrong length: ${len} chars (need ${req.min}-${req.max})`,
        fix: len < req.min ? shortFix : longFix,
      });
    }
  }

  private performDataValidation(content: GeneratedLongFormContent): ValidationResult {
    const issues: ValidationIssue[] = [];
    const suggestions: string[] = [];
    const reqs = BLUEPRINT_REQUIREMENTS;

    this.validateWordCount(
      content.introduction,
      "introduction",
      reqs.introduction,
      `Add more words to introduction`,
      issues
    );
    this.validateWordCount(
      content.whatToExpect,
      "whatToExpect",
      reqs.whatToExpect,
      `Add more words with concrete details`,
      issues
    );
    this.validateWordCount(
      content.visitorTips,
      "visitorTips",
      reqs.visitorTips,
      `Add more practical tips with Timing/Pro Tips/Save Money sections`,
      issues
    );
    this.validateWordCount(
      content.howToGetThere,
      "howToGetThere",
      reqs.howToGetThere,
      `Add concrete getting-started options with specifics`,
      issues
    );

    if (content.faqs.length < reqs.faq.min) {
      issues.push({
        severity: "major",
        section: "faq",
        message: `Not enough FAQs: ${content.faqs.length} (need ${reqs.faq.min}-${reqs.faq.max})`,
        fix: `Add ${reqs.faq.min - content.faqs.length} more FAQ questions`,
      });
    }

    for (const faq of content.faqs) {
      this.validateWordCount(
        faq.answer,
        "faq",
        { min: reqs.faq.answerMin, max: reqs.faq.answerMax },
        `Expand FAQ answer to ${reqs.faq.answerMin} words using Answer Capsule method`,
        issues
      );
    }

    this.validateCharLength(
      content.metaTitle,
      "metaTitle",
      reqs.metaTitle,
      "Add year and key detail to meta title",
      "Shorten meta title",
      issues
    );
    this.validateCharLength(
      content.metaDescription,
      "metaDescription",
      reqs.metaDescription,
      "Add CTA to meta description",
      "Shorten meta description",
      issues
    );

    if ((content.honestLimitations?.length || 0) < reqs.honestLimitations.min) {
      issues.push({
        severity: "major",
        section: "overall",
        message: `Not enough honest limitations: ${content.honestLimitations?.length || 0} (need ${reqs.honestLimitations.min}-${reqs.honestLimitations.max})`,
        fix: "Add honest limitations about costs, effort, or caveats",
      });
    }

    if ((content.sensoryDescriptions?.length || 0) < reqs.whatToExpect.sensoryDescriptions) {
      issues.push({
        severity: "major",
        section: "whatToExpect",
        message: `Not enough concrete details: ${content.sensoryDescriptions?.length || 0} (need ${reqs.whatToExpect.sensoryDescriptions}+)`,
        fix: "Add concrete specific details",
      });
    }

    const criticalCount = issues.filter(i => i.severity === "critical").length;
    const majorCount = issues.filter(i => i.severity === "major").length;
    const minorCount = issues.filter(i => i.severity === "minor").length;

    // NEW: Simplified scoring - only major/minor matter, no double penalties
    // Critical = auto-fail (score 0)
    // Major = -10 points each
    // Minor = -2 points each
    let score: number;
    if (criticalCount > 0) {
      score = 0; // Critical = auto-fail
    } else if (majorCount > 3) {
      score = 50; // Too many major issues
    } else {
      score = Math.max(0, 100 - majorCount * 10 - minorCount * 2);
    }

    return {
      validatorId: this.persona.id,
      validatorName: this.persona.name,
      passed: criticalCount === 0 && majorCount <= 3 && score >= 70, // Max 3 major allowed
      score,
      issues,
      suggestions,
    };
  }

  private async performLLMValidation(task: ValidationTask): Promise<ValidationResult> {
    const systemPrompt =
      this.persona.systemPrompt +
      `

${todayContextBlock()}

OUTPUT FORMAT (JSON only):
{
  "passed": true/false,
  "score": 0-100,
  "issues": [
    {"severity": "critical/major/minor", "section": "section_name", "message": "issue description", "fix": "how to fix"}
  ],
  "suggestions": ["improvement suggestion 1", "improvement suggestion 2"]
}`;

    const userPrompt = `Validate this content for ${this.specialty}:

CONTENT TO VALIDATE:
${JSON.stringify(task.content, null, 2)}

Analyze for issues related to your specialty and return JSON response.`;

    try {
      const response = await this.callLLM(systemPrompt, userPrompt);
      let jsonString = response.trim();

      if (jsonString.startsWith("```json")) {
        jsonString = jsonString.slice(7);
      } else if (jsonString.startsWith("```")) {
        jsonString = jsonString.slice(3);
      }
      if (jsonString.endsWith("```")) {
        jsonString = jsonString.slice(0, -3);
      }

      const parsed = JSON.parse(jsonString.trim());

      return {
        validatorId: this.persona.id,
        validatorName: this.persona.name,
        passed: parsed.passed ?? true,
        score: parsed.score ?? 85,
        issues: parsed.issues ?? [],
        suggestions: parsed.suggestions ?? [],
      };
    } catch (error) {
      this.log(`Validation error - HARD FAILURE: ${error}`);
      // STRICT: Validation error = FAILURE - NO FALLBACK SCORES
      return {
        validatorId: this.persona.id,
        validatorName: this.persona.name,
        passed: false,
        score: 0,
        issues: [
          {
            severity: "critical",
            section: "overall",
            message: `Validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            fix: "Regenerate content with different engine",
          },
        ],
        suggestions: ["Validation error - content must be regenerated"],
      };
    }
  }

  private countWords(text: string | undefined | null | object): number {
    if (!text) return 0;
    if (typeof text !== "string") {
      // Handle objects/arrays by converting to string first
      text = JSON.stringify(text);
    }
    return text.split(/\s+/).filter(w => w.length > 0).length;
  }
}

export function initializeValidatorAgents(): void {
  for (const persona of VALIDATOR_PERSONAS) {
    const agent = new ValidatorAgent(persona);
    AgentRegistry.register(agent);
  }
}

export function getValidators(): ValidatorAgent[] {
  return AgentRegistry.getAllValidators() as ValidatorAgent[];
}
