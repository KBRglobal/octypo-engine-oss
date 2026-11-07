/**
 * Client-facing report page — GET /report?key=<CLIENT_REPORT_KEY>.
 *
 * The paying client's single link: a read-only, server-rendered HTML page
 * showing what the engine delivered (stat tiles, an 8-week rhythm chart,
 * published-article cards linked to the live site, a quiet scheduled-ahead
 * line). View-only, zero actions, no login, no admin code. Visual layer
 * follows the approved "quiet command center" design: graphite surfaces,
 * warm off-white type, a single ember accent, mono tabular numerals.
 *
 * Security posture (threat model T-qr-01..05):
 * - Key gate: constant-time compare (length pre-check + timingSafeEqual);
 *   404 when the feature is off (CLIENT_REPORT_KEY unset) so the route is
 *   indistinguishable from a missing page.
 * - Every dynamic string (model-written titles, slugs, site name) passes
 *   through escapeHtml before it reaches the page.
 * - Queries are read-only and touch only published/scheduled data — never
 *   spend, scores, or held/rejected items. The negative test in
 *   report.test.ts asserts their absence in the rendered output.
 * - Global middleware already sets X-Robots-Tag noindex; this route adds
 *   Cache-Control: no-store (the key rides the URL).
 */

import { timingSafeEqual } from "node:crypto";

import { db } from "../db.js";
import { contents, articles } from "../schema/index.js";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { resolveLocale, type ClusterLocale } from "../config/locale.js";

// ── Key gate ───────────────────────────────────────────────────────────────

/**
 * Gate verdict for the report key.
 * "off"    — feature disabled (no CLIENT_REPORT_KEY configured) → 404.
 * "denied" — key configured but the caller's key does not match → 401.
 * "ok"     — exact match.
 *
 * Same constant-time shape as the preview-token check in src/index.ts:
 * mismatched lengths must be rejected BEFORE timingSafeEqual (it throws on
 * unequal buffer lengths).
 */
export function checkReportKey(
  provided: unknown,
  expected: string | undefined
): "off" | "denied" | "ok" {
  if (!expected || expected.trim() === "") return "off";
  if (typeof provided !== "string" || provided.length === 0) return "denied";
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return "denied";
  }
  return "ok";
}

// ── Data shape ─────────────────────────────────────────────────────────────

export interface WeekBucket {
  /** Monday 00:00 local time of the bucket's week. */
  start: Date;
  count: number;
}

export interface ReportTableRow {
  title: string;
  slug: string;
  wordCount: number;
  publishedAt: Date | null;
  /** First topic slug (or category fallback); null renders an em dash. */
  topic: string | null;
  /** Card image URL (card_image || hero_image); null renders the graphite placeholder. */
  image: string | null;
}

export interface ReportData {
  siteName: string;
  /** Owner's personal name (CLIENT_OWNER_NAME) — greets them when set. */
  ownerName: string | null;
  /** Live site origin (no trailing slash) or null — null means no anchors. */
  siteUrl: string | null;
  /** Public article path prefix on the live site, e.g. "/guides". */
  articlePathPrefix: string;
  /** Server "now" — period label + bucket math both derive from it. */
  now: Date;
  publishedThisMonth: number;
  totalLive: number;
  totalWords: number;
  topicsCovered: number;
  /** Exactly 8 buckets, oldest → newest, Monday-start weeks. */
  weekly: WeekBucket[];
  /** Up to 20 published rows, newest first. */
  recent: ReportTableRow[];
  /** Approved work waiting: status IN ('scheduled','draft'). */
  scheduledAhead: number;
}

// ── HTML escaping ──────────────────────────────────────────────────────────

/** Every dynamic string on the page goes through this. No exceptions. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Pure computation (exported for direct testing) ─────────────────────────

/**
 * 8 Monday-start weekly buckets ending with the current week, oldest first.
 * All math in server-local time (TZ is set per install, e.g. Asia/Jerusalem).
 */
export function buildWeeklyBuckets(
  dates: ReadonlyArray<Date | null | undefined>,
  now: Date = new Date()
): WeekBucket[] {
  // getDay(): Sunday 0 … Saturday 6 → distance back to Monday.
  const backToMonday = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backToMonday);
  const buckets: WeekBucket[] = [];
  for (let i = 7; i >= 0; i--) {
    buckets.push({
      start: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - i * 7),
      count: 0,
    });
  }
  const windowStart = buckets[0].start.getTime();
  const windowEnd = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 7
  ).getTime();
  for (const date of dates) {
    if (!date) continue;
    const t = date.getTime();
    if (Number.isNaN(t) || t < windowStart || t >= windowEnd) continue;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (t >= buckets[i].start.getTime()) {
        buckets[i].count++;
        break;
      }
    }
  }
  return buckets;
}

/** Live URL for a published slug, or null when the install has no SITE_URL. */
export function liveUrlFor(
  siteUrl: string | null,
  articlePathPrefix: string,
  slug: string
): string | null {
  if (!siteUrl) return null;
  return `${siteUrl}${articlePathPrefix}/${encodeURIComponent(slug)}`;
}

function envSiteUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.SITE_URL ?? "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function envPathPrefix(env: NodeJS.ProcessEnv): string {
  return (env.ARTICLE_PATH_PREFIX || "/guides").replace(/\/$/, "");
}

/** Raw shape of a published row as selected from the database. */
export interface PublishedRowInput {
  title: string;
  slug: string;
  wordCount: number | null;
  publishedAt: Date | null;
  /** articles.relatedTopicIds — topic slugs; null on a missing join row. */
  topics: string[] | null;
  category: string | null;
  /** contents.cardImage — preferred card visual. */
  cardImage?: string | null;
  /** contents.heroImage — fallback when no card image exists. */
  heroImage?: string | null;
}

/** Pure aggregation: published rows + scheduled count → the full page data. */
export function buildReportData(
  rows: ReadonlyArray<PublishedRowInput>,
  scheduledAhead: number,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): ReportData {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const publishedThisMonth = rows.filter(
    (r) => r.publishedAt && r.publishedAt.getTime() >= monthStart.getTime()
  ).length;
  const totalWords = rows.reduce((sum, r) => sum + (r.wordCount ?? 0), 0);

  // Topics covered: distinct topic slugs across all published rows; when no
  // row carries topic slugs at all, fall back to distinct categories.
  const topicSlugs = new Set<string>();
  for (const r of rows) for (const t of r.topics ?? []) if (t) topicSlugs.add(t);
  let topicsCovered = topicSlugs.size;
  if (topicsCovered === 0) {
    const categories = new Set(rows.map((r) => r.category).filter((c): c is string => Boolean(c)));
    topicsCovered = categories.size;
  }

  const newestFirst = [...rows].sort(
    (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)
  );
  const recent: ReportTableRow[] = newestFirst.slice(0, 20).map((r) => ({
    title: r.title,
    slug: r.slug,
    wordCount: r.wordCount ?? 0,
    publishedAt: r.publishedAt,
    topic: (r.topics ?? [])[0] ?? r.category ?? null,
    image: r.cardImage ?? r.heroImage ?? null,
  }));

  return {
    siteName: (env.SITE_NAME ?? "").trim() || "Octypo",
    ownerName: (env.CLIENT_OWNER_NAME ?? "").trim() || null,
    siteUrl: envSiteUrl(env),
    articlePathPrefix: envPathPrefix(env),
    now,
    publishedThisMonth,
    totalLive: rows.length,
    totalWords,
    topicsCovered,
    weekly: buildWeeklyBuckets(rows.map((r) => r.publishedAt), now),
    recent,
    scheduledAhead,
  };
}

// ── Default data loader (read-only) ────────────────────────────────────────

/**
 * Read-only SELECTs against contents + articles only. The published corpus is
 * small (hundreds of rows) — one select plus one count, aggregate in JS.
 * Deliberately never selects spend, scores, or held/rejected items (T-qr-03).
 */
export async function loadReportData(
  env: NodeJS.ProcessEnv = process.env
): Promise<ReportData> {
  const rows = await db
    .select({
      title: contents.title,
      slug: contents.slug,
      wordCount: contents.wordCount,
      publishedAt: contents.publishedAt,
      topics: articles.relatedTopicIds,
      category: articles.category,
      cardImage: contents.cardImage,
      heroImage: contents.heroImage,
    })
    .from(contents)
    .leftJoin(articles, eq(articles.contentId, contents.id))
    .where(and(eq(contents.status, "published"), isNull(contents.deletedAt)))
    .orderBy(desc(contents.publishedAt));

  // Approved work waiting for its slot: approve → draft → auto-scheduled.
  const [{ value: ahead }] = await db
    .select({ value: sql<string>`count(*)` })
    .from(contents)
    .where(and(inArray(contents.status, ["scheduled", "draft"]), isNull(contents.deletedAt)));

  return buildReportData(rows, Number(ahead) || 0, env, new Date());
}

// ── UI strings ─────────────────────────────────────────────────────────────

interface ReportStrings {
  reportTitle: string;
  tagline: string;
  /** Personal greeting when the install knows the owner's name. */
  greeting: (name: string) => string;
  engineStatus: string;
  liveSystem: string;
  tilePublishedThisMonth: string;
  tileTotalLive: string;
  tileTotalWords: string;
  tileTopics: string;
  weeklyTitle: string;
  recentTitle: string;
  words: string;
  scheduledAhead: (n: string) => string;
  empty: string;
}

const STRINGS: ReportStrings = {
  reportTitle: "Content Report",
  tagline: "Your content engine · always publishing in the background",
  greeting: (name) => `Hello ${name}, here is what the engine has been doing for you`,
  engineStatus: "Engine status: active and publishing",
  liveSystem: "Live content system",
  tilePublishedThisMonth: "Published this month",
  tileTotalLive: "Live articles",
  tileTotalWords: "Words published",
  tileTopics: "Topics in play",
  weeklyTitle: "8-week rhythm",
  recentTitle: "Published articles",
  words: "words",
  scheduledAhead: (n) => `Approved articles waiting in the publish queue: ${n}`,
  empty: "No published articles yet.",
};

/**
 * Only plain http(s) or root-relative URLs reach an <img src> — anything else
 * (javascript:, data:, garbage) falls back to the graphite placeholder. The
 * value is model/storage-written, so it gets the same distrust as titles.
 */
function safeImageUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || (trimmed.startsWith("/") && !trimmed.startsWith("//"))) {
    return trimmed;
  }
  return null;
}

// ── Renderer ───────────────────────────────────────────────────────────────

export function renderReportHtml(data: ReportData, locale: ClusterLocale): string {
  const dict = STRINGS;
  // The page copy is English; numbers and dates follow the install's locale.
  const fmtLocale = `${locale.language}-${locale.country}`;
  const num = new Intl.NumberFormat(fmtLocale);
  const dateFmt = new Intl.DateTimeFormat(fmtLocale, { dateStyle: "medium" });
  const weekFmt = new Intl.DateTimeFormat(fmtLocale, { day: "numeric", month: "numeric" });

  const siteName = escapeHtml(data.siteName);
  const pageTitle = `${siteName} — ${escapeHtml(dict.reportTitle)}`;

  // Fonts: the approved "quiet command center" design line. JetBrains Mono
  // renders every numeral, kicker, and meta line with tabular rhythm.
  const fontFamilies =
    "family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600";

  // Tiles
  const tiles: Array<[string, number]> = [
    [dict.tilePublishedThisMonth, data.publishedThisMonth],
    [dict.tileTotalLive, data.totalLive],
    [dict.tileTotalWords, data.totalWords],
    [dict.tileTopics, data.topicsCovered],
  ];
  const tilesHtml = tiles
    .map(
      ([label, value]) => `<div class="tile">
      <p class="num">${escapeHtml(num.format(value))}</p>
      <p class="label">${escapeHtml(label)}</p>
    </div>`
    )
    .join("\n    ");

  // Rhythm chart: subtle ink bars normalized to the busiest week; the current
  // (last) week carries the single ember tip. A zero week keeps its empty
  // track (max guarded — never divide by zero).
  const maxCount = data.weekly.reduce((m, b) => Math.max(m, b.count), 0);
  const lastIdx = data.weekly.length - 1;
  const barsHtml = data.weekly
    .map((bucket, i) => {
      const pct = maxCount > 0 ? Math.max(Math.round((bucket.count / maxCount) * 100), 8) : 0;
      const isCurrent = i === lastIdx;
      let inner = "";
      if (bucket.count > 0) {
        inner = `<div class="bar${isCurrent ? " cur" : ""}" style="height:${pct}%"></div>`;
      } else if (isCurrent) {
        inner = '<div class="tip-base"></div>';
      }
      return `<div class="track" title="${escapeHtml(num.format(bucket.count))}">${inner}</div>`;
    })
    .join("\n        ");
  const weekLabelsHtml = data.weekly
    .map((bucket) => `<span>${escapeHtml(weekFmt.format(bucket.start))}</span>`)
    .join("");

  // Article cards (defensively capped at 20 even if fed more)
  const cardsHtml = data.recent
    .slice(0, 20)
    .map((row) => {
      const url = liveUrlFor(data.siteUrl, data.articlePathPrefix, row.slug);
      const title = url
        ? `<a href="${escapeHtml(url)}" dir="auto" target="_blank" rel="noopener">${escapeHtml(row.title)}</a>`
        : `<span dir="auto">${escapeHtml(row.title)}</span>`;
      const img = safeImageUrl(row.image);
      const visual = img
        ? `<img class="thumb" src="${escapeHtml(img)}" alt="" loading="lazy">`
        : '<div class="thumb ph"></div>';
      const meta: string[] = [];
      if (row.publishedAt) meta.push(`<span>${escapeHtml(dateFmt.format(row.publishedAt))}</span>`);
      meta.push(`<span>${escapeHtml(num.format(row.wordCount))} ${escapeHtml(dict.words)}</span>`);
      if (row.topic) meta.push(`<span class="topic">${escapeHtml(row.topic)}</span>`);
      return `<article class="art">
        ${visual}
        <div class="art-body">
          <h3>${title}</h3>
          <div class="meta">${meta.join('<span class="sep">·</span>')}</div>
        </div>
      </article>`;
    })
    .join("\n      ");

  const articlesHtml =
    data.recent.length > 0
      ? `<div class="arts">
      ${cardsHtml}
      </div>`
      : `<p class="muted">${escapeHtml(dict.empty)}</p>`;

  const scheduledHtml =
    data.scheduledAhead > 0
      ? `<p class="sched"><span class="dot"></span>${escapeHtml(
          dict.scheduledAhead(num.format(data.scheduledAhead))
        )}</p>`
      : "";

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${fontFamilies}&display=swap" rel="stylesheet">
<style>
:root{
  color-scheme: dark;
  --bg:#0d1117; --fg:#f2efeb; --ember:#e05d38; --ember-soft:#ff8364;
  --card:#131923; --card-2:#18202c; --ink:#1b222e; --muted-fg:#8491a2;
  --border:#1e242e; --accent-bg:#261916; --soft-fg:#d1d9e0;
  --radius:10px;
  --font-sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--font-sans);
  font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
::selection{background:rgba(224,93,56,.2);color:var(--fg)}
.topline{position:fixed;top:0;inset-inline:0;height:1px;z-index:30;opacity:.7;
  background:linear-gradient(90deg,transparent,rgba(224,93,56,.5),transparent)}
.wrap{max-width:1280px;margin:0 auto;padding:56px 24px 24px}
@media(min-width:768px){.wrap{padding:72px 48px 32px}}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;
  gap:24px;padding-bottom:40px;border-bottom:1px solid rgba(30,36,46,.8)}
.kickrow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.kick{font-family:var(--font-mono);font-size:11px;font-weight:500;
  letter-spacing:.2em;text-transform:uppercase;color:var(--muted-fg)}
.live{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;
  background:rgba(38,25,22,.6);border:1px solid rgba(224,93,56,.2);
  font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:.08em;color:var(--ember)}
.live .dot{width:6px;height:6px;border-radius:50%;background:var(--ember);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
h1{font-size:clamp(34px,5vw,48px);font-weight:600;letter-spacing:-.02em;line-height:1.1;margin-top:12px}
.tag{color:var(--muted-fg);font-size:14px;margin-top:10px}
.status{display:inline-flex;align-items:center;gap:10px;font-family:var(--font-mono);
  font-size:12px;color:var(--muted-fg);background:rgba(19,25,35,.6);
  border:1px solid rgba(30,36,46,.6);padding:10px 16px;border-radius:var(--radius)}
.status .dot{width:8px;height:8px;border-radius:50%;background:rgba(224,93,56,.9)}
.tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:48px}
@media(min-width:960px){.tiles{grid-template-columns:repeat(4,1fr);gap:20px}}
.tile{background:rgba(19,25,35,.5);border:1px solid rgba(30,36,46,.7);
  border-radius:var(--radius);padding:24px}
.num{font-family:var(--font-mono);font-size:34px;font-weight:500;line-height:1;
  letter-spacing:-.02em;font-variant-numeric:tabular-nums}
@media(min-width:768px){.num{font-size:38px}}
.label{color:var(--muted-fg);font-size:12px;margin-top:12px}
.grid{display:grid;grid-template-columns:1fr;gap:32px;align-items:start;margin-top:48px}
@media(min-width:1024px){.grid{grid-template-columns:1fr 360px}}
.seckick{font-family:var(--font-mono);font-size:11px;font-weight:500;
  letter-spacing:.16em;text-transform:uppercase;color:var(--muted-fg)}
h2{font-size:26px;font-weight:600;margin-top:6px}
.arts{display:flex;flex-direction:column;gap:14px;margin-top:22px}
.art{display:flex;flex-direction:column;gap:18px;align-items:flex-start;
  background:rgba(19,25,35,.5);border:1px solid rgba(30,36,46,.7);
  border-radius:var(--radius);padding:18px;transition:background .2s,border-color .2s}
@media(min-width:640px){.art{flex-direction:row;align-items:center;gap:20px}}
.art:hover{background:rgba(19,25,35,.8);border-color:var(--border)}
.thumb{width:100%;height:112px;border-radius:6px;object-fit:cover;flex-shrink:0;
  border:1px solid rgba(30,36,46,.6);filter:grayscale(25%) contrast(1.05)}
@media(min-width:640px){.thumb{width:144px;height:96px}}
.ph{background:linear-gradient(135deg,#18202c 0%,#131923 55%,#0d1117 100%)}
.art-body{flex:1;min-width:0}
.art h3{font-size:17px;font-weight:500;line-height:1.45}
.art a{color:inherit;text-decoration:none}
.art a:hover{color:var(--ember-soft)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px;
  font-family:var(--font-mono);font-size:12px;color:var(--muted-fg);
  font-variant-numeric:tabular-nums}
.meta .sep{color:var(--border)}
.meta .topic{font-family:var(--font-sans);color:var(--soft-fg)}
.panel{background:rgba(19,25,35,.5);border:1px solid rgba(30,36,46,.7);
  border-radius:var(--radius);padding:24px}
.panel h2{font-size:20px;font-weight:500}
.bars{height:144px;display:flex;align-items:flex-end;gap:8px;margin-top:24px;
  border-bottom:1px solid rgba(30,36,46,.6);padding-bottom:4px}
.track{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end}
.bar{width:100%;min-height:6px;background:var(--card-2);border-radius:2px 2px 0 0;position:relative}
.bar.cur::after{content:"";position:absolute;top:0;inset-inline:0;height:4px;
  background:var(--ember);border-radius:2px 2px 0 0}
.tip-base{width:100%;height:3px;background:rgba(224,93,56,.55);border-radius:2px 2px 0 0}
.wks{display:flex;gap:8px;margin-top:10px;font-family:var(--font-mono);
  font-size:10px;color:rgba(132,145,162,.8)}
.wks span{flex:1;text-align:center;white-space:nowrap;overflow:hidden}
.muted{color:var(--muted-fg);margin-top:22px}
.sched{display:flex;align-items:center;gap:10px;margin-top:40px;
  color:var(--muted-fg);font-size:13px}
.sched .dot{width:6px;height:6px;border-radius:50%;background:var(--ember);flex-shrink:0}
footer{margin-top:64px;padding-top:28px;padding-bottom:16px;
  border-top:1px solid rgba(30,36,46,.6);display:flex;flex-wrap:wrap;gap:16px;
  align-items:center;justify-content:space-between;
  font-family:var(--font-mono);font-size:12px;color:var(--muted-fg)}
</style>
</head>
<body>
<div class="topline"></div>
<div class="wrap">
  <header>
    <div>
      <div class="kickrow">
        <span class="kick">OCTYPO / CLIENT PORTAL</span>
        <span class="live"><span class="dot"></span>LIVE</span>
      </div>
      <h1>${siteName}</h1>
      <p class="tag">${escapeHtml(
        data.ownerName ? dict.greeting(data.ownerName) : dict.tagline
      )}</p>
    </div>
    <div class="status"><span class="dot"></span><span>${escapeHtml(dict.engineStatus)}</span></div>
  </header>

  <section class="tiles">
    ${tilesHtml}
  </section>

  <div class="grid">
    <section>
      <p class="seckick">PUBLISHED CONTENT</p>
      <h2>${escapeHtml(dict.recentTitle)}</h2>
      ${articlesHtml}
    </section>

    <aside>
      <section class="panel">
        <p class="seckick">PUBLISHING RHYTHM</p>
        <h2>${escapeHtml(dict.weeklyTitle)}</h2>
        <div class="bars">
        ${barsHtml}
        </div>
        <div class="wks">${weekLabelsHtml}</div>
      </section>
    </aside>
  </div>

  ${scheduledHtml}

  <footer>
    <span>${escapeHtml(dict.liveSystem)} · ${siteName}</span>
    <span>Powered by Octypo</span>
  </footer>
</div>
</body>
</html>
`;
}

// ── Handler ────────────────────────────────────────────────────────────────

interface ReportRequest {
  query?: Record<string, unknown>;
}

interface ReportResponse {
  status(code: number): ReportResponse;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

export interface ReportHandlerDeps {
  loadReportData?: (env: NodeJS.ProcessEnv) => Promise<ReportData>;
  resolveLocale?: (cluster: string | null) => Promise<ClusterLocale>;
  env?: NodeJS.ProcessEnv;
}

export function createReportHandler(deps: ReportHandlerDeps = {}) {
  return async (req: ReportRequest, res: ReportResponse): Promise<void> => {
    const env = deps.env ?? process.env;
    // Never cacheable — the key rides the URL.
    res.setHeader("Cache-Control", "no-store");

    const verdict = checkReportKey(req.query?.key, env.CLIENT_REPORT_KEY);
    if (verdict === "off") {
      res.status(404).send("Not found");
      return;
    }
    if (verdict === "denied") {
      res.status(401).send("Invalid key");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    try {
      const [data, locale] = await Promise.all([
        (deps.loadReportData ?? loadReportData)(env),
        (deps.resolveLocale ?? resolveLocale)(null),
      ]);
      res.status(200).send(renderReportHtml(data, locale));
    } catch (error) {
      logger.error({ error }, "[Report] Failed to render the client report");
      res
        .status(500)
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report</title></head>' +
            "<body><p>The report is temporarily unavailable. Please try again shortly.</p></body></html>"
        );
    }
  };
}
