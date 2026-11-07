/**
 * Octypo Engine — trimmed database schema.
 * Only the tables the content pipeline actually uses.
 */

import {
  bigint,
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================================
// SHARED JSON TYPES
// ============================================================================

export interface ContentBlock {
  type: string;
  id: string;
  data: Record<string, unknown>;
}

export interface FaqItem {
  question: string;
  answer: string;
}

/**
 * Structured "Quick Facts" metadata derived per article (Difficulty / Time /
 * Tools / Risk / When-to-do / Best-for) plus an actionable checklist. Every
 * field is optional — only the ones the article actually supports are filled.
 */
export interface QuickFacts {
  difficulty?: "easy" | "medium" | "hard" | null;
  timeNeeded?: string | null; // e.g. "5–10 minutes"
  tools?: string[]; // e.g. ["Phone camera","Flashlight","Measuring tape"]
  riskLevel?: "low" | "medium" | "high" | null;
  whenToDo?: string | null; // e.g. "Before accepting the keys"
  bestFor?: string[]; // e.g. ["Tenants before move-in","Landlords before move-out"]
  checklist?: string[]; // actionable checklist items
}

export type ContentStatus =
  | "draft"
  | "in_review"
  | "scheduled"
  | "publishing"
  | "published"
  | "archived";

// ============================================================================
// CONTENTS — base table for all published content
// ============================================================================

export const contents = pgTable(
  "contents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text("type").notNull().default("article"),
    status: text("status").$type<ContentStatus>().notNull().default("draft"),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    primaryKeyword: text("primary_keyword"),
    secondaryKeywords: jsonb("secondary_keywords").$type<string[]>().default([]),
    heroImage: text("hero_image"),
    heroImageAlt: text("hero_image_alt"),
    cardImage: text("card_image"),
    cardImageAlt: text("card_image_alt"),
    summary: text("summary"),
    blocks: jsonb("blocks").$type<ContentBlock[]>().default([]),
    seoSchema: jsonb("seo_schema").$type<
      Record<string, unknown>[] | Record<string, unknown> | string
    >(),
    seoScore: integer("seo_score"),
    answerCapsule: text("answer_capsule"),
    quickFacts: jsonb("quick_facts").$type<QuickFacts>(),
    aeoScore: integer("aeo_score"),
    wordCount: integer("word_count").default(0),
    viewCount: integer("view_count").default(0),
    writerId: varchar("writer_id"),
    generatedByAI: boolean("generated_by_ai").default(false),
    publishedAt: timestamp("published_at"),
    scheduledFor: timestamp("scheduled_for"),
    /** Promo video rendered from this article. Null until one is asked for. */
    promoVideoUrl: text("promo_video_url"),
    /**
     * Post-publish liveness verdict (SEO-F): did the public URL actually come
     * up, and is it indexable? Written fire-and-forget after publish; null
     * until the first check. Never consulted by the publish flow itself.
     */
    liveness: jsonb("liveness").$type<{
      checkedAt: string;
      httpStatus: number | null;
      ok: boolean;
      noindex: boolean;
      error?: string;
    } | null>(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("IDX_contents_status").on(table.status),
    index("IDX_contents_type").on(table.type),
    index("IDX_contents_published_at").on(table.publishedAt),
    index("IDX_contents_scheduled_for").on(table.scheduledFor),
    index("IDX_contents_writer").on(table.writerId),
  ]
);

export type Content = typeof contents.$inferSelect;
export type InsertContent = typeof contents.$inferInsert;

// ============================================================================
// ARTICLES — article-specific data linked to contents
// ============================================================================

export interface SourceCheck {
  url: string;
  checkedAt: string;
  httpStatus: number | null;
}

export const articles = pgTable("articles", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  contentId: varchar("content_id").notNull(),
  category: text("category"),
  excerpt: text("excerpt"),
  publishDate: timestamp("publish_date"),
  sourceRssFeedId: varchar("source_rss_feed_id"),
  sourceUrl: text("source_url"),
  /**
   * Official pages opened while writing, with when and what they answered.
   * The evidence behind any "not yet announced" sentence in the article.
   */
  sourceChecks: jsonb("source_checks").$type<SourceCheck[]>().default([]),
  faq: jsonb("faq").$type<FaqItem[]>().default([]),
  relatedTopicIds: jsonb("related_topic_ids").$type<string[]>().default([]),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Article = typeof articles.$inferSelect;
export type InsertArticle = typeof articles.$inferInsert;

// ============================================================================
// RSS FEEDS
// ============================================================================

export const rssFeeds = pgTable("rss_feeds", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  url: text("url").notNull(),
  category: text("category"),
  topicId: varchar("topic_id"),
  language: text("language").default("en"),
  region: text("region"),
  isActive: boolean("is_active").default(true),
  lastFetchedAt: timestamp("last_fetched_at"),
  fetchIntervalMinutes: integer("fetch_interval_minutes").default(60),
  createdAt: timestamp("created_at").defaultNow(),
});

export type RssFeed = typeof rssFeeds.$inferSelect;
export type InsertRssFeed = typeof rssFeeds.$inferInsert;

// ============================================================================
// BACKGROUND JOBS — persistent job queue
// ============================================================================

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    retries: integer("retries").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    // When a retry becomes eligible. NULL means "now". Without this a failed job
    // was re-queued as pending and the 1s poll re-ran it immediately, turning a
    // provider outage into a hot loop against paid APIs.
    nextAttemptAt: timestamp("next_attempt_at"),
  },
  table => [
    index("IDX_jobs_status").on(table.status),
    index("IDX_jobs_type").on(table.type),
    index("IDX_jobs_priority").on(table.priority),
  ]
);

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type InsertBackgroundJob = typeof backgroundJobs.$inferInsert;

// ============================================================================
// CONTENT FINGERPRINTS — deduplication (MinHash/LSH)
// ============================================================================

export const contentFingerprints = pgTable("content_fingerprints", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  contentId: varchar("content_id"),
  fingerprint: text("fingerprint").notNull().unique(),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  rssFeedId: varchar("rss_feed_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type ContentFingerprint = typeof contentFingerprints.$inferSelect;
export type InsertContentFingerprint = typeof contentFingerprints.$inferInsert;

// ============================================================================
// CONTENT ENTITIES — entities extracted from content
// ============================================================================

export const contentEntities = pgTable(
  "content_entities",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sourceContentId: varchar("source_content_id").notNull(),
    entityType: text("entity_type").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    description: text("description"),
    topicId: varchar("topic_id"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().default({}),
    verified: boolean("verified").default(false),
    articleCount: integer("article_count").default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("idx_content_entities_source").on(table.sourceContentId),
    index("idx_content_entities_type").on(table.entityType),
    index("idx_content_entities_normalized").on(table.normalizedName),
  ]
);

export type ContentEntity = typeof contentEntities.$inferSelect;

// ============================================================================
// INTERNAL LINKS — tracking auto-inserted internal links
// ============================================================================

export const internalLinks = pgTable("internal_links", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  sourceContentId: varchar("source_content_id"),
  targetContentId: varchar("target_content_id"),
  anchorText: text("anchor_text"),
  isAutoSuggested: boolean("is_auto_suggested").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export type InternalLink = typeof internalLinks.$inferSelect;

// ============================================================================
// SEO METADATA — quality scores per content
// ============================================================================

export const seoMetadata = pgTable(
  "seo_metadata",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    contentId: varchar("content_id")
      .notNull()
      .unique()
      .references(() => contents.id, { onDelete: "cascade" }),
    quality108Total: integer("quality_108_total"),
    quality108Breakdown: jsonb("quality_108_breakdown")
      .$type<Record<string, number>>()
      .default({}),
    quality108Grade: varchar("quality_108_grade", { length: 5 }),
    quality108Passed: boolean("quality_108_passed").default(false),
    aeoScore: integer("aeo_score"),
    hasAnswerCapsule: boolean("has_answer_capsule").default(false),
    hasFaqSchema: boolean("has_faq_schema").default(false),
    faqCount: integer("faq_count").default(0),
    internalLinksOut: integer("internal_links_out").default(0),
    internalLinksIn: integer("internal_links_in").default(0),
    isOrphan: boolean("is_orphan").default(false),
    lastAuditAt: timestamp("last_audit_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("idx_seo_metadata_content").on(table.contentId),
    index("idx_seo_metadata_quality").on(table.quality108Total),
  ]
);

export type SeoMetadata = typeof seoMetadata.$inferSelect;

// ============================================================================
// DOCUMENTS — uploaded source files for the Document Library content source
// ============================================================================

export type DocumentStatus =
  | "pending"
  | "extracting"
  | "extracted"
  | "ideas_generated"
  | "failed";

export const documents = pgTable(
  "documents",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull().default(0),
    extractedText: text("extracted_text"),
    status: text("status").$type<DocumentStatus>().notNull().default("pending"),
    errorMessage: text("error_message"),
    ideaCount: integer("idea_count").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("IDX_documents_status").on(table.status)]
);

export type Document = typeof documents.$inferSelect;
export type InsertDocument = typeof documents.$inferInsert;

// ============================================================================
// LIBRARY ITEMS — article ideas mined from an uploaded document
// ============================================================================

export type LibraryItemStatus =
  | "idea"
  | "queued"
  | "writing"
  | "ready"
  | "published"
  | "failed";

export const libraryItems = pgTable(
  "library_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    documentId: varchar("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    keyPoints: jsonb("key_points").$type<string[]>().default([]),
    suggestedTopicId: varchar("suggested_topic_id"),
    status: text("status").$type<LibraryItemStatus>().notNull().default("idea"),
    contentId: varchar("content_id"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("IDX_library_items_document").on(table.documentId),
    index("IDX_library_items_status").on(table.status),
  ]
);

/**
 * The idea bank: a year of planned articles, built once at install.
 *
 * RSS makes the engine reactive — it writes about whatever happened to appear
 * in a feed. A bank built up front makes it a plan: the topic space is covered
 * deliberately, the customer can be shown what they are going to get before a
 * word is written, and the daily job becomes "take the next idea" instead of
 * "hope something newsworthy shows up".
 */
/**
 * What the client threw into the field desk (a Telegram group with the bot in
 * it): the message, the photos kept in the bucket, and the document the
 * library mines from it. See src/octypo/field/telegram.ts.
 */
export const fieldNotes = pgTable(
  "field_notes",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    source: text("source").notNull().default("telegram"),
    chatId: text("chat_id").notNull(),
    messageId: text("message_id").notNull(),
    updateId: bigint("update_id", { mode: "number" }).unique(),
    sender: text("sender"),
    text: text("text"),
    media: jsonb("media").$type<Array<{ url: string; alt: string; width?: number; height?: number }>>().default([]),
    documentId: varchar("document_id").references(() => documents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("filed"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("IDX_field_notes_document").on(table.documentId)]
);
export type FieldNote = typeof fieldNotes.$inferSelect;

export type ContentIdeaStatus = "planned" | "queued" | "written" | "skipped";

export const contentIdeas = pgTable(
  "content_ideas",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: text("title").notNull(),
    /** The phrase this article is meant to answer. */
    targetKeyword: text("target_keyword").notNull(),
    /** Normalised key the build deduplicates on — one idea per phrase. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Topic slug this idea belongs to; the cluster it supports. */
    cluster: text("cluster"),
    /** Which of the writer personas this idea is meant for. */
    articleType: text("article_type"),
    /** Pillar articles anchor a cluster; the rest support them. */
    isPillar: boolean("is_pillar").default(false),
    /** Monthly searches, when a keyword-data provider supplied one. */
    searchVolume: integer("search_volume"),
    /** Higher writes sooner. */
    priority: integer("priority").notNull().default(0),
    /**
     * Words this article should aim for. Null = the install default. Pillars
     * get more room by structure: they are the cluster's reference piece.
     */
    targetWords: integer("target_words"),
    status: text("status").$type<ContentIdeaStatus>().notNull().default("planned"),
    contentId: varchar("content_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [
    index("IDX_content_ideas_status").on(table.status),
    index("IDX_content_ideas_cluster").on(table.cluster),
    // One idea per phrase: a rebuild must top the bank up, not double it.
    uniqueIndex("UQ_content_ideas_dedupe_key").on(table.dedupeKey),
  ]
);

/**
 * Facts the customer confirmed, per cluster.
 *
 * The blind judging round settled the architecture: the strong models wrote
 * richer articles only by inventing commercial facts, and the safe model wrote
 * honestly but thin. Richness therefore has to come from the input — real
 * price ranges, real constraints, confirmed once by the customer — and the
 * writer is contractually forbidden to state anything not in this table.
 * `cluster = '*'` rows apply to every article on the site.
 */
/**
 * One-time competitive snapshot per cluster: what the live SERP covers for the
 * client's money queries, distilled once at onboarding and appended to every
 * article brief. Deliberately not refreshed per article — the owner pays for
 * this research exactly once per client.
 */
export const serpBriefs = pgTable("serp_briefs", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Topic slug, or '*' for a site-wide brief. Unique per cluster. */
  cluster: text("cluster").notNull().unique(),
  /** The queries actually searched, for the operator's audit trail. */
  queries: jsonb("queries").$type<string[]>().notNull().default([]),
  /** The distilled coverage brief the writer receives. */
  brief: text("brief").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

/**
 * Per-cluster language/country for native content generation.
 *
 * `cluster = '*'` is the site-wide (per-client) setting; an exact cluster row
 * overrides it. No row at all means the default locale (src/config/locale.ts).
 * Values are allowlisted at
 * the admin API — nothing from this table is ever interpolated into a prompt
 * directly (the internal language-name map is).
 */
export const clusterSettings = pgTable("cluster_settings", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Topic slug, or '*' for the site-wide setting. Unique per cluster. */
  cluster: text("cluster").notNull().unique(),
  /** ISO 639-1 code from the allowlist (he, en, de, …). */
  language: text("language").notNull(),
  /** ISO 3166-1 alpha-2 country code (IL, US, DE, …). */
  country: text("country").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const clusterFacts = pgTable(
  "cluster_facts",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Topic slug this fact belongs to, or '*' for site-wide facts. */
    cluster: text("cluster").notNull().default("*"),
    fact: text("fact").notNull(),
    /** Only confirmed facts ever reach a prompt. */
    confirmed: boolean("confirmed").notNull().default(false),
    /** Where the fact came from: 'client', 'site', 'questionnaire'. */
    source: text("source").notNull().default("client"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  table => [index("IDX_cluster_facts_cluster").on(table.cluster)]
);

/**
 * The durable spend ledger — one row per model call or image generation.
 *
 * The in-memory meter answers "what is happening right now"; this table answers
 * the business question: what did this client cost us this month. It survives
 * restarts and deploys, which is exactly what the in-memory snapshot cannot do.
 */
export const costLedger = pgTable(
  "cost_ledger",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** UTC day, YYYY-MM-DD — the aggregation key every report uses. */
    day: text("day").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull().default("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    images: integer("images").notNull().default(0),
    /** Microdollars (USD × 1e6): integer math, no float drift in sums. */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    articleId: varchar("article_id"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  table => [index("IDX_cost_ledger_day").on(table.day)]
);

/**
 * Answers already bought from the SEO desk.
 *
 * Every lookup on that desk is a purchase, and the same domain gets typed in
 * twice in five minutes far more often than its backlink profile changes. So a
 * result is kept under a key built from the tool and its inputs, and a repeat
 * within the tool's own freshness window is served from here for nothing. The
 * cost is stored with it so the ledger and this table can never disagree about
 * what a lookup cost.
 */
export const seoLookups = pgTable(
  "seo_lookups",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tool: text("tool").notNull(),
    /** Hash of tool + inputs; the reason a repeat is free. */
    cacheKey: text("cache_key").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Microdollars (USD × 1e6) — same integer money as the cost ledger. */
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("UQ_seo_lookups_cache_key").on(table.cacheKey),
    index("IDX_seo_lookups_tool").on(table.tool),
  ]
);

export type SeoLookup = typeof seoLookups.$inferSelect;

/**
 * Prospect reports, kept because they are sent.
 *
 * A lookup is a question we asked; a report is a document a stranger holds,
 * often days later, usually after the numbers behind it have moved. So it is
 * stored whole rather than rebuilt on view: the client must see exactly what
 * was sent, and the date on the page has to stay true. The token is the only
 * thing that opens it, which is what makes it shareable without an account.
 */
export const seoReports = pgTable(
  "seo_reports",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** The unguessable part of the link. */
    token: text("token").notNull(),
    domain: text("domain").notNull(),
    clientName: text("client_name").notNull(),
    /** The category the operator named; the demand section depends on it. */
    seed: text("seed"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    costMicroUsd: integer("cost_micro_usd").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("UQ_seo_reports_token").on(table.token),
    index("IDX_seo_reports_created").on(table.createdAt),
  ]
);

export type SeoReport = typeof seoReports.$inferSelect;

/**
 * Where each target phrase stood in Google, once a month.
 *
 * The bank says which phrases the engine writes for; this says whether it
 * worked. One row per phrase per measurement, never updated — a position is a
 * reading on a date, and a table that rewrote it would lose the only thing
 * that proves the service to a client: the line from where they were to where
 * they are. A phrase the site does not rank for at all is stored with a null
 * position, because "not ranking" on a date is a fact too.
 */
export const rankSnapshots = pgTable(
  "rank_snapshots",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Every row from one run shares this, so "this month" is one query. */
    runId: varchar("run_id").notNull(),
    keyword: text("keyword").notNull(),
    position: integer("position"),
    url: text("url"),
    searchVolume: integer("search_volume"),
    /** DataForSEO's estimate of monthly visits from this position. */
    trafficEstimate: integer("traffic_estimate"),
    measuredAt: timestamp("measured_at").defaultNow().notNull(),
  },
  table => [
    index("IDX_rank_snapshots_run").on(table.runId),
    index("IDX_rank_snapshots_keyword").on(table.keyword),
    index("IDX_rank_snapshots_measured").on(table.measuredAt),
  ]
);

export type RankSnapshot = typeof rankSnapshots.$inferSelect;

export type ClusterFact = typeof clusterFacts.$inferSelect;

export type ContentIdea = typeof contentIdeas.$inferSelect;
export type InsertContentIdea = typeof contentIdeas.$inferInsert;

export type LibraryItem = typeof libraryItems.$inferSelect;
export type InsertLibraryItem = typeof libraryItems.$inferInsert;
