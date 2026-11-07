/**
 * Durable side of the cost meter.
 *
 * The in-memory meter answers "what is happening right now"; this ledger
 * answers the business question — what did this client cost us this month —
 * and keeps answering it across restarts and deploys.
 *
 * Recording is fire-and-forget through a lazy import: the meter is wired into
 * the engine registry, which unit tests import with the database mocked away,
 * and a spend record must never take down the call that already paid for it.
 */

import type { CostRecord } from "./meter.js";

// One failed insert must not silence the ledger forever: a deploy's first
// call often races the migration. Back off for a minute, then try again.
let retryAfter = 0;

export function persistCostRecord(record: CostRecord): void {
  if (Date.now() < retryAfter) return;
  void (async () => {
    try {
      const { db } = await import("../db.js");
      const { costLedger } = await import("../schema/index.js");
      await db.insert(costLedger).values({
        day: record.day,
        provider: record.provider,
        model: record.model,
        kind: record.kind,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        images: record.images,
        costMicroUsd: Math.round(record.costUsd * 1e6),
        articleId: record.articleId,
      });
    } catch {
      retryAfter = Date.now() + 60_000;
    }
  })();
}

export interface LedgerReport {
  todayUsd: number;
  monthUsd: number;
  totalUsd: number;
  perDay: { day: string; usd: number; calls: number }[];
  perModel: { model: string; usd: number; calls: number }[];
  articlesMetered: number;
  avgArticleUsd: number;
}

/** Aggregate the ledger for the Studio. All sums are integer micro-USD. */
export async function ledgerReport(days = 30): Promise<LedgerReport> {
  const { db } = await import("../db.js");
  const { costLedger } = await import("../schema/index.js");
  const { sql, gte } = await import("drizzle-orm");

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const windowStart = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const rows = await db
    .select({
      day: costLedger.day,
      model: costLedger.model,
      micro: sql<number>`sum(${costLedger.costMicroUsd})::bigint`,
      calls: sql<number>`count(*)::int`,
      articles: sql<number>`count(distinct ${costLedger.articleId})::int`,
    })
    .from(costLedger)
    .where(gte(costLedger.day, windowStart))
    .groupBy(costLedger.day, costLedger.model);

  const [allTime] = await db
    .select({ micro: sql<number>`coalesce(sum(${costLedger.costMicroUsd}),0)::bigint` })
    .from(costLedger);

  const perDayMap = new Map<string, { usd: number; calls: number }>();
  const perModelMap = new Map<string, { usd: number; calls: number }>();
  let todayMicro = 0;
  let monthMicro = 0;
  let articles = 0;

  for (const row of rows) {
    const usd = Number(row.micro) / 1e6;
    const dayEntry = perDayMap.get(row.day) ?? { usd: 0, calls: 0 };
    dayEntry.usd += usd;
    dayEntry.calls += row.calls;
    perDayMap.set(row.day, dayEntry);

    const modelEntry = perModelMap.get(row.model) ?? { usd: 0, calls: 0 };
    modelEntry.usd += usd;
    modelEntry.calls += row.calls;
    perModelMap.set(row.model, modelEntry);

    if (row.day === today) todayMicro += Number(row.micro);
    if (row.day >= monthStart) monthMicro += Number(row.micro);
    articles += row.articles;
  }

  const monthUsd = monthMicro / 1e6;
  return {
    todayUsd: todayMicro / 1e6,
    monthUsd,
    totalUsd: Number(allTime?.micro ?? 0) / 1e6,
    perDay: [...perDayMap.entries()]
      .map(([day, v]) => ({ day, usd: Number(v.usd.toFixed(4)), calls: v.calls }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    perModel: [...perModelMap.entries()]
      .map(([model, v]) => ({ model, usd: Number(v.usd.toFixed(4)), calls: v.calls }))
      .sort((a, b) => b.usd - a.usd),
    articlesMetered: articles,
    avgArticleUsd: articles > 0 ? Number((monthUsd / articles).toFixed(4)) : 0,
  };
}
