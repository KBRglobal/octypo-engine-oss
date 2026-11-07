/**
 * Thin fetch wrapper for the engine API.
 * Token is the stateless HMAC returned by /api/auth/login, kept in localStorage.
 */

import { activeInstall } from "./installs";
import type { EngineBlock } from "./blocks";
import type {
  ArticleFull,
  BankBuildResult,
  BankSummary,
  Fact,
  Idea,
  ArticleListItem,
  Feed,
  LibraryDocument,
  LibraryItem,
  PipelineStatus,
  QAResult,
  RankReport,
  RankRun,
  SeoCallInput,
  SeoCatalogue,
  SeoEndpoint,
  SeoExplorerRun,
  SeoHistoryEntry,
  SeoMarket,
  SeoReportInput,
  SeoReportResult,
  SeoReportSummary,
  SeoRun,
  SeoRunInput,
  SeoStatus,
  SeoToolId,
  Stats,
  UploadedDoc,
} from "./types";

const TOKEN_KEY = "octypo_admin_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Requests go to the active install. The local engine stays the default; a
 * remote install carries its own base URL and its own token (stored with it in
 * the registry), so switching client is a pure client-side act.
 */
function requestTarget(path: string): { url: string; token: string | null } {
  const install = activeInstall();
  if (!install.baseUrl) return { url: path, token: getToken() };
  return { url: `${install.baseUrl}${path}`, token: install.token || null };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { url, token } = requestTarget(path);
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    // Only the local session lives in this browser's token. A remote install
    // returning 401 means its stored token is stale — surface it, but never
    // clear the local session or bounce to login over another engine's expiry.
    if (!activeInstall().baseUrl) {
      clearToken();
      window.location.href = "/admin/login";
    }
    throw new ApiError(401, "Session expired");
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response
  }

  if (!res.ok) {
    throw new ApiError(res.status, body?.error || `Request failed (${res.status})`);
  }

  return body as T;
}

/**
 * Same wrapper, but pinned to the local engine whatever install is selected.
 *
 * The optional SEO tools run on the operator's own engine with the operator's
 * own provider credentials, so they are never asked of a selected install.
 * Switching client in the sidebar must not change what they show, or empty them.
 */
async function localRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.href = "/admin/login";
    throw new ApiError(401, "Session expired");
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response
  }
  if (!res.ok) throw new ApiError(res.status, body?.error || `Request failed (${res.status})`);
  return body as T;
}

export interface ArticlePayload {
  title?: string;
  slug?: string;
  summary?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  blocks?: EngineBlock[];
}

export const api = {
  // Auth
  login: (password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),

  // Dashboard
  stats: () => request<Stats>("/api/admin/stats"),
  pipelineStatus: () => request<PipelineStatus>("/api/pipeline/status"),
  triggerPipeline: () =>
    request<{ triggered: boolean; created: number; globalRemaining: number }>(
      "/api/admin/pipeline/trigger",
      { method: "POST", body: "{}" }
    ),

  // Articles
  listArticles: (params: { status?: string; search?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.search) qs.set("search", params.search);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<{ articles: ArticleListItem[]; total: number }>(
      `/api/admin/articles?${qs.toString()}`
    );
  },
  getArticle: (id: string) => request<{ article: ArticleFull }>(`/api/admin/articles/${id}`),
  createArticle: (payload: ArticlePayload) =>
    request<{ article: ArticleFull }>("/api/admin/articles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateArticle: (id: string, payload: ArticlePayload) =>
    request<{ article: ArticleFull }>(`/api/admin/articles/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  approveArticle: (id: string) =>
    request<{ approved: boolean }>(`/api/admin/articles/${id}/approve`, { method: "POST" }),
  publishArticle: (id: string) =>
    request<{ article: ArticleFull }>(`/api/admin/articles/${id}/publish`, { method: "POST" }),
  scheduleArticle: (id: string, scheduledFor: string) =>
    request<{ article: ArticleFull }>(`/api/admin/articles/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduledFor }),
    }),
  unpublishArticle: (id: string) =>
    request<{ article: ArticleFull }>(`/api/admin/articles/${id}/unpublish`, { method: "POST" }),
  previewConfig: () =>
    request<{ baseUrl: string | null; token: string | null; articlePathPrefix: string }>(
      "/api/admin/preview-config"
    ),
  deleteArticle: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/articles/${id}`, { method: "DELETE" }),
  runQA: (id: string) =>
    request<{ qa: QAResult }>(`/api/admin/articles/${id}/qa`, { method: "POST" }),

  // Auto-schedule all approved, unscheduled drafts into randomised slots
  autoSchedule: () =>
    request<{ scheduled: number; firstSlot?: string; lastSlot?: string }>(
      "/api/admin/schedule/auto",
      { method: "POST", body: "{}" }
    ),

  // Rankings — this month's positions against last month's, per target phrase
  ranks: () => request<RankReport>("/api/admin/ranks"),
  measureRanks: () =>
    request<{ measured: boolean; run: RankRun | null }>("/api/admin/ranks/measure", {
      method: "POST",
      body: "{}",
    }),

  // Costs — what this install has spent (since its last restart)
  costs: () => request<Record<string, unknown>>("/api/admin/costs"),

  // Idea bank
  listIdeas: (params: { status?: string; cluster?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.cluster) qs.set("cluster", params.cluster);
    if (params.limit) qs.set("limit", String(params.limit));
    return request<{ summary: BankSummary; ideas: Idea[] }>(`/api/admin/ideas?${qs.toString()}`);
  },
  buildIdeas: (payload: {
    seeds: string[];
    target: number;
    articlesPerMonth?: number;
    persist?: boolean;
    country?: string;
    lang?: string;
  }) =>
    request<BankBuildResult>("/api/admin/ideas/build", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  writeIdeaNow: (id: string) =>
    request<{ queued: boolean }>(`/api/admin/ideas/${id}/write-now`, { method: "POST" }),
  skipIdea: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/ideas/${id}/skip`, { method: "POST" }),


  // SERP research — once per client
  serpBriefs: () =>
    request<{
      briefs: { cluster: string; queries: string[]; brief: string; updatedAt: string | null }[];
    }>("/api/admin/serp-briefs"),
  serpBriefBuild: (cluster?: string) =>
    request<{ built: { cluster: string }[]; requested: number }>("/api/admin/serp-brief/build", {
      method: "POST",
      body: JSON.stringify(cluster ? { cluster } : {}),
    }),
  serpBriefPrompts: (cluster?: string) =>
    request<{ prompts: { cluster: string; prompt: string }[] }>(
      `/api/admin/serp-brief/prompt${cluster ? `?cluster=${encodeURIComponent(cluster)}` : ""}`
    ),
  serpBriefPaste: (cluster: string, brief: string) =>
    request<{ stored: string }>("/api/admin/serp-brief/paste", {
      method: "POST",
      body: JSON.stringify({ cluster, brief }),
    }),

  // Cluster locale settings (native-language generation)
  listClusterSettings: () =>
    request<{
      settings: { cluster: string; language: string; country: string }[];
      languages: Record<string, string>;
    }>("/api/admin/cluster-settings"),
  putClusterSetting: (payload: { cluster?: string; language: string; country: string }) =>
    request<{ ok: boolean }>("/api/admin/cluster-settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteClusterSetting: (cluster: string) =>
    request<{ ok: boolean }>(`/api/admin/cluster-settings/${encodeURIComponent(cluster)}`, {
      method: "DELETE",
    }),

  // Confirmed facts
  listFacts: (cluster?: string) =>
    request<{ facts: Fact[] }>(
      `/api/admin/facts${cluster ? `?cluster=${encodeURIComponent(cluster)}` : ""}`
    ),
  addFacts: (payload: { cluster?: string; facts: string[] }) =>
    request<{ inserted: number }>("/api/admin/facts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  deleteFact: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/facts/${id}`, { method: "DELETE" }),
  factQuestionnaire: (topic: string, cluster?: string) =>
    request<{ questions: string[] }>("/api/admin/facts/questionnaire", {
      method: "POST",
      body: JSON.stringify({ topic, cluster }),
    }),

  // Feeds
  listFeeds: () => request<{ feeds: Feed[] }>("/api/admin/feeds"),
  addFeed: (payload: {
    name: string;
    url: string;
    category?: string;
    language?: string;
    fetchIntervalMinutes?: number;
  }) =>
    request<{ feed: Feed }>("/api/admin/feeds", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  patchFeed: (
    id: string,
    payload: { isActive?: boolean; name?: string; fetchIntervalMinutes?: number }
  ) =>
    request<{ feed: Feed }>(`/api/admin/feeds/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteFeed: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/feeds/${id}`, { method: "DELETE" }),

  // Library
  uploadDocuments: async (files: File[]): Promise<{ documents: UploadedDoc[] }> => {
    // Route to the ACTIVE install, not the local engine. A hand-rolled fetch
    // here was ingesting client B's documents into the local engine under the
    // local token — a cross-client data leak. FormData needs its own multipart
    // Content-Type, so this cannot go through request(), but it must use the
    // same target resolution.
    const { url, token } = requestTarget("/api/admin/library/upload");
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    const res = await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });
    if (res.status === 401) {
      // Only the LOCAL install owns the browser session token; a remote 401
      // must not wipe it. (requestTarget returns the local token only for the
      // local install.)
      if (!activeInstall().baseUrl) {
        clearToken();
        window.location.href = "/admin/login";
      }
      throw new ApiError(401, "Session expired");
    }
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON
    }
    if (!res.ok) {
      throw new ApiError(res.status, body?.error || `Upload failed (${res.status})`);
    }
    return body as { documents: UploadedDoc[] };
  },
  listDocuments: () => request<{ documents: LibraryDocument[] }>("/api/admin/library/documents"),
  getDocument: (id: string) =>
    request<{ document: LibraryDocument & { textLength: number }; items: LibraryItem[] }>(
      `/api/admin/library/documents/${id}`
    ),
  deleteDocument: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/library/documents/${id}`, { method: "DELETE" }),
  listLibraryItems: (
    params: { status?: string; documentId?: string; collection?: string } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.documentId) qs.set("documentId", params.documentId);
    if (params.collection) qs.set("collection", params.collection);
    return request<{ items: LibraryItem[] }>(`/api/admin/library/items?${qs.toString()}`);
  },
  generateViralIdeas: (payload: { count?: number; brief?: string } = {}) =>
    request<{ documentId: string; items: LibraryItem[] }>("/api/admin/library/viral-ideas", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  writeLibraryItemNow: (id: string) =>
    request<{ queued: boolean; id: string }>(`/api/admin/library/items/${id}/write-now`, {
      method: "POST",
    }),
  deleteLibraryItem: (id: string) =>
    request<{ deleted: boolean }>(`/api/admin/library/items/${id}`, { method: "DELETE" }),

  /**
   * The optional SEO tools. Local-only: the DataForSEO credentials belong to
   * the operator's own engine, so switching to another install in the sidebar
   * must not point that engine at the research, or empty the page.
   */
  seoStatus: () => localRequest<SeoStatus>("/api/admin/seo/status"),
  seoMarkets: () => localRequest<{ markets: SeoMarket[] }>("/api/admin/seo/markets"),

  /**
   * The explorer: every endpoint the account can call, discovered from the
   * provider rather than listed here, so a new one needs no release.
   */
  seoCatalogue: () => localRequest<SeoCatalogue>("/api/admin/seo/catalogue"),
  seoTemplate: (
    path: string,
    family: string,
    market: { locationCode: number | null; languageCode: string | null }
  ) =>
    localRequest<{ endpoint: SeoEndpoint; params: Record<string, unknown> }>(
      "/api/admin/seo/template",
      {
        method: "POST",
        body: JSON.stringify({
          path,
          family,
          locationCode: market.locationCode ?? undefined,
          languageCode: market.languageCode ?? undefined,
        }),
      }
    ),
  /** Build the document a prospect is sent, and keep it at its own link. */
  seoBuildReport: (input: SeoReportInput) =>
    localRequest<SeoReportResult>("/api/admin/seo/report", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  seoReports: () => localRequest<{ reports: SeoReportSummary[] }>("/api/admin/seo/reports"),
  /**
   * The work list as Markdown. Fetched rather than linked: these routes are
   * bearer-protected, and a plain link carries no Authorization header, so
   * opening one in a tab just returns 401.
   */
  seoWorklistMarkdown: async (token: string) => {
    const res = await fetch(`/api/admin/seo/report/${token}/worklist?format=md`, {
      headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    });
    if (!res.ok) throw new ApiError(res.status, `Could not load the work list (${res.status})`);
    return res.text();
  },

  seoCall: (input: SeoCallInput) =>
    localRequest<{ endpoint: SeoEndpoint; run: SeoExplorerRun }>("/api/admin/seo/call", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  seoQuote: (tool: SeoToolId, limit: number) =>
    localRequest<{ tool: SeoToolId; limit: number; estimateUsd: number | null }>(
      "/api/admin/seo/quote",
      { method: "POST", body: JSON.stringify({ tool, limit }) }
    ),
  seoRun: (tool: SeoToolId, input: SeoRunInput) =>
    localRequest<SeoRun>("/api/admin/seo/run", {
      method: "POST",
      body: JSON.stringify({ tool, ...input }),
    }),
  seoHistory: () =>
    localRequest<{ lookups: SeoHistoryEntry[] }>("/api/admin/seo/history"),
  seoClearCache: (tool?: SeoToolId) =>
    localRequest<{ cleared: number }>("/api/admin/seo/cache/clear", {
      method: "POST",
      body: JSON.stringify(tool ? { tool } : {}),
    }),
};
