/**
 * Decision Engine Rules
 *
 * Role: Classify news to S1, S2, or S3 and determine its fate
 * Logic-based rules for autonomous content decisions
 */

export const DECISION_ENGINE_RULES = {
  /**
   * Tier Classification Thresholds
   */
  THRESHOLDS: {
    S1: {
      minScore: 85,
      description: "Critical news - breaking events, major industry shifts",
      examples: [
        "Major company bankruptcy or collapse",
        "Landmark regulation or policy change",
        "Major merger or acquisition announcement",
        "Significant safety or security incident",
        "Industry-defining product launch",
      ],
    },
    S2: {
      minScore: 60,
      maxScore: 84,
      description: "Important news - new routes, significant price changes",
      examples: [
        "Notable product or service announcement",
        "Significant pricing or plan change",
        "Major partnership or expansion",
        "Important research findings",
        "New flagship product launch",
      ],
    },
    S3: {
      minScore: 40,
      maxScore: 59,
      description: "General content - updates, minor news",
      examples: [
        "Minor version or schedule adjustments",
        "Routine seasonal updates",
        "General background information",
        "Standard industry reports",
      ],
    },
    SKIP: {
      maxScore: 39,
      description: "Low value - duplicate, generic, or outdated content",
      reasons: [
        "Duplicate content (>85% similarity)",
        "Generic press release",
        "Outdated information",
        "No unique angle",
        "Low search potential",
      ],
    },
  },

  /**
   * Processing Rules by Tier
   */
  PROCESSING_RULES: {
    S1: {
      pipeline: "deep_writing",
      requiresGraphics: true,
      requiresHumanReview: true,
      reviewLevel: "senior_editor",
      maxProcessingTime: "4_hours",
      priority: "critical",
      notifications: ["slack_breaking", "email_editors"],
      outputRequirements: {
        minWordCount: 1500,
        requiresFAQ: true,
        requiresTimeline: true,
        requiresExpertAnalysis: true,
        requiresSchemaMarkup: ["Article", "NewsArticle", "FAQ"],
      },
      qualityGates: [
        "fact_check_required",
        "source_verification",
        "legal_review_if_needed",
        "seo_optimization_check",
        "aeo_structure_validation",
      ],
    },
    S2: {
      pipeline: "fast_writing",
      requiresGraphics: false,
      requiresHumanReview: true,
      reviewLevel: "editor",
      maxProcessingTime: "2_hours",
      priority: "high",
      notifications: ["slack_news"],
      outputRequirements: {
        minWordCount: 800,
        requiresFAQ: true,
        requiresTimeline: false,
        requiresExpertAnalysis: false,
        requiresSchemaMarkup: ["Article", "FAQ"],
      },
      qualityGates: ["basic_fact_check", "seo_optimization_check", "aeo_structure_validation"],
    },
    S3: {
      pipeline: "standard_writing",
      requiresGraphics: false,
      requiresHumanReview: false,
      reviewLevel: "auto_gate2",
      maxProcessingTime: "1_hour",
      priority: "normal",
      notifications: [],
      outputRequirements: {
        minWordCount: 500,
        requiresFAQ: true,
        requiresTimeline: false,
        requiresExpertAnalysis: false,
        requiresSchemaMarkup: ["Article"],
      },
      qualityGates: ["automated_quality_check", "duplicate_final_check"],
    },
  },

  /**
   * Automatic Skip Conditions
   */
  SKIP_CONDITIONS: {
    // Content-based skips
    duplicateSimilarity: 0.85, // 85% similarity = duplicate
    staleness: {
      breaking: 24, // hours - breaking news becomes stale after 24h
      trending: 72, // hours - trending topics after 3 days
      evergreen: null, // no staleness for evergreen
    },

    // Source-based skips
    lowCredibilitySources: [
      // Add known low-quality sources
    ],
    blockedDomains: [
      // Add domains to always skip
    ],

    // Topic-based skips
    sensitiveTopics: ["political_controversy", "unverified_claims", "promotional_only"],

    // Quality-based skips
    minSeoScore: 20,
    minAeoScore: 20,
    minViralityScore: 10,
  },

  /**
   * Value Matrix Decision Logic
   */
  VALUE_MATRIX: {
    // High Value + Low Cost = Quick Win → Publish immediately
    quick_win: {
      condition: (value: string, cost: string) =>
        value === "high" && (cost === "low" || cost === "medium"),
      action: "publish_fast",
      priority: 1,
    },

    // High Value + High Cost = Strategic Investment → Deep analysis
    strategic_investment: {
      condition: (value: string, cost: string) => value === "high" && cost === "high",
      action: "deep_analysis",
      priority: 2,
    },

    // Low/Medium Value + Low Cost = Gap Filler → Publish if capacity
    gap_filler: {
      condition: (value: string, cost: string) =>
        (value === "low" || value === "medium") && cost === "low",
      action: "queue_for_capacity",
      priority: 3,
    },

    // Low Value + High Cost = Skip → Don't waste resources
    skip: {
      condition: (value: string, cost: string) => value === "low" && cost === "high",
      action: "skip",
      priority: 4,
    },
  },

  /**
   * Breaking News Detection Patterns
   */
  BREAKING_NEWS_PATTERNS: {
    keywords: [
      "breaking",
      "just announced",
      "emergency",
      "halted",
      "bankruptcy",
      "strike",
      "closure",
      "suspended",
      "cancelled",
      "major incident",
      "safety alert",
    ],
    sourceBoost: {
      // Sources that get credibility boost for breaking news
      reuters: 1.2,
      "associated press": 1.2,
      "official company statement": 1.3,
      "government agency": 1.3,
    },
    timeDecay: {
      // Score multiplier based on age
      "0-2h": 1,
      "2-6h": 0.9,
      "6-12h": 0.7,
      "12-24h": 0.5,
      "24h+": 0.3,
    },
  },

  /**
   * Mega Event Boost Logic
   * Add domain-relevant major events here to boost related items.
   */
  MEGA_EVENTS: [] as Array<{
    name: string;
    locations: string[];
    dates: { start: string; end: string };
    scoreBoost: number;
    relevanceKeywords: string[];
  }>,

  /**
   * LSH Deduplication Parameters
   */
  DEDUPLICATION: {
    algorithm: "LSH", // Locality Sensitive Hashing
    similarityThreshold: 0.85, // 85% = near-duplicate
    relatedThreshold: 0.6, // 60% = related content
    minHashFunctions: 128,
    bandSize: 8,
    checkWindow: 30, // days to check for duplicates
  },
};
