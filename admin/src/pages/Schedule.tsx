/**
 * The publish queue: approved articles waiting for their slot, and anything
 * already scheduled. Dates are set here; the engine's publish scheduler
 * promotes them when the time comes.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Send, Shuffle } from "lucide-react";

import { api } from "../lib/api";
import type { ArticleListItem } from "../lib/types";
import { Card, CardHeader, Chip, EmptyState, GhostButton } from "../components/studio";
import { useToast } from "../components/Toast";

function fmt(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Schedule() {
  const { toast } = useToast();
  const [scheduled, setScheduled] = useState<ArticleListItem[]>([]);
  const [drafts, setDrafts] = useState<ArticleListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.listArticles({ status: "scheduled", limit: 200 }),
      api.listArticles({ status: "draft", limit: 200 }),
    ])
      .then(([s, d]) => {
        setScheduled(
          [...s.articles].sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? ""))
        );
        setDrafts(d.articles);
      })
      .catch((err) => toast((err as Error).message, "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(load, [load]);

  const schedule = async (article: ArticleListItem) => {
    const value = window.prompt(
      "Publish at (YYYY-MM-DD HH:MM, local time):",
      new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ")
    );
    if (!value) return;
    const when = new Date(value.replace(" ", "T"));
    if (Number.isNaN(when.getTime())) {
      toast("Not a valid date", "error");
      return;
    }
    try {
      await api.scheduleArticle(article.id, when.toISOString());
      toast(`Scheduled: ${fmt(when.toISOString())}`, "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const publishNow = async (article: ArticleListItem) => {
    try {
      await api.publishArticle(article.id);
      toast("Published", "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Schedule</h1>
          <p className="text-sm text-muted-foreground">
            Approved articles drip out on a human rhythm — varying counts, odd minutes.
          </p>
        </div>
        <GhostButton
          onClick={async () => {
            try {
              const res = await api.autoSchedule();
              toast(
                res.scheduled === 0
                  ? "Nothing unscheduled"
                  : `${res.scheduled} drafts given randomised slots`,
                "success"
              );
              load();
            } catch (err) {
              toast((err as Error).message, "error");
            }
          }}
        >
          <Shuffle size={13} /> Auto-schedule randomly
        </GhostButton>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Scheduled"
            action={<Chip tone="info">{scheduled.length} queued</Chip>}
          />
          {loading ? (
            <EmptyState title="Loading…" />
          ) : scheduled.length === 0 ? (
            <EmptyState title="Nothing scheduled">
              Approve drafts in Review, then give them slots here.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border/60">
              {scheduled.map((article) => (
                <li key={article.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{article.title}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                      <CalendarClock size={11} /> {fmt(article.scheduledFor)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <GhostButton onClick={() => schedule(article)}>Reschedule</GhostButton>
                    <GhostButton onClick={() => publishNow(article)}>
                      <Send size={13} /> Now
                    </GhostButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Approved, unscheduled" action={<Chip tone="neutral">{drafts.length}</Chip>} />
          {loading ? (
            <EmptyState title="Loading…" />
          ) : drafts.length === 0 ? (
            <EmptyState title="Queue is clear" />
          ) : (
            <ul className="divide-y divide-border/60">
              {drafts.map((article) => (
                <li key={article.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <p className="min-w-0 truncate text-sm font-medium">{article.title}</p>
                  <div className="flex shrink-0 gap-2">
                    <GhostButton onClick={() => schedule(article)}>
                      <CalendarClock size={13} /> Schedule
                    </GhostButton>
                    <GhostButton onClick={() => publishNow(article)}>
                      <Send size={13} /> Publish now
                    </GhostButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
