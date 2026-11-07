/**
 * The editorial desk: drafts on the right, a faithful preview on the left,
 * approve as the primary verb. Keyboard-first — j/k to move, a to approve —
 * because the operator clears this queue daily.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, PenLine, ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../lib/api";
import type { ArticleFull, ArticleListItem } from "../lib/types";
import { engineBlocksToHTML } from "../lib/blocks";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton } from "../components/studio";
import { useToast } from "../components/Toast";

interface AuditInfo {
  unsupported: string[];
}

function auditOf(article: ArticleFull | null): AuditInfo | null {
  const schema = (article as unknown as { seoSchema?: { numberAudit?: AuditInfo } } | null)?.seoSchema;
  return schema?.numberAudit ?? null;
}

export default function StudioReview() {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<ArticleListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [article, setArticle] = useState<ArticleFull | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listArticles({ status: "in_review", limit: 100 })
      .then((res) => {
        setDrafts(res.articles);
        setSelectedId((current) => current ?? res.articles[0]?.id ?? null);
      })
      .catch((err) => toast((err as Error).message, "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!selectedId) {
      setArticle(null);
      return;
    }
    api
      .getArticle(selectedId)
      .then((res) => setArticle(res.article))
      .catch((err) => toast((err as Error).message, "error"));
  }, [selectedId, toast]);

  const approve = useCallback(async () => {
    if (!selectedId) return;
    try {
      // Approve queues; the engine slots it into the randomised calendar and
      // publishes on time. Instant publish stays available as the secondary.
      await api.approveArticle(selectedId);
      toast("Approved — queued for a publish slot", "success");
      setDrafts((prev) => {
        const remaining = prev.filter((draft) => draft.id !== selectedId);
        setSelectedId(remaining[0]?.id ?? null);
        return remaining;
      });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [selectedId, toast]);

  // j/k/a — but never while the operator is typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      const index = drafts.findIndex((draft) => draft.id === selectedId);
      if (event.key === "j" && index < drafts.length - 1) setSelectedId(drafts[index + 1].id);
      if (event.key === "k" && index > 0) setSelectedId(drafts[index - 1].id);
      if (event.key === "a") void approve();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drafts, selectedId, approve]);

  const audit = auditOf(article);

  // Unsupported numbers get highlighted inline, so the operator sees exactly
  // what the audit is complaining about without hunting for it.
  const previewHtml = useMemo(() => {
    if (!article) return "";
    let html = engineBlocksToHTML((article as unknown as { blocks?: never[] }).blocks ?? []);
    for (const value of audit?.unsupported ?? []) {
      const pretty = value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      for (const needle of new Set([value, pretty])) {
        html = html.split(needle).join(
          `<mark style="background:rgba(255,71,87,.18);color:#FF4757;border-bottom:1px solid #FF4757;border-radius:2px;padding:0 2px">${needle}</mark>`
        );
      }
    }
    return html;
  }, [article, audit]);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Review</h1>
          <p className="text-sm text-muted-foreground">
            j / k to move through the queue, a to approve.
          </p>
        </div>
        {drafts.length > 0 && <Chip tone="primary">{drafts.length} waiting</Chip>}
      </div>

      {loading ? (
        <Card>
          <EmptyState title="Loading…" />
        </Card>
      ) : drafts.length === 0 ? (
        <Card>
          <EmptyState title="Nothing waiting">
            Every written article has been reviewed. New drafts land here the moment the engine
            finishes them.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <Card className="h-fit lg:sticky lg:top-20">
            <CardHeader title="Queue" />
            <ul className="max-h-[70vh] divide-y divide-border/60 overflow-y-auto">
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <button
                    onClick={() => setSelectedId(draft.id)}
                    className={`w-full px-4 py-3 text-left transition ${
                      draft.id === selectedId ? "bg-primary/10" : "hover:bg-accent/50"
                    }`}
                  >
                    <p className="truncate text-sm font-medium">{draft.title}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {draft.wordCount ?? "—"} words
                      {draft.aeoScore != null && (
                        <span
                          className={
                            draft.aeoScore >= 80
                              ? " text-chart-2"
                              : draft.aeoScore >= 60
                                ? " text-accent-foreground"
                                : " text-destructive"
                          }
                        >
                          {" "}· score {draft.aeoScore}
                        </span>
                      )}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            {article ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    {audit && audit.unsupported.length > 0 ? (
                      <Chip tone="danger">
                        <ShieldAlert size={11} /> {audit.unsupported.length} unsupported numbers
                      </Chip>
                    ) : (
                      <Chip tone="success">
                        <ShieldCheck size={11} /> numbers clean
                      </Chip>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Link to={`/articles/${article.id}`}>
                      <GhostButton>
                        <PenLine size={13} /> Edit
                      </GhostButton>
                    </Link>
                    <GhostButton
                      onClick={async () => {
                        if (!selectedId) return;
                        try {
                          await api.publishArticle(selectedId);
                          toast("Published now", "success");
                          load();
                        } catch (err) {
                          toast((err as Error).message, "error");
                        }
                      }}
                    >
                      Publish now
                    </GhostButton>
                    <PrimaryButton onClick={approve}>
                      <Check size={15} /> Approve
                    </PrimaryButton>
                  </div>
                </div>
                <article
                  dir="auto"
                  className="prose-invert max-w-none space-y-4 px-6 py-6 text-[15px] leading-relaxed [&_h2]:font-heading [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:font-heading [&_h3]:text-xl [&_h3]:font-bold [&_ul]:list-disc [&_ul]:ps-6"
                >
                  <h1 className="font-heading text-3xl font-bold leading-tight">{article.title}</h1>
                  {article.metaDescription && (
                    <p className="rounded-md border border-border bg-input px-4 py-3 text-sm text-muted-foreground">
                      {article.metaDescription}
                    </p>
                  )}
                  <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                </article>
              </>
            ) : (
              <EmptyState title="Select a draft" />
            )}
          </Card>
        </div>
      )}
      <a className="hidden" href="#" aria-hidden>
        <ExternalLink size={1} />
      </a>
    </>
  );
}
