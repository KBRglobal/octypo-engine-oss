import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { api } from "../lib/api";
import type { ArticleListItem } from "../lib/types";
import { useToast } from "../components/Toast";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmModal } from "../components/ConfirmModal";
import { TableSkeleton } from "../components/Skeleton";

const PAGE_SIZE = 25;

const TABS: { label: string; status: string }[] = [
  { label: "All", status: "" },
  { label: "Published", status: "published" },
  { label: "In Review", status: "in_review" },
  { label: "Drafts", status: "draft" },
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function Articles() {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [tab, setTab] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ArticleListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<ArticleListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listArticles({
        status: tab || undefined,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setRows(result.articles);
      setTotal(result.total);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load articles", "error");
    } finally {
      setLoading(false);
    }
  }, [tab, debouncedSearch, page, toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset page when filters change
  useEffect(() => {
    setPage(0);
  }, [tab, debouncedSearch]);

  const togglePublish = async (article: ArticleListItem) => {
    setBusyId(article.id);
    try {
      if (article.status === "published") {
        await api.unpublishArticle(article.id);
        toast(`"${article.title}" moved back to drafts`);
      } else {
        await api.publishArticle(article.id);
        toast(`"${article.title}" is now live`);
      }
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    try {
      await api.deleteArticle(pendingDelete.id);
      toast(`"${pendingDelete.title}" deleted`);
      setPendingDelete(null);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Articles</h1>
          <p className="mt-1 text-sm text-muted-foreground">{total} articles across all statuses.</p>
        </div>
        <Link
          to="/write"
          className="rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400"
        >
          + New article
        </Link>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg border border-border bg-shell p-1">
          {TABS.map(t => (
            <button
              key={t.status}
              onClick={() => setTab(t.status)}
              className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition ${
                tab === t.status
                  ? "bg-indigo-500/20 text-indigo-300"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title or slug…"
          className="w-64 rounded-lg border border-border bg-shell px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 outline-none transition focus:border-indigo-500"
        />
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border bg-panel">
        {loading ? (
          <TableSkeleton rows={8} />
        ) : rows.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {debouncedSearch ? "No articles match your search." : "No articles here yet."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Write one yourself or let the pipeline pull stories from your feeds.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">Title</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Writer</th>
                <th className="px-3 py-3 font-medium">Words</th>
                <th className="px-3 py-3 font-medium">Created</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(article => (
                <tr
                  key={article.id}
                  className="group cursor-pointer border-b border-border transition last:border-0 hover:bg-muted/60"
                  onClick={() => navigate(`/articles/${article.id}`)}
                >
                  <td className="max-w-sm px-5 py-3.5">
                    <div className="truncate font-medium text-foreground">{article.title}</div>
                    <div className="truncate text-xs text-muted-foreground/70">/{article.slug}</div>
                  </td>
                  <td className="px-3 py-3.5">
                    <StatusBadge status={article.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                    {article.writerId === "manual" ? "You" : (article.writerId ?? "—")}
                  </td>
                  <td className="px-3 py-3.5 text-muted-foreground">{article.wordCount ?? 0}</td>
                  <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                    {formatDate(article.createdAt)}
                  </td>
                  <td className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1 opacity-0 transition group-hover:opacity-100">
                      <Link
                        to={`/articles/${article.id}`}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-foreground/80 transition hover:bg-muted"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => togglePublish(article)}
                        disabled={busyId === article.id}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
                      >
                        {article.status === "published" ? "Unpublish" : "Publish"}
                      </button>
                      <button
                        onClick={() => setPendingDelete(article)}
                        disabled={busyId === article.id}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/15 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-lg border border-border px-3 py-1.5 transition hover:bg-muted disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="rounded-lg border border-border px-3 py-1.5 transition hover:bg-muted disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete article?"
        message={`"${pendingDelete?.title}" will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        busy={busyId === pendingDelete?.id}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
