/**
 * SEO Content Standards Module
 *
 * Unified SEO requirements enforced across all content generation.
 * Domain-neutral — applies to whatever content domain the engine is configured for.
 */

import { SITE_NAME } from "../config/domain.js";

// SEO validation is currently disabled - awaiting redesign
export const SEO_VALIDATION_ENABLED = false;

// ============================================================================
// SEO REQUIREMENTS CONSTANTS
// ============================================================================

export const SEO_REQUIREMENTS = {
  metaTitle: {
    minLength: 50,
    maxLength: 60,
    description: "Meta title must be 50-60 characters for optimal SERP display",
  },
  metaDescription: {
    minLength: 150,
    maxLength: 160,
    description: "Meta description must be 150-160 characters for full display in search results",
  },
  h2Headers: {
    min: 4,
    max: 6,
    description: "Articles must have 4-6 H2 headers for proper content structure",
  },
  internalLinks: {
    min: 5,
    max: 8,
    description: "Content must include 5-8 internal links to other site pages",
  },
  externalLinks: {
    min: 2,
    max: 3,
    authoritative: [
      "reuters.com",
      "apnews.com",
      "bbc.com",
      "bloomberg.com",
      "ft.com",
      "nytimes.com",
      "gov.uk",
      "europa.eu",
      ".gov",
    ],
    description: "Include 2-3 external links to authoritative sources",
  },
  wordCount: {
    minimum: 1800,
    maximum: 3500,
    sectionMinimum: 300,
    sectionMaximum: 500,
    description: "Full articles must be 1800-3500 words, with 300-500 words per H2 section",
  },
  images: {
    heroRequired: false,
    perSection: 1,
    minTotal: 0,
    maxTotal: 12,
    description: "Optional: 1 hero image plus 1 image per H2 section",
  },
  altText: {
    minWords: 5,
    maxWords: 15,
    minChars: 20,
    maxChars: 125,
    description: "Alt text must be 5-15 words (20-125 chars), factual descriptions only",
  },
  keywordDensity: {
    primary: { min: 1, max: 2 },
    secondary: { min: 0.5, max: 1 },
    description: "Primary keyword 1-2% density, secondary keywords 0.5-1%",
  },
} as const;

// ============================================================================
// BANNED CLICHES AND CLICKBAIT PHRASES
// ============================================================================

export const BANNED_PHRASES = [
  // Overused cliches
  "must-see",
  "must see",
  "world-class",
  "world class",
  "hidden gem",
  "hidden gems",
  "breathtaking",
  "once-in-a-lifetime",
  "once in a lifetime",
  "like no other",
  "best-kept secret",
  "best kept secret",
  "awe-inspiring",
  "unforgettable experience",

  // Clickbait phrases
  "secret tips revealed",
  "you won't believe",
  "you wont believe",
  "jaw-dropping",
  "jaw dropping",
  "mind-blowing",
  "mind blowing",
  "ultimate guide",
  "the ultimate",
  "everything you need to know",
  "what they don't tell you",
  "what they dont tell you",
  "shocking truth",
  "insider secrets",
  "game-changer",
  "game changer",

  // Marketing superlatives
  "absolutely stunning",
  "truly magical",
  "simply amazing",
  "beyond compare",
  "unmatched",
  "unparalleled",
  "second to none",
  "one of a kind",
  "one-of-a-kind",
] as const;

// Professional alternatives mapping
export const PHRASE_ALTERNATIVES: Record<string, string[]> = {
  "must-see": ["widely recommended", "frequently cited", "notable"],
  "world-class": ["internationally recognized", "award-winning", "highly rated"],
  "hidden gem": ["lesser-known", "under-the-radar", "overlooked"],
  breathtaking: ["impressive", "remarkable", "striking", "notable"],
  "mind-blowing": ["impressive", "noteworthy", "remarkable"],
  "ultimate guide": ["comprehensive overview", "detailed guide", "complete resource"],
};

// ============================================================================
// CONTENT TYPE REQUIREMENTS
// ============================================================================

export const CONTENT_TYPE_REQUIREMENTS = {
  article: {
    minWords: 1800,
    maxWords: 3500,
    h2Count: { min: 4, max: 6 },
    internalLinks: { min: 5, max: 8 },
    externalLinks: { min: 2, max: 3 },
    imagesMin: 0,
    requiredSections: ["introduction", "main_content", "faqs", "conclusion"],
  },

  guide: {
    minWords: 2500,
    maxWords: 4500,
    h2Count: { min: 6, max: 8 },
    internalLinks: { min: 8, max: 12 },
    externalLinks: { min: 3, max: 5 },
    imagesMin: 0,
    requiredSections: ["overview", "main_content", "practical_info", "tips"],
  },

  review: {
    minWords: 800,
    maxWords: 1500,
    h2Count: { min: 3, max: 5 },
    internalLinks: { min: 3, max: 5 },
    externalLinks: { min: 1, max: 2 },
    imagesMin: 0,
    requiredSections: ["overview", "evaluation", "verdict"],
  },

  landing_page: {
    minWords: 600,
    maxWords: 1500,
    h2Count: { min: 3, max: 5 },
    internalLinks: { min: 4, max: 8 },
    externalLinks: { min: 1, max: 2 },
    imagesMin: 0,
    requiredSections: ["hero", "main_content", "cta"],
  },
} as const;

export type ContentType = keyof typeof CONTENT_TYPE_REQUIREMENTS;

// ============================================================================
// VALIDATION INTERFACES
// ============================================================================

export interface SEOValidationResult {
  isValid: boolean;
  score: number; // 0-100
  errors: SEOError[];
  warnings: SEOWarning[];
  suggestions: string[];
}

export interface SEOError {
  code: string;
  field: string;
  message: string;
  severity: "critical" | "error";
}

export interface SEOWarning {
  code: string;
  field: string;
  message: string;
  suggestion?: string;
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

export function validateMetaTitle(title: string): { valid: boolean; error?: string } {
  const length = title.trim().length;
  if (length < SEO_REQUIREMENTS.metaTitle.minLength) {
    return {
      valid: false,
      error: `Meta title too short (${length} chars). Minimum: ${SEO_REQUIREMENTS.metaTitle.minLength}`,
    };
  }
  if (length > SEO_REQUIREMENTS.metaTitle.maxLength) {
    return {
      valid: false,
      error: `Meta title too long (${length} chars). Maximum: ${SEO_REQUIREMENTS.metaTitle.maxLength}`,
    };
  }
  return { valid: true };
}

export function validateMetaDescription(description: string): { valid: boolean; error?: string } {
  const length = description.trim().length;
  if (length < SEO_REQUIREMENTS.metaDescription.minLength) {
    return {
      valid: false,
      error: `Meta description too short (${length} chars). Minimum: ${SEO_REQUIREMENTS.metaDescription.minLength}`,
    };
  }
  if (length > SEO_REQUIREMENTS.metaDescription.maxLength) {
    return {
      valid: false,
      error: `Meta description too long (${length} chars). Maximum: ${SEO_REQUIREMENTS.metaDescription.maxLength}`,
    };
  }
  return { valid: true };
}

export function validateWordCount(
  content: string,
  contentType: ContentType
): { valid: boolean; count: number; error?: string } {
  const words = content.split(/\s+/).filter(Boolean);
  const count = words.length;
  const requirements = CONTENT_TYPE_REQUIREMENTS[contentType];

  if (count < requirements.minWords) {
    return {
      valid: false,
      count,
      error: `Content too short (${count} words). Minimum for ${contentType}: ${requirements.minWords}`,
    };
  }
  if (count > requirements.maxWords) {
    return {
      valid: false,
      count,
      error: `Content too long (${count} words). Maximum for ${contentType}: ${requirements.maxWords}`,
    };
  }
  return { valid: true, count };
}

export function detectBannedPhrases(content: string): {
  found: string[];
  suggestions: Map<string, string[]>;
} {
  const lowerContent = content.toLowerCase();
  const found: string[] = [];
  const suggestions = new Map<string, string[]>();

  for (const phrase of BANNED_PHRASES) {
    if (lowerContent.includes(phrase.toLowerCase())) {
      found.push(phrase);
      const basePhrase = phrase.replaceAll("-", " ").toLowerCase();
      for (const [key, alternatives] of Object.entries(PHRASE_ALTERNATIVES)) {
        if (basePhrase.includes(key.replaceAll("-", " ").toLowerCase())) {
          suggestions.set(phrase, alternatives);
          break;
        }
      }
    }
  }

  return { found, suggestions };
}

export function countH2Headers(htmlContent: string): number {
  const h2Matches = htmlContent.match(/<h2[^>]*>/gi);
  return h2Matches ? h2Matches.length : 0;
}

export function countInternalLinks(htmlContent: string): number {
  // Match links that start with /
  const internalPattern = /<a[^>]*href=["']\/[^"']*["'][^>]*>/gi;
  const matches = htmlContent.match(internalPattern);
  return matches ? matches.length : 0;
}

export function analyzeExternalLinks(htmlContent: string): {
  count: number;
  authoritative: number;
  links: Array<{ url: string; isAuthoritative: boolean }>;
} {
  const externalPattern = /<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  const links: Array<{ url: string; isAuthoritative: boolean }> = [];
  let match;

  while ((match = externalPattern.exec(htmlContent)) !== null) {
    const url = match[1];
    const isAuthoritative = SEO_REQUIREMENTS.externalLinks.authoritative.some(domain =>
      url.includes(domain)
    );
    links.push({ url, isAuthoritative });
  }

  return {
    count: links.length,
    authoritative: links.filter(l => l.isAuthoritative).length,
    links,
  };
}

export function validateAltText(altText: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const words = altText.split(/\s+/).filter(Boolean);
  const charCount = altText.length;

  if (words.length < SEO_REQUIREMENTS.altText.minWords) {
    errors.push(
      `Alt text too short (${words.length} words). Minimum: ${SEO_REQUIREMENTS.altText.minWords}`
    );
  }
  if (words.length > SEO_REQUIREMENTS.altText.maxWords) {
    errors.push(
      `Alt text too long (${words.length} words). Maximum: ${SEO_REQUIREMENTS.altText.maxWords}`
    );
  }
  if (charCount < SEO_REQUIREMENTS.altText.minChars) {
    errors.push(
      `Alt text too short (${charCount} chars). Minimum: ${SEO_REQUIREMENTS.altText.minChars}`
    );
  }
  if (charCount > SEO_REQUIREMENTS.altText.maxChars) {
    errors.push(
      `Alt text too long (${charCount} chars). Maximum: ${SEO_REQUIREMENTS.altText.maxChars}`
    );
  }

  const bannedInAlt = ["stunning", "amazing", "beautiful", "breathtaking", "gorgeous", "spectacular"];
  for (const word of bannedInAlt) {
    if (altText.toLowerCase().includes(word)) {
      errors.push(`Alt text contains marketing language: "${word}". Use factual descriptions only.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function calculateKeywordDensity(content: string, keyword: string): number {
  const words = content.toLowerCase().split(/\s+/).filter(Boolean);
  const keywordLower = keyword.toLowerCase();
  const keywordWords = keywordLower.split(/\s+/);

  let count = 0;
  for (let i = 0; i <= words.length - keywordWords.length; i++) {
    const slice = words.slice(i, i + keywordWords.length).join(" ");
    if (slice === keywordLower) {
      count++;
    }
  }

  return (count / words.length) * 100;
}

// ============================================================================
// FULL CONTENT VALIDATION
// ============================================================================

interface ValidationAccumulator {
  errors: SEOError[];
  warnings: SEOWarning[];
  suggestions: string[];
  score: number;
}

function validateSEOMetaFields(
  content: { metaTitle: string; metaDescription: string; htmlContent: string },
  contentType: ContentType,
  acc: ValidationAccumulator
): void {
  const metaTitleResult = validateMetaTitle(content.metaTitle);
  if (!metaTitleResult.valid) {
    acc.errors.push({
      code: "META_TITLE",
      field: "metaTitle",
      message: metaTitleResult.error!,
      severity: "critical",
    });
    acc.score -= 15;
  }

  const metaDescResult = validateMetaDescription(content.metaDescription);
  if (!metaDescResult.valid) {
    acc.errors.push({
      code: "META_DESC",
      field: "metaDescription",
      message: metaDescResult.error!,
      severity: "critical",
    });
    acc.score -= 15;
  }

  const wordCountResult = validateWordCount(
    content.htmlContent.replaceAll(/<[^>]+>/g, " "),
    contentType
  );
  if (!wordCountResult.valid) {
    acc.errors.push({
      code: "WORD_COUNT",
      field: "content",
      message: wordCountResult.error!,
      severity: "error",
    });
    acc.score -= 10;
  }
}

function validateSEOStructure(
  htmlContent: string,
  requirements: (typeof CONTENT_TYPE_REQUIREMENTS)[ContentType],
  acc: ValidationAccumulator
): void {
  const h2Count = countH2Headers(htmlContent);
  if (h2Count < requirements.h2Count.min) {
    acc.errors.push({
      code: "H2_COUNT",
      field: "headers",
      message: `Not enough H2 headers (${h2Count}). Minimum: ${requirements.h2Count.min}`,
      severity: "error",
    });
    acc.score -= 10;
  } else if (h2Count > requirements.h2Count.max) {
    acc.warnings.push({
      code: "H2_COUNT",
      field: "headers",
      message: `Too many H2 headers (${h2Count}). Maximum: ${requirements.h2Count.max}`,
    });
    acc.score -= 5;
  }

  const internalLinkCount = countInternalLinks(htmlContent);
  if (internalLinkCount < requirements.internalLinks.min) {
    acc.errors.push({
      code: "INTERNAL_LINKS",
      field: "links",
      message: `Not enough internal links (${internalLinkCount}). Minimum: ${requirements.internalLinks.min}`,
      severity: "error",
    });
    acc.score -= 10;
    acc.suggestions.push(
      `Add ${requirements.internalLinks.min - internalLinkCount} more internal links to related pages`
    );
  }

  const externalLinks = analyzeExternalLinks(htmlContent);
  if (externalLinks.count < requirements.externalLinks.min) {
    acc.warnings.push({
      code: "EXTERNAL_LINKS",
      field: "links",
      message: `Not enough external links (${externalLinks.count}). Minimum: ${requirements.externalLinks.min}`,
      suggestion: "Add links to authoritative sources",
    });
    acc.score -= 5;
  }
  if (externalLinks.authoritative === 0 && externalLinks.count > 0) {
    acc.warnings.push({
      code: "AUTHORITATIVE_LINKS",
      field: "links",
      message: "No links to authoritative sources found",
      suggestion: "Include links to official or widely trusted sources",
    });
    acc.score -= 3;
  }
}

function validateSEOBannedPhrases(htmlContent: string, acc: ValidationAccumulator): void {
  const bannedPhrases = detectBannedPhrases(htmlContent);
  for (const phrase of bannedPhrases.found) {
    const alternatives = bannedPhrases.suggestions.get(phrase);
    acc.errors.push({
      code: "BANNED_PHRASE",
      field: "content",
      message: `Banned phrase detected: "${phrase}"`,
      severity: "error",
    });
    if (alternatives) {
      acc.suggestions.push(`Replace "${phrase}" with: ${alternatives.join(", ")}`);
    }
  }
  acc.score -= bannedPhrases.found.length * 3;
}

export function validateContent(
  content: {
    title: string;
    metaTitle: string;
    metaDescription: string;
    htmlContent: string;
    primaryKeyword?: string;
    altTexts?: string[];
  },
  contentType: ContentType
): SEOValidationResult {
  if (!SEO_VALIDATION_ENABLED) {
    return { isValid: true, score: 100, errors: [], warnings: [], suggestions: [] };
  }

  const acc: ValidationAccumulator = { errors: [], warnings: [], suggestions: [], score: 100 };
  const requirements = CONTENT_TYPE_REQUIREMENTS[contentType];

  validateSEOMetaFields(content, contentType, acc);
  validateSEOStructure(content.htmlContent, requirements, acc);
  validateSEOBannedPhrases(content.htmlContent, acc);

  if (content.altTexts) {
    for (let i = 0; i < content.altTexts.length; i++) {
      const altResult = validateAltText(content.altTexts[i]);
      if (!altResult.valid) {
        acc.warnings.push({
          code: "ALT_TEXT",
          field: `image_${i}`,
          message: altResult.errors.join("; "),
        });
        acc.score -= 2;
      }
    }
  }

  if (content.primaryKeyword) {
    const density = calculateKeywordDensity(
      content.htmlContent.replaceAll(/<[^>]+>/g, " "),
      content.primaryKeyword
    );
    if (density < SEO_REQUIREMENTS.keywordDensity.primary.min) {
      acc.warnings.push({
        code: "KEYWORD_DENSITY",
        field: "keyword",
        message: `Primary keyword density too low (${density.toFixed(2)}%). Target: 1-2%`,
      });
      acc.score -= 5;
    } else if (density > SEO_REQUIREMENTS.keywordDensity.primary.max) {
      acc.warnings.push({
        code: "KEYWORD_STUFFING",
        field: "keyword",
        message: `Primary keyword density too high (${density.toFixed(2)}%). Maximum: 2%`,
      });
      acc.score -= 5;
    }
  }

  acc.score = Math.max(0, acc.score);

  return {
    isValid: acc.errors.filter(e => e.severity === "critical").length === 0 && acc.score >= 80,
    score: acc.score,
    errors: acc.errors,
    warnings: acc.warnings,
    suggestions: acc.suggestions,
  };
}

/**
 * Generate SEO-optimized meta title
 */
export function generateMetaTitle(title: string, context?: string): string {
  let metaTitle = title;

  if (context && metaTitle.length < 45) {
    metaTitle = `${metaTitle} | ${context}`;
  }

  if (metaTitle.length > SEO_REQUIREMENTS.metaTitle.maxLength) {
    metaTitle = metaTitle.substring(0, SEO_REQUIREMENTS.metaTitle.maxLength - 3) + "...";
  }

  if (metaTitle.length < SEO_REQUIREMENTS.metaTitle.minLength) {
    metaTitle = `${metaTitle} | ${SITE_NAME}`;
  }

  return metaTitle.substring(0, SEO_REQUIREMENTS.metaTitle.maxLength);
}

/**
 * Generate SEO-optimized meta description
 */
export function generateMetaDescription(description: string, includesCTA: boolean = true): string {
  let metaDesc = description.trim();

  if (includesCTA && metaDesc.length < 140) {
    metaDesc += " Read the full story.";
  }

  if (metaDesc.length > SEO_REQUIREMENTS.metaDescription.maxLength) {
    const shortened = metaDesc.substring(0, SEO_REQUIREMENTS.metaDescription.maxLength - 3);
    const lastPeriod = shortened.lastIndexOf(".");
    if (lastPeriod > SEO_REQUIREMENTS.metaDescription.minLength - 10) {
      metaDesc = shortened.substring(0, lastPeriod + 1);
    } else {
      metaDesc = shortened + "...";
    }
  }

  return metaDesc;
}
