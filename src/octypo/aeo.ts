/**
 * AEO (Answer Engine Optimization) module.
 *
 * Deterministic JSON-LD generation + answer-capsule/FAQ-content validation for every
 * article the pipeline produces (and for manual drafts via the admin QA flow).
 * Domain-neutral: identity comes from SITE_NAME / SITE_URL / ARTICLE_PATH_PREFIX.
 */

import { SITE_NAME, SITE_URL } from "../config/domain.js";
import type { FAQ } from "./types.js";

/** Public path prefix articles are served under on the consuming site. */
export const ARTICLE_PATH_PREFIX: string = (process.env.ARTICLE_PATH_PREFIX || "/guides").replace(
  /\/$/,
  ""
);

export interface AnswerCapsule {
  question: string;
  directAnswer: string;
  supportingDetails: string;
  fullAnswer: string;
  wordCount: number;
}

export interface AEOScore {
  answerCapsuleScore: number;
  schemaScore: number;
  faqScore: number;
  overallScore: number;
  issues: string[];
  suggestions: string[];
}

/**
 * Where a given article actually lives on the public web.
 *
 * This used to be process-wide, read from env at module load, which meant every
 * article the engine ever wrote claimed whichever domain the process happened
 * to be configured for. On a multi-tenant engine that puts tenant A's host into
 * tenant B's canonical signals — Google drops the page, nothing errors, and the
 * customer just never ranks. Identity has to travel with the article.
 */
export interface SiteIdentity {
  siteUrl: string | null;
  siteName: string;
  articlePathPrefix: string;
}

/** The single-tenant identity from env — the fallback for callers not yet tenant-aware. */
export function defaultSiteIdentity(): SiteIdentity {
  return { siteUrl: SITE_URL, siteName: SITE_NAME, articlePathPrefix: ARTICLE_PATH_PREFIX };
}

function normalisePrefix(prefix: string): string {
  const trimmed = (prefix || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface ArticleSchemaInput {
  title: string;
  description: string;
  slug: string;
  publishedAt?: Date | null;
  modifiedAt?: Date | null;
  authorName?: string | null;
  heroImage?: string | null;
  faqs?: FAQ[];
  /** Procedure steps, when the article is a how-to with a real numbered list. */
  steps?: string[];
  /** The tenant this article belongs to. Omitted means "the process identity". */
  site?: SiteIdentity;
}

function articleUrl(slug: string, site: SiteIdentity): string | undefined {
  return site.siteUrl ? `${site.siteUrl}${normalisePrefix(site.articlePathPrefix)}/${slug}` : undefined;
}

// ============================================================================
// Answer capsules — the 40-60 word direct answers that answer engines quote
// ============================================================================

export class AnswerCapsuleGenerator {
  generateCapsule(question: string, fullAnswer: string): AnswerCapsule {
    const sentences = fullAnswer.match(/[^.!?]+[.!?]+/g) || [fullAnswer];
    const directAnswer = sentences[0]?.trim() || fullAnswer.substring(0, 100);
    const supportingDetails = sentences.slice(1).join(" ").trim();

    return {
      question,
      directAnswer,
      supportingDetails,
      fullAnswer,
      wordCount: fullAnswer.split(/\s+/).filter(w => w.length > 0).length,
    };
  }

  validateCapsule(capsule: AnswerCapsule): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (capsule.wordCount < 35) {
      issues.push(`Answer too short: ${capsule.wordCount} words (need 35-70, target 40-60)`);
    } else if (capsule.wordCount > 70) {
      issues.push(`Answer too long: ${capsule.wordCount} words (need 35-70, target 40-60)`);
    }

    const hedgingPhrases = ["it depends", "generally", "usually", "typically", "often"];
    const startsWithHedge = hedgingPhrases.some(phrase =>
      capsule.directAnswer.toLowerCase().startsWith(phrase)
    );
    if (startsWithHedge) {
      issues.push("Answer should start with a direct answer, not hedging");
    }

    return { valid: issues.length === 0, issues };
  }

  processFAQs(faqs: FAQ[]): AnswerCapsule[] {
    return faqs.map(faq => this.generateCapsule(faq.question, faq.answer));
  }
}

// ============================================================================
// JSON-LD schema — Article + BreadcrumbList
// ============================================================================

export class SchemaGenerator {
  generateArticleSchema(input: ArticleSchemaInput): Record<string, unknown> {
    const site = input.site ?? defaultSiteIdentity();
    const url = articleUrl(input.slug, site);
    return {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: input.title,
      description: input.description,
      ...(url && { mainEntityOfPage: { "@type": "WebPage", "@id": url }, url }),
      ...(input.heroImage && { image: [input.heroImage] }),
      ...(input.publishedAt && { datePublished: input.publishedAt.toISOString() }),
      ...((input.modifiedAt || input.publishedAt) && {
        dateModified: (input.modifiedAt || input.publishedAt)!.toISOString(),
      }),
      author: {
        "@type": "Person",
        name: input.authorName || `${site.siteName} Editorial`,
      },
      publisher: {
        "@type": "Organization",
        name: site.siteName,
        ...(site.siteUrl && { url: site.siteUrl }),
      },
    };
  }

  generateBreadcrumbSchema(input: ArticleSchemaInput): Record<string, unknown> | null {
    const site = input.site ?? defaultSiteIdentity();
    if (!site.siteUrl) return null;
    const prefix = normalisePrefix(site.articlePathPrefix);
    const sectionName =
      prefix.replace(/^\//, "").replace(/-/g, " ").replace(/^\w/, c => c.toUpperCase()) || "Articles";
    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: site.siteUrl },
        {
          "@type": "ListItem",
          position: 2,
          name: sectionName,
          item: `${site.siteUrl}${prefix}`,
        },
        { "@type": "ListItem", position: 3, name: input.title },
      ],
    };
  }

  /**
   * HowTo — for a genuine procedure only. Answer engines surface step lists
   * for "how do I" queries, and the steps must mirror the visible numbered
   * list exactly: schema that says more than the page is a penalty, not a win.
   */
  generateHowToSchema(input: ArticleSchemaInput): Record<string, unknown> | null {
    const steps = (input.steps ?? []).map((step) => step.replace(/<[^>]+>/g, "").trim()).filter(Boolean);
    if (steps.length < 3) return null;
    return {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: input.title,
      description: input.description,
      step: steps.map((text, index) => ({
        "@type": "HowToStep",
        position: index + 1,
        text,
      })),
    };
  }

  /**
   * Full JSON-LD payload for an article page.
   *
   * Visible FAQs and procedures remain useful content, but FAQPage and HowTo
   * are not current Google rich-result features for an ordinary commercial
   * publisher. Keeping the graph to Article + BreadcrumbList avoids stale
   * feature markup and prevents editorial FAQs from being mistaken for a
   * technical shortcut.
   */
  generateFullSchema(input: ArticleSchemaInput): Record<string, unknown>[] {
    const schemas: (Record<string, unknown> | null)[] = [
      this.generateArticleSchema(input),
      this.generateBreadcrumbSchema(input),
    ];
    return schemas.filter((s): s is Record<string, unknown> => s !== null);
  }
}

// ============================================================================
// Validator — scores capsule + schema + FAQs into one AEO score
// ============================================================================

export class AEOValidator {
  private readonly capsuleGenerator = new AnswerCapsuleGenerator();

  validate(input: {
    answerCapsule?: string | null;
    faqs: FAQ[];
    schemas: Record<string, unknown>[];
  }): AEOScore {
    const issues: string[] = [];
    const suggestions: string[] = [];

    const answerCapsuleScore = this.scoreCapsule(input.answerCapsule, issues);
    const schemaScore = this.scoreSchemas(input.schemas, issues);
    const faqScore = this.scoreFAQs(input.faqs, issues, suggestions);

    const overallScore = Math.round(
      Math.max(0, Math.min(100, answerCapsuleScore)) * 0.4 +
        Math.max(0, Math.min(100, schemaScore)) * 0.3 +
        Math.max(0, Math.min(100, faqScore)) * 0.3
    );

    return {
      answerCapsuleScore: Math.max(0, Math.min(100, answerCapsuleScore)),
      schemaScore: Math.max(0, Math.min(100, schemaScore)),
      faqScore: Math.max(0, Math.min(100, faqScore)),
      overallScore,
      issues,
      suggestions,
    };
  }

  private scoreCapsule(answerCapsule: string | null | undefined, issues: string[]): number {
    if (!answerCapsule) {
      issues.push("Missing answer capsule (the 40-60 word direct answer)");
      return 0;
    }
    const capsule = this.capsuleGenerator.generateCapsule("", answerCapsule);
    const validation = this.capsuleGenerator.validateCapsule(capsule);
    if (!validation.valid) {
      issues.push(...validation.issues);
      return 100 - validation.issues.length * 15;
    }
    return 100;
  }

  private scoreSchemas(schemas: Record<string, unknown>[], issues: string[]): number {
    if (!schemas || schemas.length === 0) {
      issues.push("Missing JSON-LD schema payload");
      return 0;
    }
    let score = 100;
    for (const schema of schemas) {
      if (!schema["@type"]) {
        issues.push("Schema entry missing @type");
        score -= 20;
      }
      if (!schema["@context"]) {
        issues.push("Schema entry missing @context");
        score -= 20;
      }
    }
    if (schemas.some(s => s["@type"] === "FAQPage" || s["@type"] === "HowTo")) {
      issues.push("Legacy FAQPage or HowTo schema should be removed; keep the visible content");
      score -= 15;
    }
    return score;
  }

  private scoreFAQs(faqs: FAQ[], issues: string[], suggestions: string[]): number {
    if (!faqs || faqs.length === 0) return 100;
    let score = 100;
    for (let i = 0; i < faqs.length; i++) {
      const faq = faqs[i];
      if (!faq.question.endsWith("?")) {
        issues.push(`FAQ ${i + 1} question should end with ?`);
        score -= 5;
      }
      if (faq.answer.length < 100) {
        suggestions.push(`FAQ ${i + 1} answer could be more comprehensive`);
      }
    }
    return score;
  }
}

export const answerCapsuleGenerator = new AnswerCapsuleGenerator();
export const schemaGenerator = new SchemaGenerator();
export const aeoValidator = new AEOValidator();
