/**
 * AI Module Type Definitions
 * Generic interfaces and types for AI-generated content
 */

// ============================================================================
// AI Provider Types
// ============================================================================

export type ContentTier = "premium" | "standard";

export interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
}

// ============================================================================
// SEO Types
// ============================================================================

export interface SeoScoreResult {
  score: number;
  breakdown: {
    titleOptimization: number;
    metaDescription: number;
    keywordUsage: number;
    contentStructure: number;
    readability: number;
    internalLinking: number;
    imageOptimization: number;
  };
  suggestions: string[];
  passesThreshold: boolean;
}
