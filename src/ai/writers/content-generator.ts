/**
 * AI Writers Content Generator
 * Wrapper around the main content generator with a simplified interface
 */

import { generateContent, type GeneratedContent } from "../content-generator.js";
import type { ContentType } from "../../lib/seo-standards.js";

export interface WriterGenerateOptions {
  writerId?: string;
  contentType: string;
  topic: string;
  keywords?: string[];
  locale?: string;
  length?: "short" | "medium" | "long";
  tone?: string;
  targetAudience?: string;
  additionalContext?: string;
}

export const aiWritersContentGenerator = {
  async generate(options: WriterGenerateOptions): Promise<GeneratedContent> {
    const { contentType, topic, keywords = [], additionalContext, length = "medium" } = options;

    // Map length to section count
    const sectionConfig = {
      short: { min: 3, max: 5 },
      medium: { min: 5, max: 8 },
      long: { min: 8, max: 12 },
    };

    const { min, max } = sectionConfig[length] || sectionConfig.medium;

    return await generateContent({
      contentType: contentType as ContentType,
      topic,
      targetKeyword: keywords[0],
      additionalContext: (() => {
        if (additionalContext) return `${additionalContext}. Keywords: ${keywords.join(", ")}`;
        if (keywords.length > 0) return `Keywords: ${keywords.join(", ")}`;
        return undefined;
      })(),
      minSections: min,
      maxSections: max,
    });
  },
};
