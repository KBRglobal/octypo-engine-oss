import type { EngineBlock } from "./blocks";

export type ContentStatus = "draft" | "in_review" | "scheduled" | "published" | "archived";

export interface ArticleListItem {
  id: string;
  title: string;
  slug: string;
  status: ContentStatus;
  writerId: string | null;
  wordCount: number | null;
  generatedByAI: boolean | null;
  aeoScore: number | null;
  publishedAt: string | null;
  scheduledFor: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ArticleFull extends ArticleListItem {
  summary: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  answerCapsule: string | null;
  heroImage: string | null;
  blocks: EngineBlock[] | null;
}

export interface Feed {
  id: string;
  name: string;
  url: string;
  category: string | null;
  language: string | null;
  isActive: boolean | null;
  lastFetchedAt: string | null;
  fetchIntervalMinutes: number | null;
  createdAt: string | null;
  itemCount: number;
}

export interface Gate1Item {
  id: string;
  title: string;
  source: string | null;
  gate1Score: number | null;
  gate1Decision: string | null;
  gate1Tier: string | null;
  processed: boolean;
  createdAt: string;
}

export interface Stats {
  pipeline: {
    scheduler: {
      running: boolean;
      config: { globalDailyLimit: number; intervalMinutes: number; enabled: boolean };
    };
    today: { totalToday: number; globalRemaining: number };
    jobs: Record<string, number>;
  };
  counts: Record<string, number>;
  articlesToday: number;
  articlesThisWeek: number;
  activeFeeds: number;
  recentGate1: Gate1Item[];
}

export interface PipelineStatus {
  scheduler: { running: boolean; config: { globalDailyLimit: number } };
}

export type DocumentStatus = "pending" | "extracting" | "extracted" | "ideas_generated" | "failed";

export type LibraryItemStatus = "idea" | "queued" | "writing" | "published" | "failed";

export interface LibraryDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  errorMessage: string | null;
  ideaCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LibraryItem {
  id: string;
  documentId: string;
  title: string;
  angle: string;
  keyPoints: string[] | null;
  suggestedTopicId: string | null;
  status: LibraryItemStatus;
  contentId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface UploadedDoc {
  id: string;
  filename: string;
  status: DocumentStatus;
  sizeBytes: number;
  errorMessage: string | null;
}

export interface QAIssue {
  category: string;
  severity: "critical" | "major" | "minor";
  description: string;
  location?: string;
  suggestion: string;
}

export interface QAResult {
  decision: "approve" | "revise" | "reject";
  overallQuality: number;
  aeoScore?: number;
  aeoChecklist?: Record<string, boolean>;
  issues: QAIssue[];
  corrections?: { section: string; issue: string; instruction: string; priority: string }[];
  publicationReady: boolean;
  reasoning: string;
  editorNotes: string;
  processingTimeMs: number;
}

// ── Idea bank & facts (Studio redesign) ──────────────────────────────────────

export type IdeaStatus = "planned" | "queued" | "written" | "skipped";

export interface Idea {
  id: string;
  title: string;
  targetKeyword: string;
  cluster: string | null;
  articleType: string | null;
  isPillar: boolean | null;
  searchVolume: number | null;
  priority: number;
  status: IdeaStatus;
  contentId: string | null;
}

export interface BankSummary {
  planned: number;
  queued: number;
  written: number;
  skipped: number;
  total: number;
}

export interface BankBuildResult {
  requested: number;
  produced: number;
  coverageMonths: number;
  usedKeywordProvider: boolean;
  titled: number;
  inserted?: number;
  skipped?: number;
  ideas: Idea[];
}

export interface Fact {
  id: string;
  cluster: string;
  fact: string;
  confirmed: boolean;
  source: string;
  createdAt: string;
}

// ── SEO tools ───────────────────────────────────────────────────────────────
// These mirror src/seo/rows.ts. Every number is nullable
// on purpose — a phrase nobody sells data for must not read as zero searches.

export type SeoToolId =
  | "domain-overview"
  | "ranked-keywords"
  | "keywords"
  | "backlinks"
  | "competitors"
  | "keyword-gap"
  | "serp";

export interface SeoKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
}

export interface SeoRankedKeyword extends SeoKeyword {
  position: number | null;
  url: string | null;
  trafficEstimate: number | null;
}

export interface SeoGapKeyword extends SeoKeyword {
  myPosition: number | null;
  theirPosition: number | null;
  theirUrl: string | null;
}

export interface SeoDomainOverview {
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicTrafficCost: number | null;
  paidKeywords: number | null;
  top3: number | null;
  top10: number | null;
}

export interface SeoBacklinkSummary {
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  referringMainDomains: number | null;
  nofollowDomains: number | null;
  brokenBacklinks: number | null;
  spamScore: number | null;
}

export interface SeoReferringDomain {
  domain: string;
  rank: number | null;
  backlinks: number | null;
  firstSeen: string | null;
  lostDate: string | null;
  spamScore: number | null;
}

export interface SeoAnchor {
  anchor: string;
  backlinks: number | null;
  referringDomains: number | null;
}

export interface SeoCompetitor {
  domain: string;
  intersections: number | null;
  avgPosition: number | null;
  organicKeywords: number | null;
  organicTraffic: number | null;
}

export interface SeoSerpResult {
  position: number | null;
  domain: string | null;
  url: string | null;
  title: string | null;
  description: string | null;
}

export interface SeoTool {
  id: SeoToolId;
  label: string;
  hint: string;
  needs: ("target" | "keyword" | "rival")[];
  defaultLimit: number;
  maxLimit: number;
  estimateUsd: number | null;
}

export interface SeoStatus {
  enabled: boolean;
  balanceUsd: number | null;
  locationCode: number | null;
  languageCode: string | null;
  tools: SeoTool[];
  error?: string;
}

export interface SeoMarket {
  code: number;
  name: string;
  languages: { code: string; name: string }[];
}

export interface SeoRunInput {
  target?: string;
  keyword?: string;
  rival?: string;
  limit?: number;
  locationCode?: number;
  languageCode?: string;
  refresh?: boolean;
}

export interface SeoRun {
  tool: SeoToolId;
  input: {
    target?: string;
    keyword?: string;
    rival?: string;
    limit: number;
    locationCode?: number;
    languageCode?: string;
  };
  data: Record<string, unknown>;
  costUsd: number;
  cached: boolean;
  fetchedAt: string;
}

export interface SeoHistoryEntry {
  id: string;
  tool: SeoToolId;
  input: Record<string, unknown>;
  costUsd: number;
  fetchedAt: string | null;
}

// ── SEO tools: the endpoint explorer ────────────────────────────────────────
// Mirrors src/seo/catalogue.ts. The catalogue is discovered from DataForSEO
// at runtime, so nothing here enumerates endpoints — only their shape.

export type SeoEndpointKind =
  | "live"
  | "task_post"
  | "tasks_ready"
  | "task_get"
  | "reference"
  | "result";

export interface SeoEndpoint {
  path: string;
  family: string;
  kind: SeoEndpointKind;
  label: string;
  method: "GET" | "POST";
  needsId: boolean;
  price: { perRequestUsd: number; perResultUsd: number } | null;
}

export interface SeoCatalogue {
  endpoints: SeoEndpoint[];
  families: string[];
  /** Families that did not answer — a partial list, shown as partial. */
  missing: string[];
}

export interface SeoExplorerRun {
  path: string;
  method: "GET" | "POST";
  params: Record<string, unknown>;
  kind: SeoEndpointKind;
  rows: Record<string, unknown>[];
  head: Record<string, unknown> | null;
  results: Record<string, unknown>[];
  costUsd: number;
  cached: boolean;
  fetchedAt: string;
  taskId: string | null;
  statusMessage: string;
}

export interface SeoCallInput {
  path: string;
  family?: string;
  params?: Record<string, unknown>;
  refresh?: boolean;
  taskId?: string;
  locationCode?: number;
  languageCode?: string;
}

// ── SEO tools: the site report ──────────────────────────────────────────────

export interface SeoReportPayload {
  domain: string;
  clientName: string;
  generatedAt: string;
  costUsd: number;
  /** Sections left out, and therefore never shown to the client. */
  omitted: string[];
}

export interface SeoReportResult {
  token: string;
  /** Where the client opens it. Public, unguessable, noindex. */
  path: string;
  report: SeoReportPayload;
}

export interface SeoReportSummary {
  token: string;
  path: string;
  domain: string;
  clientName: string;
  costUsd: number;
  createdAt: string | null;
}

export interface SeoReportInput {
  domain: string;
  clientName?: string;
  seed?: string;
  locationCode?: number;
  languageCode?: string;
}


// ── Rank tracking: where every target phrase stands, month over month ───────

export interface RankRun {
  runId: string;
  measuredAt: string;
  tracked: number;
  ranking: number;
  top10: number;
  top3: number;
}

export interface RankMovement {
  keyword: string;
  position: number | null;
  previous: number | null;
  /** Positive when the phrase moved up the page. */
  change: number | null;
  url: string | null;
  searchVolume: number | null;
}

export interface RankReport {
  current: RankRun | null;
  previous: RankRun | null;
  movements: RankMovement[];
  tracker: { running: boolean; lastMeasuredAt: string | null };
}
