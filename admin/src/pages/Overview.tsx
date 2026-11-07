/**
 * The first screen of the day: how far along the month is, what needs the
 * operator, and whether the engine is healthy — before any navigation.
 */
import { useEffect, useState } from "react";
import { ArrowLeft, FileCheck2, Lightbulb, PlayCircle } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import type { BankSummary, Stats } from "../lib/types";
import { Card, CardHeader, Chip, EmptyState, GhostButton, Stat } from "../components/studio";
import { RankCard } from "../components/RankCard";
import { useToast } from "../components/Toast";

export default function Overview() {
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [bank, setBank] = useState<BankSummary | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined);
    api
      .listIdeas({ limit: 1 })
      .then((res) => setBank(res.summary))
      .catch(() => undefined);
    api
      .listArticles({ status: "in_review", limit: 1 })
      .then((res) => setReviewCount(res.total))
      .catch(() => undefined);
  }, []);

  const trigger = async () => {
    try {
      const res = await api.triggerPipeline();
      toast(`Pipeline triggered — ${res.created} new writes`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const counts = stats?.counts ?? {};
  const published = counts["published"] ?? 0;
  const drafts = (counts["draft"] ?? 0) + (counts["in_review"] ?? 0);

  const needs: { label: string; count: number; to: string; icon: typeof Lightbulb }[] = [];
  if (reviewCount) needs.push({ label: "drafts waiting for review", count: reviewCount, to: "/review", icon: FileCheck2 });
  if (bank && bank.planned === 0 && bank.total === 0)
    needs.push({ label: "the idea bank is empty — build it", count: 0, to: "/ideas", icon: Lightbulb });

  return (
    <>
      <div className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-r from-card via-secondary/30 to-card p-6 shadow-sm">
        <div className="relative z-10 flex flex-col justify-between gap-6 md:flex-row md:items-center">
          <div>
            <p className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-primary">
              Engine status
            </p>
            <h1 className="mt-1 font-heading text-3xl font-bold uppercase tracking-wide md:text-4xl">
              {published} published · {drafts} in the pipeline
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {bank
                ? `${bank.planned} ideas planned, ${bank.written} already written.`
                : "Loading the plan…"}
            </p>
          </div>
          <GhostButton onClick={trigger}>
            <PlayCircle size={15} /> Run a pipeline pass
          </GhostButton>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Today" value={stats?.articlesToday ?? "—"} sub="articles written" />
        <Stat label="This week" value={stats?.articlesThisWeek ?? "—"} sub="articles written" />
        <Stat
          label="Waiting for you"
          value={reviewCount ?? "—"}
          tone={reviewCount ? "primary" : "default"}
          sub="drafts in review"
        />
        <Stat label="Idea bank" value={bank?.planned ?? "—"} sub="planned ideas remaining" />
      </div>

      <RankCard />

      <Card>
        <CardHeader title="Needs you" />
        {needs.length === 0 ? (
          <EmptyState title="All clear">
            Nothing is waiting on a human decision right now.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/60">
            {needs.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="flex items-center justify-between px-5 py-3.5 transition hover:bg-accent/40"
                >
                  <div className="flex items-center gap-3">
                    <item.icon size={16} className="text-primary" />
                    <span className="text-sm font-medium">
                      {item.count > 0 && (
                        <span className="me-2 font-mono text-primary">{item.count}</span>
                      )}
                      {item.label}
                    </span>
                  </div>
                  <ArrowLeft size={15} className="rotate-180 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {stats?.recentGate1 && stats.recentGate1.length > 0 && (
        <Card>
          <CardHeader title="Recent gate decisions" action={<Chip tone="neutral">RSS intake</Chip>} />
          <ul className="divide-y divide-border/60">
            {stats.recentGate1.slice(0, 8).map((item, index) => (
              <li key={index} className="flex items-center justify-between gap-4 px-5 py-2.5">
                <span className="truncate text-sm">{(item as { title?: string }).title ?? ""}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {(item as { score?: number }).score ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
