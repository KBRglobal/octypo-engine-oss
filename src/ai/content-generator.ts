/**
 * Centralized AI Content Generator Service
 *
 * Unified content generation that enforces SEO standards across all content types.
 * Uses the unified AI provider system with automatic fallback.
 * Domain-neutral — steered by CONTENT_DOMAIN and the configured topics.
 */

import { createLogger } from "../lib/logger.js";
import { getAllUnifiedProviders, markProviderFailed, type AIMessage } from "./providers.js";
import {
  SEO_REQUIREMENTS,
  CONTENT_TYPE_REQUIREMENTS,
  BANNED_PHRASES,
  validateContent,
  generateMetaTitle,
  generateMetaDescription,
  type ContentType,
  type SEOValidationResult,
} from "../lib/seo-standards.js";
import { topics, type Topic } from "../config/topics.js";
import { CONTENT_DOMAIN, SITE_NAME } from "../config/domain.js";

const logger = createLogger("content-generator");

// ============================================================================
// TOPIC KEYWORD HELPERS
// ============================================================================

/**
 * Find relevant keywords for a given topic from the configured topics.
 * Returns keywords to help the AI use SEO-optimized terminology.
 */
function findRelevantTopicKeywords(topicText: string): {
  relatedTopics: Topic[];
  suggestedKeywords: string[];
  categoryHint: string;
} {
  const topicLower = topicText.toLowerCase();

  const matchingTopics = topics.filter(
    t =>
      topicLower.includes(t.name.toLowerCase()) ||
      topicLower.includes(t.slug.toLowerCase()) ||
      t.keywords.some(k => topicLower.includes(k.toLowerCase()))
  );

  const suggestedKeywords: string[] = [];
  for (const t of matchingTopics.slice(0, 5)) {
    suggestedKeywords.push(...t.keywords);
  }

  return {
    relatedTopics: matchingTopics.slice(0, 5),
    suggestedKeywords: [...new Set(suggestedKeywords)].slice(0, 15),
    categoryHint: matchingTopics[0]?.name || "",
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface GeneratedContent {
  title: string;
  metaTitle: string;
  metaDescription: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  content: ContentSection[];
  faqs: FAQ[];
  seoValidation: SEOValidationResult;
  wordCount: number;
  provider: string;
  model: string;
  openingParagraph?: string;
  tips?: string[];
}

export interface ContentSection {
  heading: string; // H2 heading
  content: string; // Paragraph content (HTML)
  imageHint?: string; // Suggested image search term
}

export interface FAQ {
  question: string;
  answer: string;
}

export interface GenerationOptions {
  contentType: ContentType;
  topic: string;
  /** Topic context, e.g. a configured topic name or audience segment */
  topicContext?: string;
  targetKeyword?: string;
  additionalContext?: string;
  minSections?: number;
  maxSections?: number;
  writerPersonality?: string;
}

// ============================================================================
// PROMPT TEMPLATES
// ============================================================================

function buildSystemPrompt(contentType: ContentType, writerPersonality?: string): string {
  const requirements = CONTENT_TYPE_REQUIREMENTS[contentType];
  const bannedList = BANNED_PHRASES.slice(0, 20).join('", "');

  let personalitySection = "";
  if (writerPersonality) {
    personalitySection = `\n\nWRITING STYLE:
You are writing with this personality: ${writerPersonality}
Adapt your tone, vocabulary, and approach to match this personality while maintaining professionalism.`;
  }

  return `You are a professional content writer for ${SITE_NAME}, a premium publication covering ${CONTENT_DOMAIN}.

CRITICAL SEO REQUIREMENTS (MUST FOLLOW):
1. Meta title: EXACTLY ${SEO_REQUIREMENTS.metaTitle.minLength}-${SEO_REQUIREMENTS.metaTitle.maxLength} characters
2. Meta description: EXACTLY ${SEO_REQUIREMENTS.metaDescription.minLength}-${SEO_REQUIREMENTS.metaDescription.maxLength} characters
3. Word count: ${requirements.minWords}-${requirements.maxWords} words total
4. H2 sections: ${requirements.h2Count.min}-${requirements.h2Count.max} sections
5. Each section: ${SEO_REQUIREMENTS.wordCount.sectionMinimum}-${SEO_REQUIREMENTS.wordCount.sectionMaximum} words

BANNED PHRASES (NEVER USE):
"${bannedList}"
Instead use professional alternatives like "widely used", "internationally recognized", "notable", "impressive"

CONTENT GUIDELINES:
- Use factual, accurate information only
- Include practical tips and specific details
- Mention concrete numbers, dates and names where relevant
- Write for an international audience
- Avoid marketing hype and superlatives
- Include natural opportunities for internal linking${personalitySection}

OUTPUT FORMAT:
Respond ONLY with valid JSON matching the specified structure. No markdown, no extra text.`;
}

function buildContentPrompt(options: GenerationOptions): string {
  const requirements = CONTENT_TYPE_REQUIREMENTS[options.contentType];
  const sectionCount = options.minSections || requirements.h2Count.min;

  let contextSection = "";
  if (options.topicContext) {
    contextSection = `\nTOPIC CONTEXT: This content is about ${options.topicContext}. Include topic-specific information.`;
  }

  let keywordContext = "";
  if (options.targetKeyword) {
    keywordContext = `\nPRIMARY KEYWORD: "${options.targetKeyword}" - Use this naturally 1-2% throughout the content.`;
  }

  // Find relevant configured-topic keywords for SEO optimization
  let topicKeywordContext = "";
  const topicKeywords = findRelevantTopicKeywords(
    `${options.topic} ${options.topicContext || ""}`
  );
  if (topicKeywords.suggestedKeywords.length > 0) {
    topicKeywordContext = `\nSEO KEYWORD SUGGESTIONS: Consider naturally incorporating these topic-relevant terms: ${topicKeywords.suggestedKeywords.slice(0, 8).join(", ")}`;
    if (topicKeywords.categoryHint) {
      topicKeywordContext += `\nCONTENT CATEGORY: ${topicKeywords.categoryHint}`;
    }
  }

  return `Generate comprehensive ${options.contentType} content about: ${options.topic}
${contextSection}${keywordContext}${topicKeywordContext}
${options.additionalContext ? `\nADDITIONAL CONTEXT: ${options.additionalContext}` : ""}

Generate JSON with this EXACT structure:
{
  "title": "string - compelling article title (40-70 chars)",
  "metaTitle": "string - SEO title (EXACTLY 50-60 chars)",
  "metaDescription": "string - SEO description (EXACTLY 150-160 chars)",
  "primaryKeyword": "string - main SEO keyword",
  "secondaryKeywords": ["string", "string", "string"],
  "sections": [
    {
      "heading": "string - H2 heading for this section",
      "content": "string - ${SEO_REQUIREMENTS.wordCount.sectionMinimum}-${SEO_REQUIREMENTS.wordCount.sectionMaximum} words of informative content as HTML paragraphs",
      "imageHint": "string - suggested image search term for this section"
    }
  ],
  "faqs": [
    {
      "question": "string - common question readers ask",
      "answer": "string - helpful, accurate answer (50-100 words)"
    }
  ]
}

REQUIREMENTS:
- Generate EXACTLY ${sectionCount} sections
- Generate 4-6 FAQs
- Total word count: ${requirements.minWords}-${requirements.maxWords} words
- Each section must be ${SEO_REQUIREMENTS.wordCount.sectionMinimum}-${SEO_REQUIREMENTS.wordCount.sectionMaximum} words
- Use real, verifiable information
- Include specific details (figures, dates, names)
- NO banned phrases or marketing cliches

Respond with JSON ONLY.`;
}

// ============================================================================
// CONTENT GENERATION
// ============================================================================

/**
 * Generate content using AI with SEO validation
 */
export async function generateContent(options: GenerationOptions): Promise<GeneratedContent> {
  const providers = getAllUnifiedProviders();

  if (providers.length === 0) {
    throw new Error("No AI providers available for content generation");
  }

  const systemPrompt = buildSystemPrompt(options.contentType, options.writerPersonality);
  const userPrompt = buildContentPrompt(options);

  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  let lastError: Error | null = null;

  for (const provider of providers) {
    try {
      logger.info(
        `Generating ${options.contentType} content for "${options.topic}" using ${provider.name}`
      );

      const result = await provider.generateCompletion({
        messages,
        temperature: 0.7,
        maxTokens: 8000,
        responseFormat: { type: "json_object" },
      });

      // Parse and validate the response
      const content = parseAndValidateResponse(result.content, options);

      logger.info(
        `Successfully generated content using ${provider.name}: ${content.wordCount} words, SEO score: ${content.seoValidation.score}`
      );

      return {
        ...content,
        provider: provider.name,
        model: result.model,
      };
    } catch (error) {
      logger.warn(
        { error: String(error) },
        `Provider ${provider.name} failed for content generation`
      );
      markProviderFailed(provider.name);
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
  }

  throw lastError || new Error("All AI providers failed to generate content");
}

/**
 * Parse AI response and validate against SEO standards
 */
function parseAndValidateResponse(
  responseContent: string,
  options: GenerationOptions
): Omit<GeneratedContent, "provider" | "model"> {
  // Clean up response
  let jsonStr = responseContent.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
  } else if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```\n?/, "").replace(/\n?```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`Failed to parse AI response as JSON: ${e}`);
  }

  // Extract and structure content
  const sections: ContentSection[] = (parsed.sections || []).map(
    (s: { heading?: string; content?: string; imageHint?: string }) => ({
      heading: s.heading || "",
      content: s.content || "",
      imageHint: s.imageHint,
    })
  );

  const faqs: FAQ[] = (parsed.faqs || []).map((f: { question?: string; answer?: string }) => ({
    question: f.question || "",
    answer: f.answer || "",
  }));

  // Build HTML content for validation
  let htmlContent = "";
  for (const section of sections) {
    htmlContent += `<h2>${section.heading}</h2>\n${section.content}\n`;
  }

  // Calculate word count
  const textContent = htmlContent.replaceAll(/<[^>]+>/g, " ");
  const wordCount = textContent.split(/\s+/).filter(Boolean).length;

  // Generate proper meta title and description if they don't meet requirements
  let metaTitle = parsed.metaTitle || generateMetaTitle(parsed.title, options.topicContext);
  let metaDescription = parsed.metaDescription || generateMetaDescription(parsed.title);

  // Fix meta title length if needed
  if (
    metaTitle.length < SEO_REQUIREMENTS.metaTitle.minLength ||
    metaTitle.length > SEO_REQUIREMENTS.metaTitle.maxLength
  ) {
    metaTitle = generateMetaTitle(parsed.title, options.topicContext);
  }

  // Fix meta description length if needed
  if (
    metaDescription.length < SEO_REQUIREMENTS.metaDescription.minLength ||
    metaDescription.length > SEO_REQUIREMENTS.metaDescription.maxLength
  ) {
    metaDescription = generateMetaDescription(parsed.title);
  }

  // Validate content against SEO standards
  const seoValidation = validateContent(
    {
      title: parsed.title || options.topic,
      metaTitle,
      metaDescription,
      htmlContent,
      primaryKeyword: parsed.primaryKeyword,
    },
    options.contentType
  );

  const openingParagraph = parsed.openingParagraph;
  const tips = Array.isArray(parsed.tips) ? (parsed.tips as string[]) : undefined;

  return {
    title: parsed.title || options.topic,
    metaTitle,
    metaDescription,
    primaryKeyword: parsed.primaryKeyword || options.targetKeyword || options.topic,
    secondaryKeywords: parsed.secondaryKeywords || [],
    content: sections,
    faqs,
    seoValidation,
    wordCount,
    openingParagraph,
    tips,
  };
}

// ============================================================================
// CONTENT IMPROVEMENT
// ============================================================================

/**
 * Improve content that failed SEO validation
 */
export async function improveContent(
  content: GeneratedContent,
  targetScore: number = 80
): Promise<GeneratedContent> {
  if (content.seoValidation.score >= targetScore) {
    return content;
  }

  const providers = getAllUnifiedProviders();
  if (providers.length === 0) {
    throw new Error("No AI providers available");
  }

  const issues = [
    ...content.seoValidation.errors.map(e => e.message),
    ...content.seoValidation.warnings.map(w => w.message),
  ].join("\n- ");

  const messages: AIMessage[] = [
    {
      role: "system",
      content: `You are an SEO content editor. Fix the following issues in the content while preserving accuracy and readability.

ISSUES TO FIX:
- ${issues}

Return the improved content in the same JSON structure, with all issues resolved.`,
    },
    {
      role: "user",
      content: `Current content:
${JSON.stringify(
  {
    title: content.title,
    metaTitle: content.metaTitle,
    metaDescription: content.metaDescription,
    sections: content.content,
    faqs: content.faqs,
  },
  null,
  2
)}

Fix all SEO issues and return improved JSON.`,
    },
  ];

  for (const provider of providers) {
    try {
      const result = await provider.generateCompletion({
        messages,
        temperature: 0.5,
        maxTokens: 8000,
        responseFormat: { type: "json_object" },
      });

      const improved = parseAndValidateResponse(result.content, {
        contentType: "article",
        topic: content.title,
      });

      if (improved.seoValidation.score > content.seoValidation.score) {
        return {
          ...improved,
          provider: provider.name,
          model: result.model,
        };
      }
    } catch (error) {
      logger.warn(
        { error: String(error) },
        `Provider ${provider.name} failed for content improvement`
      );
      continue;
    }
  }

  return content;
}

// ============================================================================
// SPECIALIZED GENERATORS
// ============================================================================

/**
 * Generate article content
 */
export async function generateArticleContent(
  topic: string,
  options?: {
    topicContext?: string;
    targetKeyword?: string;
    writerPersonality?: string;
    additionalContext?: string;
  }
): Promise<GeneratedContent> {
  return await generateContent({
    contentType: "article",
    topic,
    topicContext: options?.topicContext,
    targetKeyword: options?.targetKeyword,
    writerPersonality: options?.writerPersonality,
    additionalContext: options?.additionalContext,
    minSections: 4,
    maxSections: 6,
  });
}

/**
 * Generate listicle content (Top X articles)
 */
export async function generateListicleContent(
  topic: string,
  count: number = 10,
  options?: {
    topicContext?: string;
    targetKeyword?: string;
    writerPersonality?: string;
  }
): Promise<GeneratedContent> {
  return await generateContent({
    contentType: "article",
    topic: `Top ${count} ${topic}`,
    topicContext: options?.topicContext,
    targetKeyword: options?.targetKeyword || topic,
    writerPersonality: options?.writerPersonality,
    minSections: Math.min(count + 2, 12),
    maxSections: Math.min(count + 4, 14),
  });
}

/**
 * Generate comparison content (A vs B)
 */
export async function generateComparisonContent(
  optionA: string,
  optionB: string,
  options?: {
    topicContext?: string;
    writerPersonality?: string;
  }
): Promise<GeneratedContent> {
  return await generateContent({
    contentType: "article",
    topic: `${optionA} vs ${optionB}`,
    topicContext: options?.topicContext,
    targetKeyword: `${optionA} vs ${optionB}`,
    writerPersonality: options?.writerPersonality,
    minSections: 4,
    maxSections: 6,
  });
}

// ============================================================================
// CONTENT VALIDATION HELPERS
// ============================================================================

/**
 * Check if content meets minimum quality threshold
 */
export function meetsQualityThreshold(content: GeneratedContent, minScore: number = 80): boolean {
  return (
    content.seoValidation.score >= minScore &&
    content.seoValidation.errors.filter(e => e.severity === "critical").length === 0
  );
}

/**
 * Get improvement suggestions for content
 */
export function getImprovementSuggestions(content: GeneratedContent): string[] {
  const suggestions: string[] = [...content.seoValidation.suggestions];

  // Add word count suggestions
  const requirements = CONTENT_TYPE_REQUIREMENTS.article;
  if (content.wordCount < requirements.minWords) {
    suggestions.push(
      `Add ${requirements.minWords - content.wordCount} more words to meet minimum word count`
    );
  }

  // Add section suggestions
  if (content.content.length < requirements.h2Count.min) {
    suggestions.push(`Add ${requirements.h2Count.min - content.content.length} more H2 sections`);
  }

  return suggestions;
}
