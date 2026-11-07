/**
 * Gatekeeper Types
 * Intelligent content selection and approval system
 */

type PriorityLevel = "high" | "medium" | "low";

// ============================================================================
// GATE 1: Content Selection (Pre-Writing)
// ============================================================================

export interface ContentSelectionInput {
  feedItemId: string;
  title: string;
  summary: string;
  sourceUrl: string;
  sourceName: string;
  category?: string;
  publishedDate?: Date;
  topicId?: string;
}

export interface SEOAnalysis {
  score: number; // 0-100
  searchVolumePotential: PriorityLevel;
  competitionLevel: PriorityLevel;
  keywordOpportunities: string[];
  audienceJourneyStage: "awareness" | "research" | "decision" | "experience";
  eeaTScore: number; // E-E-A-T potential 0-100
  reasoning: string;
}

export interface AEOAnalysis {
  score: number; // 0-100
  extractability: PriorityLevel; // How easily AI can cite this
  schemaPotential: ("FAQ" | "HowTo" | "Event" | "Place" | "Review")[];
  answerBoxPotential: boolean;
  semanticClarity: number; // 0-100
  entityAuthority: string[]; // Entities this strengthens
  reasoning: string;
}

export interface ViralityAnalysis {
  score: number; // 0-100
  emotionalTriggers: string[];
  culturalRelevance: PriorityLevel;
  timeliness: "breaking" | "trending" | "evergreen" | "stale";
  shareability: number; // K-factor estimate 0-2
  megaEventConnection?: string;
  reasoning: string;
}

export type ContentTier = "S1" | "S2" | "S3";
export type SelectionDecision = "write" | "skip" | "queue";

export interface ContentSelectionResult {
  feedItemId: string;

  // Weighted scores (from spec: SEO 40%, AEO 35%, Virality 25%)
  seoAnalysis: SEOAnalysis;
  aeoAnalysis: AEOAnalysis;
  viralityAnalysis: ViralityAnalysis;

  // Combined score
  totalScore: number; // 0-100 weighted

  // Classification
  tier: ContentTier;
  decision: SelectionDecision;

  // Writer assignment
  recommendedWriterId: string;
  writerName: string;

  // Content value matrix position
  estimatedValue: PriorityLevel;
  estimatedCost: PriorityLevel;
  valueMatrixQuadrant: "quick_win" | "strategic_investment" | "gap_filler" | "skip";

  // Explanation
  reasoning: string;

  // Content type classification
  contentType: "article" | "guide" | "review" | "event";

  // Metadata
  evaluatedAt: Date;
  processingTimeMs: number;
}

// ============================================================================
// GATE 2: Final Approval (Post-Writing)
// ============================================================================

export interface ArticleApprovalInput {
  contentId: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  summary: string;
  answerCapsule?: string;
  blocks: any[]; // Content blocks
  wordCount: number;
  writerId: string;
  quality108Score?: number;
  originalFeedItemId?: string;
}

export interface QualityIssue {
  category: "accuracy" | "style" | "seo" | "aeo" | "structure" | "engagement" | "sensitivity";
  severity: "critical" | "major" | "minor";
  description: string;
  location?: string; // Where in the article
  suggestion: string;
}

export interface CorrectionInstruction {
  section: string;
  issue: string;
  instruction: string;
  priority: "must_fix" | "should_fix" | "nice_to_have";
}

export type ApprovalDecision = "approve" | "revise" | "reject";

export interface AEOChecklist {
  hasAnswerCapsule: boolean;
  answerCapsuleHasFact: boolean;
  hasFivePlusFaqs: boolean;
  faqAnswersAreDirect: boolean;
  concreteFactsInEverySection: boolean;
  secondPersonVoice: boolean;
  noAiCliches: boolean;
}

export interface ArticleApprovalResult {
  contentId: string;

  // Decision
  decision: ApprovalDecision;

  // Quality assessment
  overallQuality: number; // 0-100
  aeoScore?: number; // 0-100 AEO quality score
  aeoChecklist?: AEOChecklist;
  issues: QualityIssue[];

  // If revise
  corrections?: CorrectionInstruction[];
  revisionPrompt?: string; // Full prompt to send back to writer
  maxRevisions?: number;

  // If approve
  publicationReady: boolean;
  suggestedPublishTime?: Date;

  // Explanation
  reasoning: string;
  editorNotes: string;

  // Metadata
  evaluatedAt: Date;
  revisionCount: number;
  processingTimeMs: number;
}

// ============================================================================
// Gatekeeper Configuration
// ============================================================================

export interface GatekeeperConfig {
  // Gate 1 thresholds
  minScoreForS1: number; // Default: 85
  minScoreForS2: number; // Default: 70
  minScoreForS3: number; // Default: 50
  skipBelowScore: number; // Default: 50

  // Gate 2 thresholds
  minQualityForApproval: number; // Default: 85
  maxRevisionsAllowed: number; // Default: 3
  autoRejectBelowQuality: number; // Default: 40

  // Weights (must sum to 100)
  seoWeight: number; // Default: 40
  aeoWeight: number; // Default: 35
  viralityWeight: number; // Default: 25

  // Processing
  maxConcurrentEvaluations: number;
  timeoutMs: number;

  // LLM settings
  preferredEngine: string;
  fallbackEngines: string[];
}

export const DEFAULT_GATEKEEPER_CONFIG: GatekeeperConfig = {
  // Gate 1
  minScoreForS1: 85,
  minScoreForS2: 70,
  minScoreForS3: 50,
  skipBelowScore: 50,

  // Gate 2 - realistic thresholds for AI-generated content (typical score: 65-80)
  minQualityForApproval: 72, // Lowered from 85 - AI content realistically scores 65-80
  // Each revision is a full regeneration of a 1,500-word article — the single
  // most expensive thing the pipeline does, triggered by a score the reader
  // never sees. One pass, then the draft goes to the review console for a human
  // to accept or reject, which is faster and cheaper than a second guess.
  maxRevisionsAllowed: Number(process.env.MAX_REVISIONS) || 1,
  autoRejectBelowQuality: 35, // Lowered from 40 - only reject truly broken content

  // Weights
  seoWeight: 40,
  aeoWeight: 35,
  viralityWeight: 25,

  // Processing
  maxConcurrentEvaluations: 5,
  timeoutMs: 120000, // 2 minutes (was 60s - too short for LLM responses)

  // LLM - Gemini first (fast + free tier), then others as fallback
  preferredEngine: "gemini",
  fallbackEngines: ["groq", "anthropic", "openai", "openrouter", "mistral", "deepseek", "together"],
};

// ============================================================================
// Database Schema Types
// ============================================================================

export interface GatekeeperDecisionRecord {
  id: string;
  feedItemId: string;
  contentId?: string;

  // Gate 1 results
  gate1Decision: SelectionDecision;
  gate1Score: number;
  gate1Tier: ContentTier;
  gate1Analysis: {
    seo: SEOAnalysis;
    aeo: AEOAnalysis;
    virality: ViralityAnalysis;
  };
  gate1Reasoning: string;
  gate1At: Date;

  // Gate 2 results (after writing)
  gate2Decision?: ApprovalDecision;
  gate2Quality?: number;
  gate2Issues?: QualityIssue[];
  gate2Corrections?: CorrectionInstruction[];
  gate2Reasoning?: string;
  gate2At?: Date;

  // Revision tracking
  revisionCount: number;

  // Final status
  finalStatus:
    | "pending"
    | "writing"
    | "reviewing"
    | "approved"
    | "published"
    | "rejected"
    | "skipped";

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
