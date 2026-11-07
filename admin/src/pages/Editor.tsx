import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";

import { api, ApiError } from "../lib/api";
import { engineBlocksToHTML, htmlToEngineBlocks } from "../lib/blocks";
import type { QAResult } from "../lib/types";
import { useToast } from "../components/Toast";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton } from "../components/Skeleton";

function CharCount({ value, ideal }: { value: string; ideal: [number, number] }) {
  const len = value.length;
  const ok = len >= ideal[0] && len <= ideal[1];
  return (
    <span className={`text-xs ${len === 0 ? "text-muted-foreground/70" : ok ? "text-emerald-500" : "text-amber-500"}`}>
      {len}/{ideal[1]}
    </span>
  );
}

function scoreColor(score: number): string {
  if (score >= 72) return "text-emerald-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}

export function Editor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [articleId, setArticleId] = useState<string | undefined>(id);
  const [loading, setLoading] = useState(Boolean(id));
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [metaTitle, setMetaTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [status, setStatus] = useState<string>("draft");
  const [seoOpen, setSeoOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [qaRunning, setQaRunning] = useState(false);
  const [qa, setQa] = useState<QAResult | null>(null);
  const loadedRef = useRef(false);

  const editor = useCreateBlockNote();

  // Keep internal id in sync when navigating between /write and /articles/:id
  useEffect(() => {
    setArticleId(id);
    if (!id) {
      loadedRef.current = false;
      setLoading(false);
    }
  }, [id]);

  // Load an existing article into the editor
  useEffect(() => {
    if (!id || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        const { article } = await api.getArticle(id);
        if (cancelled) return;
        setTitle(article.title);
        setSlug(article.slug);
        setSummary(article.summary ?? "");
        setMetaTitle(article.metaTitle ?? "");
        setMetaDescription(article.metaDescription ?? "");
        setStatus(article.status);

        const html = engineBlocksToHTML(article.blocks ?? []);
        if (html) {
          const bnBlocks = await editor.tryParseHTMLToBlocks(html);
          editor.replaceBlocks(editor.document, bnBlocks);
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed to load article", "error");
        navigate("/articles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, editor, navigate, toast]);

  /** Save the current editor state; returns the article id (creates on first save). */
  const save = useCallback(async (): Promise<string | null> => {
    if (!title.trim()) {
      toast("Give the article a title first", "error");
      return null;
    }
    setSaving(true);
    try {
      const html = await editor.blocksToHTMLLossy(editor.document);
      const blocks = htmlToEngineBlocks(html);
      const payload = {
        title: title.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        summary: summary.trim() || null,
        metaTitle: metaTitle.trim() || null,
        metaDescription: metaDescription.trim() || null,
        blocks,
      };

      if (articleId) {
        const { article } = await api.updateArticle(articleId, payload);
        setSlug(article.slug);
        toast("Draft saved");
        return articleId;
      }

      const { article } = await api.createArticle(payload);
      setArticleId(article.id);
      setSlug(article.slug);
      setStatus(article.status);
      toast("Draft created");
      navigate(`/articles/${article.id}`, { replace: true });
      return article.id;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast("That slug is already in use — pick another", "error");
      } else {
        toast(err instanceof Error ? err.message : "Save failed", "error");
      }
      return null;
    } finally {
      setSaving(false);
    }
  }, [articleId, title, slug, summary, metaTitle, metaDescription, editor, navigate, toast]);

  const runQA = async () => {
    setQaRunning(true);
    try {
      const savedId = await save();
      if (!savedId) return;
      const { qa: result } = await api.runQA(savedId);
      setQa(result);
      toast(
        `QA complete — quality ${result.overallQuality}/100, verdict: ${result.decision}`,
        result.decision === "approve" ? "success" : "info"
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "QA failed", "error");
    } finally {
      setQaRunning(false);
    }
  };

  const togglePublish = async () => {
    setPublishing(true);
    try {
      const savedId = await save();
      if (!savedId) return;
      if (status === "published") {
        const { article } = await api.unpublishArticle(savedId);
        setStatus(article.status);
        toast("Article unpublished — back to draft");
      } else {
        const { article } = await api.publishArticle(savedId);
        setStatus(article.status);
        toast("Article published 🎉");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Publish failed", "error");
    } finally {
      setPublishing(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-shell px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 outline-none transition focus:border-indigo-500";

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 p-10">
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        {/* Main editor column */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-10 pb-32 pt-10">
            <div className="mb-6 flex items-center gap-3">
              <StatusBadge status={status} />
              {slug && <span className="truncate text-xs text-muted-foreground/70">/{slug}</span>}
            </div>

            {/* Title — large, borderless */}
            <textarea
              value={title}
              onChange={e => setTitle(e.target.value.replace(/\n/g, " "))}
              placeholder="Article title…"
              rows={1}
              className="w-full resize-none border-0 bg-transparent text-4xl font-bold leading-tight text-foreground placeholder-muted-foreground/50 outline-none"
              style={{ minHeight: "3rem" }}
              onInput={e => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
            />

            {/* SEO panel — collapsible */}
            <div className="mt-4 rounded-xl border border-border bg-panel/60">
              <button
                onClick={() => setSeoOpen(v => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground/80"
              >
                <span className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    SEO
                  </span>
                  {(slug || metaTitle || metaDescription) && (
                    <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                  )}
                </span>
                <span className={`text-muted-foreground transition-transform ${seoOpen ? "rotate-180" : ""}`}>
                  ▾
                </span>
              </button>
              {seoOpen && (
                <div className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Slug</label>
                    <input
                      value={slug}
                      onChange={e => setSlug(e.target.value)}
                      placeholder="auto-generated-from-title"
                      className={inputCls}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Meta title</label>
                      <CharCount value={metaTitle} ideal={[50, 60]} />
                    </div>
                    <input
                      value={metaTitle}
                      onChange={e => setMetaTitle(e.target.value)}
                      placeholder="50–60 characters with the primary keyword"
                      className={inputCls}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Meta description</label>
                      <CharCount value={metaDescription} ideal={[150, 160]} />
                    </div>
                    <textarea
                      value={metaDescription}
                      onChange={e => setMetaDescription(e.target.value)}
                      placeholder="150–160 characters, include a call to action"
                      rows={2}
                      className={`${inputCls} resize-none`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Summary</label>
                    <textarea
                      value={summary}
                      onChange={e => setSummary(e.target.value)}
                      placeholder="Short summary shown on listing pages"
                      rows={2}
                      className={`${inputCls} resize-none`}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* BlockNote editor */}
            <div className="mt-8 min-h-[24rem]">
              <BlockNoteView editor={editor} theme="dark" />
            </div>
          </div>
        </div>

        {/* QA side panel */}
        {qa && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-border bg-shell p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">QA Review</h2>
              <button
                onClick={() => setQa(null)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground/80"
              >
                Close
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-panel p-3 text-center">
                <div className={`text-2xl font-bold ${scoreColor(qa.overallQuality)}`}>
                  {qa.overallQuality}
                </div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Quality
                </div>
              </div>
              <div className="rounded-lg border border-border bg-panel p-3 text-center">
                <div className={`text-2xl font-bold ${scoreColor(qa.aeoScore ?? 0)}`}>
                  {qa.aeoScore ?? "—"}
                </div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">AEO</div>
              </div>
            </div>

            <div
              className={`mt-3 rounded-lg border px-3 py-2 text-center text-sm font-semibold ${
                qa.decision === "approve"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : qa.decision === "revise"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                    : "border-red-500/30 bg-red-500/10 text-red-400"
              }`}
            >
              {qa.decision === "approve"
                ? "Would be approved"
                : qa.decision === "revise"
                  ? "Needs revision"
                  : "Would be rejected"}
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Editor's notes
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground/80">{qa.reasoning}</p>
              {qa.editorNotes && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{qa.editorNotes}</p>
              )}
            </div>

            {qa.issues.length > 0 && (
              <div className="mt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Issues ({qa.issues.length})
                </h3>
                <div className="mt-2 space-y-2">
                  {qa.issues.map((issue, i) => (
                    <div key={i} className="rounded-lg border border-border bg-panel p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                            issue.severity === "critical"
                              ? "bg-red-500/15 text-red-400"
                              : issue.severity === "major"
                                ? "bg-amber-500/15 text-amber-400"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {issue.severity}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{issue.category}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-foreground/80">
                        {issue.description}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-indigo-300/80">
                        → {issue.suggestion}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="shrink-0 border-t border-border bg-shell/95 px-8 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <span className="text-xs text-muted-foreground/70">
            {articleId ? "Changes are saved when you click Save" : "Unsaved new draft"}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
            <button
              onClick={runQA}
              disabled={qaRunning || saving}
              className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
            >
              {qaRunning ? "Reviewing…" : "Run QA"}
            </button>
            <button
              onClick={togglePublish}
              disabled={publishing || saving}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-foreground transition disabled:opacity-50 ${
                status === "published"
                  ? "bg-muted hover:bg-border"
                  : "bg-indigo-500 hover:bg-indigo-400"
              }`}
            >
              {publishing ? "Working…" : status === "published" ? "Unpublish" : "Publish"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
