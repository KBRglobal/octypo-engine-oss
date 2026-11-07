import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api } from "../lib/api";
import type { Feed } from "../lib/types";
import { useToast } from "../components/Toast";
import { Toggle } from "../components/Toggle";
import { ConfirmModal } from "../components/ConfirmModal";
import { TableSkeleton } from "../components/Skeleton";

const EMPTY_FORM = { name: "", url: "", category: "", language: "en", interval: "60" };

export function Feeds() {
  const { toast } = useToast();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Feed | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listFeeds();
      setFeeds(result.feeds);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load feeds", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const addFeed = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.url.trim()) return;
    setAdding(true);
    try {
      await api.addFeed({
        name: form.name.trim(),
        url: form.url.trim(),
        category: form.category.trim() || undefined,
        language: form.language.trim() || undefined,
        fetchIntervalMinutes: Number(form.interval) || 60,
      });
      toast(`Feed "${form.name.trim()}" added — fetching items now`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to add feed", "error");
    } finally {
      setAdding(false);
    }
  };

  const toggleActive = async (feed: Feed) => {
    setBusyId(feed.id);
    const next = !(feed.isActive ?? true);
    try {
      await api.patchFeed(feed.id, { isActive: next });
      toast(`"${feed.name}" ${next ? "activated" : "paused"}`);
      setFeeds(prev => prev.map(f => (f.id === feed.id ? { ...f, isActive: next } : f)));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    try {
      await api.deleteFeed(pendingDelete.id);
      toast(`Feed "${pendingDelete.name}" deleted`);
      setPendingDelete(null);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-shell px-3 py-2 text-sm text-foreground placeholder-muted-foreground/60 outline-none transition focus:border-indigo-500";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">RSS Feeds</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sources the engine monitors for new stories.
          </p>
        </div>
        <button
          onClick={() => setShowForm(v => !v)}
          className="rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400"
        >
          {showForm ? "Close" : "+ Add feed"}
        </button>
      </div>

      {/* Add-feed form */}
      {showForm && (
        <form
          onSubmit={addFeed}
          className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-panel p-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <div className="lg:col-span-1">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Name *</label>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="TechCrunch"
              className={inputCls}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Feed URL *</label>
            <input
              value={form.url}
              onChange={e => setForm({ ...form, url: e.target.value })}
              placeholder="https://example.com/feed.xml"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Category</label>
            <input
              value={form.category}
              onChange={e => setForm({ ...form, category: e.target.value })}
              placeholder="tech"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Language</label>
            <input
              value={form.language}
              onChange={e => setForm({ ...form, language: e.target.value })}
              placeholder="en"
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Fetch interval (minutes)
            </label>
            <input
              type="number"
              min={1}
              value={form.interval}
              onChange={e => setForm({ ...form, interval: e.target.value })}
              className={inputCls}
            />
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={adding || !form.name.trim() || !form.url.trim()}
              className="rounded-lg bg-indigo-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              {adding ? "Adding…" : "Add feed"}
            </button>
          </div>
        </form>
      )}

      {/* Feed list */}
      <div className="overflow-hidden rounded-xl border border-border bg-panel">
        {loading ? (
          <TableSkeleton rows={4} />
        ) : feeds.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-muted-foreground">No feeds configured yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Add your first RSS feed and the engine will start evaluating stories within minutes.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">Feed</th>
                <th className="px-3 py-3 font-medium">Category</th>
                <th className="px-3 py-3 font-medium">Items</th>
                <th className="px-3 py-3 font-medium">Interval</th>
                <th className="px-3 py-3 font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map(feed => (
                <tr key={feed.id} className="border-b border-border last:border-0">
                  <td className="max-w-sm px-5 py-3.5">
                    <div className="truncate font-medium text-foreground">{feed.name}</div>
                    <div className="truncate text-xs text-muted-foreground/70">{feed.url}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                    {feed.category ?? "—"}
                  </td>
                  <td className="px-3 py-3.5 text-foreground/80">{feed.itemCount}</td>
                  <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                    {feed.fetchIntervalMinutes ?? 60}m
                  </td>
                  <td className="px-3 py-3.5">
                    <Toggle
                      checked={feed.isActive ?? true}
                      disabled={busyId === feed.id}
                      onChange={() => toggleActive(feed)}
                      label={`Toggle ${feed.name}`}
                    />
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      onClick={() => setPendingDelete(feed)}
                      disabled={busyId === feed.id}
                      className="rounded-md px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/15 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete feed?"
        message={`"${pendingDelete?.name}" and all its fetched items will be removed. Articles already written stay untouched.`}
        confirmLabel="Delete"
        danger
        busy={busyId === pendingDelete?.id}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
