/**
 * Internal Linking Engine
 *
 * Automatically inserts relevant internal links between content pages.
 * Ensures proper SEO link structure with 5-8 internal links per article.
 *
 * Link targets come from two sources:
 * - The configured topics (src/config/topics.ts) → /topics/<slug> pages
 * - Published content loaded from the database (cached for 10 minutes)
 */

import { createLogger } from "../lib/logger.js";
import { CONTENT_TYPE_REQUIREMENTS, type ContentType } from "../lib/seo-standards.js";
import { topics } from "../config/topics.js";
import { siteLinks } from "../config/domain.js";
import { db } from "../db.js";
import { contents } from "../schema/index.js";
import { eq, and, isNotNull } from "drizzle-orm";

const logger = createLogger("internal-linking");

/**
 * Escape special regex characters to prevent ReDoS when building RegExp from content data
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Cache for database-loaded content
let dbLinksCache: LinkableContent[] = [];
let dbLinksCacheTime = 0;
const DB_LINKS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// TYPES
// ============================================================================

export interface LinkableContent {
  id: string;
  type: ContentType | "landing" | "topic";
  slug: string;
  title: string;
  topic?: string;
  keywords?: string[];
  category?: string;
}

export interface InternalLink {
  url: string;
  anchorText: string;
  relevanceScore: number;
  targetId: string;
  targetType: string;
}

export interface LinkingResult {
  content: string; // Content with links inserted
  linksAdded: number;
  links: InternalLink[];
}

// ============================================================================
// CONFIGURED LINK TARGETS (from topics config)
// ============================================================================

function topicLinkTargets(): LinkableContent[] {
  const fromTopics: LinkableContent[] = topics.map(t => ({
    id: `topic-${t.slug}`,
    type: "topic" as const,
    slug: `/topics/${t.slug}`,
    title: t.name,
    topic: t.slug,
    keywords: [t.name.toLowerCase(), t.slug.toLowerCase(), ...t.keywords],
  }));
  // The publisher's own pages (SITE_LINKS). Their `slug` is the real path,
  // not a /topics/ route — a git-delivered site has no /topics/<slug> pages.
  const fromSite: LinkableContent[] = siteLinks().map(l => ({
    id: `site-${l.path}`,
    type: "landing" as const,
    slug: l.path,
    title: l.label,
    keywords: [l.label.toLowerCase(), ...l.keywords.map(k => k.toLowerCase())],
  }));
  return [...fromTopics, ...fromSite];
}

// ============================================================================
// MAIN LINKING FUNCTIONS
// ============================================================================

/**
 * Insert internal links into content (sync, configured targets only)
 */
export function insertInternalLinks(
  content: string,
  options: {
    contentType: ContentType;
    currentTopic?: string;
    currentId?: string;
    minLinks?: number;
    maxLinks?: number;
  }
): LinkingResult {
  const requirements = CONTENT_TYPE_REQUIREMENTS[options.contentType];
  const minLinks = options.minLinks || requirements.internalLinks.min;
  const maxLinks = options.maxLinks || requirements.internalLinks.max;

  const links: InternalLink[] = [];
  let processedContent = content;

  // Get all potential link targets (excluding current page).
  // Prefer DB-loaded targets if a previous async load populated the cache.
  const allTargets = [...dbLinksCache, ...topicLinkTargets()].filter(
    t => t.id !== options.currentId
  );

  // Find opportunities to add links
  const opportunities = findLinkOpportunities(content, allTargets);

  // Sort by relevance and select top links
  opportunities.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const selectedLinks = opportunities.slice(0, maxLinks);

  // Insert links into content (in reverse order to preserve positions)
  selectedLinks.sort((a, b) => (b.position || 0) - (a.position || 0));

  for (const link of selectedLinks) {
    if (links.length >= maxLinks) break;

    const result = insertLink(processedContent, link);
    if (result.inserted) {
      processedContent = result.content;
      links.push({
        url: link.url,
        anchorText: link.anchorText,
        relevanceScore: link.relevanceScore,
        targetId: link.targetId,
        targetType: link.targetType,
      });
    }
  }

  logger.info(`Inserted ${links.length} internal links (target: ${minLinks}-${maxLinks})`);

  return {
    content: processedContent,
    linksAdded: links.length,
    links,
  };
}

/**
 * Suggest internal links without inserting them
 */
export function suggestInternalLinks(
  content: string,
  options: {
    currentTopic?: string;
    currentId?: string;
    maxSuggestions?: number;
  }
): InternalLink[] {
  const allTargets = [...dbLinksCache, ...topicLinkTargets()].filter(
    t => t.id !== options.currentId
  );

  const opportunities = findLinkOpportunities(content, allTargets);
  opportunities.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return opportunities.slice(0, options.maxSuggestions || 10).map(o => ({
    url: o.url,
    anchorText: o.anchorText,
    relevanceScore: o.relevanceScore,
    targetId: o.targetId,
    targetType: o.targetType,
  }));
}

/**
 * Analyze existing internal links in content
 */
export function analyzeExistingLinks(content: string): {
  count: number;
  links: Array<{ url: string; anchorText: string }>;
  missingOpportunities: string[];
} {
  const linkPattern = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  const links: Array<{ url: string; anchorText: string }> = [];

  let match;
  while ((match = linkPattern.exec(content)) !== null) {
    const url = match[1];
    // Only count internal links
    if (url.startsWith("/")) {
      links.push({ url, anchorText: match[2] });
    }
  }

  // Find missing link opportunities
  const missingOpportunities: string[] = [];
  const contentLower = content.toLowerCase();
  const allTargets = [...dbLinksCache, ...topicLinkTargets()];

  for (const target of allTargets) {
    const isLinked = links.some(l => l.url.includes(target.slug));
    const isMentioned = target.keywords?.some(kw => contentLower.includes(kw));

    if (isMentioned && !isLinked) {
      const contextLabel = target.topic || target.category || target.title;
      missingOpportunities.push(`Could link to ${target.title} when mentioning ${contextLabel}`);
    }
  }

  return {
    count: links.length,
    links,
    missingOpportunities,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

interface LinkOpportunity {
  url: string;
  anchorText: string;
  relevanceScore: number;
  targetId: string;
  targetType: string;
  position?: number;
  matchedKeyword: string;
}

function findLinkOpportunities(content: string, targets: LinkableContent[]): LinkOpportunity[] {
  const opportunities: LinkOpportunity[] = [];
  const contentLower = content.toLowerCase();

  // Track already used anchor texts to avoid duplicate links
  const usedAnchors = new Set<string>();

  for (const target of targets) {
    if (!target.keywords) continue;

    for (const keyword of target.keywords) {
      const keywordLower = keyword.toLowerCase();
      const position = contentLower.indexOf(keywordLower);

      if (position !== -1 && !usedAnchors.has(keywordLower)) {
        // Check if this position is already inside a link
        if (isInsideExistingLink(content, position)) continue;

        // Calculate relevance score
        const relevanceScore = calculateRelevance(keyword, target, content);

        opportunities.push({
          url: target.slug,
          anchorText: findBestAnchorText(content, keyword, position),
          relevanceScore,
          targetId: target.id,
          targetType: target.type,
          position,
          matchedKeyword: keyword,
        });

        usedAnchors.add(keywordLower);
      }
    }
  }

  return opportunities;
}

function isInsideExistingLink(content: string, position: number): boolean {
  // Look for opening <a tag before position without closing </a>
  const before = content.substring(0, position);
  const lastOpenA = before.lastIndexOf("<a ");
  const lastCloseA = before.lastIndexOf("</a>");

  return lastOpenA > lastCloseA;
}

function calculateRelevance(keyword: string, target: LinkableContent, content: string): number {
  let score = 50; // Base score

  // Longer keywords are more specific
  if (keyword.length > 10) score += 20;
  else if (keyword.length > 5) score += 10;

  // Topic matches are highly relevant
  if (target.type === "topic") score += 15;

  // Multiple mentions increase relevance
  const mentions = Array.from(
    content.toLowerCase().matchAll(new RegExp(escapeRegExp(keyword.toLowerCase()), "g"))
  ).length;
  score += Math.min(mentions * 5, 20);

  // Keyword appears early in content (likely more important)
  const position = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (position < content.length * 0.3) score += 10;

  return Math.min(score, 100);
}

function findBestAnchorText(content: string, keyword: string, position: number): string {
  // Extract the actual text from content (preserving case)
  const keywordLength = keyword.length;
  const actualText = content.substring(position, position + keywordLength);

  // Try to expand to include full proper noun or phrase
  const before = content.substring(Math.max(0, position - 20), position);
  const after = content.substring(
    position + keywordLength,
    Math.min(content.length, position + keywordLength + 20)
  );

  // Check if part of a longer phrase
  const beforeWord = /\b(\w+)\s*$/.exec(before)?.[1] || "";
  const afterWord = /^\s*(\w+)\b/.exec(after)?.[1] || "";

  // Common phrase patterns
  if (/^(the|explore|understand|learn)$/i.exec(beforeWord)) {
    return `${beforeWord} ${actualText}`;
  }

  if (/^(guide|overview|news|analysis)$/i.exec(afterWord)) {
    return `${actualText} ${afterWord}`;
  }

  return actualText;
}

function insertLink(
  content: string,
  opportunity: LinkOpportunity
): { inserted: boolean; content: string } {
  const { anchorText, url, position } = opportunity;

  if (position === undefined) {
    return { inserted: false, content };
  }

  // Find the exact text to replace (case-insensitive match, preserve original case)
  const searchStart = Math.max(0, position - 10);
  const searchEnd = Math.min(content.length, position + anchorText.length + 10);
  const searchArea = content.substring(searchStart, searchEnd);

  // Find the anchor text in the search area
  const anchorLower = anchorText.toLowerCase();
  const matchStart = searchArea.toLowerCase().indexOf(anchorLower);

  if (matchStart === -1) {
    return { inserted: false, content };
  }

  const actualAnchor = searchArea.substring(matchStart, matchStart + anchorText.length);
  const globalPosition = searchStart + matchStart;

  // Create the link
  const link = `<a href="${url}" class="internal-link">${actualAnchor}</a>`;

  // Replace the text with the link
  const newContent =
    content.substring(0, globalPosition) +
    link +
    content.substring(globalPosition + actualAnchor.length);

  return { inserted: true, content: newContent };
}

// ============================================================================
// LINK VALIDATION
// ============================================================================

/**
 * Validate internal linking meets requirements
 */
export function validateInternalLinking(
  content: string,
  contentType: ContentType
): {
  valid: boolean;
  count: number;
  required: { min: number; max: number };
  issues: string[];
} {
  const requirements = CONTENT_TYPE_REQUIREMENTS[contentType];
  const analysis = analyzeExistingLinks(content);

  const issues: string[] = [];

  if (analysis.count < requirements.internalLinks.min) {
    issues.push(
      `Not enough internal links (${analysis.count}). Minimum: ${requirements.internalLinks.min}`
    );
  }

  if (analysis.count > requirements.internalLinks.max + 2) {
    issues.push(
      `Too many internal links (${analysis.count}). Recommended maximum: ${requirements.internalLinks.max}`
    );
  }

  // Check for missed opportunities
  if (analysis.missingOpportunities.length > 0) {
    issues.push(...analysis.missingOpportunities.slice(0, 3));
  }

  return {
    valid: analysis.count >= requirements.internalLinks.min,
    count: analysis.count,
    required: requirements.internalLinks,
    issues,
  };
}

// ============================================================================
// DATABASE-BACKED LINK TARGETS
// ============================================================================

const CONTENT_TYPE_SLUG_PREFIX: Record<string, string> = {
  article: "/article/",
  guide: "/guide/",
  review: "/review/",
};

function buildContentSlug(rawSlug: string, contentType: string): string {
  if (rawSlug.startsWith("/")) return rawSlug;
  const prefix = CONTENT_TYPE_SLUG_PREFIX[contentType] || "/article/";
  return `${prefix}${rawSlug}`;
}

function mapContentToLinkable(
  publishedContent: Array<{
    id: string;
    type: string;
    slug: string | null;
    title: string;
    primaryKeyword: string | null;
  }>
): LinkableContent[] {
  return publishedContent
    .filter(c => c.slug)
    .map(content => {
      const keywords: string[] = [content.title.toLowerCase()];
      if (content.primaryKeyword) keywords.push(content.primaryKeyword.toLowerCase());
      return {
        id: content.id,
        type: content.type as ContentType,
        slug: buildContentSlug(content.slug!, content.type),
        title: content.title,
        keywords,
      };
    });
}

/**
 * Load linkable content from database (published content).
 * Results are cached for 10 minutes to reduce database load.
 */
export async function loadLinkableContentFromDB(): Promise<LinkableContent[]> {
  const now = Date.now();

  if (dbLinksCache.length > 0 && now - dbLinksCacheTime < DB_LINKS_CACHE_TTL) {
    return dbLinksCache;
  }

  try {
    const publishedContent = await db
      .select({
        id: contents.id,
        type: contents.type,
        slug: contents.slug,
        title: contents.title,
        primaryKeyword: contents.primaryKeyword,
      })
      .from(contents)
      .where(and(eq(contents.status, "published"), isNotNull(contents.slug)))
      .limit(500);

    const linkableContent: LinkableContent[] = mapContentToLinkable(publishedContent);

    dbLinksCache = linkableContent;
    dbLinksCacheTime = now;

    logger.info(
      { content: publishedContent.length },
      `Loaded ${linkableContent.length} linkable items from database`
    );

    return linkableContent;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Failed to load linkable content from database"
    );
    return dbLinksCache;
  }
}

/**
 * Get all link targets (configured topics + database content)
 */
export async function getAllLinkTargets(excludeId?: string): Promise<LinkableContent[]> {
  const configuredTargets = topicLinkTargets();
  const dbTargets = await loadLinkableContentFromDB();

  const seenIds = new Set<string>();
  const allTargets: LinkableContent[] = [];

  // DB targets take precedence
  for (const target of dbTargets) {
    if (!seenIds.has(target.id) && target.id !== excludeId) {
      seenIds.add(target.id);
      allTargets.push(target);
    }
  }

  for (const target of configuredTargets) {
    if (!seenIds.has(target.id) && target.id !== excludeId) {
      seenIds.add(target.id);
      allTargets.push(target);
    }
  }

  return allTargets;
}

/**
 * Clear the database links cache (useful after content updates)
 */
export function clearLinksCacheFromDB(): void {
  dbLinksCache = [];
  dbLinksCacheTime = 0;
  logger.info("Internal links database cache cleared");
}

// ============================================================================
// ASYNC VERSIONS (Database-backed)
// ============================================================================

/**
 * Insert internal links using database-backed link targets.
 * This is the preferred method for production use.
 */
export async function insertInternalLinksAsync(
  content: string,
  options: {
    contentType: ContentType;
    currentTopic?: string;
    currentId?: string;
    minLinks?: number;
    maxLinks?: number;
  }
): Promise<LinkingResult> {
  const requirements = CONTENT_TYPE_REQUIREMENTS[options.contentType];
  const minLinks = options.minLinks || requirements.internalLinks.min;
  const maxLinks = options.maxLinks || requirements.internalLinks.max;

  const links: InternalLink[] = [];
  let processedContent = content;

  // Get all potential link targets from database + configured topics
  const allTargets = await getAllLinkTargets(options.currentId);

  // Find opportunities to add links
  const opportunities = findLinkOpportunities(content, allTargets);

  // Sort by relevance and select top links
  opportunities.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const selectedLinks = opportunities.slice(0, maxLinks);

  // Insert links into content (in reverse order to preserve positions)
  selectedLinks.sort((a, b) => (b.position || 0) - (a.position || 0));

  for (const link of selectedLinks) {
    if (links.length >= maxLinks) break;

    const result = insertLink(processedContent, link);
    if (result.inserted) {
      processedContent = result.content;
      links.push({
        url: link.url,
        anchorText: link.anchorText,
        relevanceScore: link.relevanceScore,
        targetId: link.targetId,
        targetType: link.targetType,
      });
    }
  }

  logger.info(
    { totalTargets: allTargets.length },
    `[Async] Inserted ${links.length} internal links (target: ${minLinks}-${maxLinks})`
  );

  return {
    content: processedContent,
    linksAdded: links.length,
    links,
  };
}

/**
 * Suggest internal links using database-backed link targets
 */
export async function suggestInternalLinksAsync(
  content: string,
  options: {
    currentTopic?: string;
    currentId?: string;
    maxSuggestions?: number;
  }
): Promise<InternalLink[]> {
  const allTargets = await getAllLinkTargets(options.currentId);

  const opportunities = findLinkOpportunities(content, allTargets);
  opportunities.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return opportunities.slice(0, options.maxSuggestions || 10).map(o => ({
    url: o.url,
    anchorText: o.anchorText,
    relevanceScore: o.relevanceScore,
    targetId: o.targetId,
    targetType: o.targetType,
  }));
}
