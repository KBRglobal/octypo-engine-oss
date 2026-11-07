import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent } from "react";

import { api } from "../lib/api";
import type { LibraryDocument, LibraryItem } from "../lib/types";
import { useToast } from "../components/Toast";
import { ConfirmModal } from "../components/ConfirmModal";
import { TableSkeleton } from "../components/Skeleton";

const ACCEPT = ".txt,.md,.markdown,.pdf,.docx";

const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  extracted: { label: "Extracting ideas", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  extracting: { label: "Extracting", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground border-border" },
  ideas_generated: { label: "Ideas ready", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  failed: { label: "Failed", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
};

const ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  idea: { label: "Idea", cls: "bg-muted text-muted-foreground border-border" },
  queued: { label: "Queued", cls: "bg-indigo-500/10 text-indigo-300 border-indigo-500/30" },
  writing: { label: "Writing", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  published: { label: "Published", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  failed: { label: "Failed", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
};

function Badge({ map, status }: { map: Record<string, { label: string; cls: string }>; status: string }) {
  const s = map[status] ?? { label: status, cls: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Library() {
  const { toast } = useToast();
  const [docs, setDocs] = useState<LibraryDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LibraryDocument | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemBusyId, setItemBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // ── Viral / cross-document synthesis ideas ──
  const [viralItems, setViralItems] = useState<LibraryItem[]>([]);
  const [viralLoading, setViralLoading] = useState(true);
  const [brainstorming, setBrainstorming] = useState(false);
  const [viralCount, setViralCount] = useState(10);
  const [viralBrief, setViralBrief] = useState("");

  const loadViral = useCallback(async () => {
    try {
      const result = await api.listLibraryItems({ collection: "viral" });
      setViralItems(result.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load viral ideas", "error");
    } finally {
      setViralLoading(false);
    }
  }, [toast]);

  const brainstormViral = useCallback(async () => {
    setBrainstorming(true);
    try {
      const count = Math.min(Math.max(Math.round(viralCount) || 10, 1), 30);
      const result = await api.generateViralIdeas({
        count,
        brief: viralBrief.trim() || undefined,
      });
      toast(`Brainstormed ${result.items.length} viral idea${result.items.length === 1 ? "" : "s"}`);
      setViralBrief("");
      loadViral();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Brainstorm failed", "error");
    } finally {
      setBrainstorming(false);
    }
  }, [viralCount, viralBrief, toast, loadViral]);

  const writeViralNow = useCallback(
    async (item: LibraryItem) => {
      setItemBusyId(item.id);
      try {
        await api.writeLibraryItemNow(item.id);
        toast(`"${item.title}" queued for writing`);
        setViralItems(prev =>
          prev.map(i => (i.id === item.id ? { ...i, status: "queued" } : i))
        );
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed to queue", "error");
      } finally {
        setItemBusyId(null);
      }
    },
    [toast]
  );

  const load = useCallback(async () => {
    try {
      const result = await api.listDocuments();
      setDocs(result.documents);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load documents", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    loadViral();
    const interval = setInterval(() => {
      load();
      loadViral();
    }, 15_000);
    return () => clearInterval(interval);
  }, [load, loadViral]);

  const doUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      try {
        const result = await api.uploadDocuments(files);
        const ok = result.documents.filter(d => d.status !== "failed").length;
        const failed = result.documents.length - ok;
        toast(
          `Uploaded ${ok} document${ok === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""} — mining ideas now`,
          failed && !ok ? "error" : "success"
        );
        load();
      } catch (err) {
        toast(err instanceof Error ? err.message : "Upload failed", "error");
      } finally {
        setUploading(false);
      }
    },
    [toast, load]
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    doUpload(files);
  };

  const toggleExpand = async (doc: LibraryDocument) => {
    if (expandedId === doc.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(doc.id);
    setItemsLoading(true);
    setItems([]);
    try {
      const result = await api.getDocument(doc.id);
      setItems(result.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load ideas", "error");
    } finally {
      setItemsLoading(false);
    }
  };

  const writeNow = async (item: LibraryItem) => {
    setItemBusyId(item.id);
    try {
      await api.writeLibraryItemNow(item.id);
      toast(`"${item.title}" queued for writing`);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, status: "queued" } : i)));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to queue", "error");
    } finally {
      setItemBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    try {
      await api.deleteDocument(pendingDelete.id);
      toast(`"${pendingDelete.filename}" deleted`);
      if (expandedId === pendingDelete.id) setExpandedId(null);
      setPendingDelete(null);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Document Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload source files and the engine continuously turns them into original, source-grounded
          articles — running in parallel with your RSS feeds.
        </p>
      </div>

      {/* Viral Ideas — cross-document synthesis */}
      <div className="overflow-hidden rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 to-panel">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <span aria-hidden>✦</span> Viral Ideas
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Shareable roundups synthesised across your entire knowledge base — not a single
              document.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col text-xs text-muted-foreground">
              <span className="mb-1">Count</span>
              <input
                type="number"
                min={1}
                max={30}
                value={viralCount}
                onChange={e => setViralCount(Number(e.target.value))}
                className="w-16 rounded-md border border-border bg-shell px-2 py-1.5 text-sm text-foreground focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <button
              onClick={brainstormViral}
              disabled={brainstorming}
              className="rounded-md bg-indigo-500 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              {brainstorming ? "Brainstorming…" : "Brainstorm viral ideas"}
            </button>
          </div>
        </div>
        <div className="px-5 py-3">
          <input
            type="text"
            value={viralBrief}
            onChange={e => setViralBrief(e.target.value)}
            placeholder="Optional brief — steer the angle (e.g. focus on first-time renters)"
            className="w-full rounded-md border border-border bg-shell px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="px-5 pb-5">
          {viralLoading ? (
            <p className="text-xs text-muted-foreground">Loading viral ideas…</p>
          ) : viralItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No viral ideas yet. Upload documents and mine their ideas first, then brainstorm
              roundups that synthesise across all of them.
            </p>
          ) : (
            <div className="space-y-3">
              {viralItems.map(item => (
                <div key={item.id} className="rounded-lg border border-border bg-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{item.title}</div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{item.angle}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge map={ITEM_STATUS} status={item.status} />
                      {(item.status === "idea" || item.status === "failed") && (
                        <button
                          onClick={() => writeViralNow(item)}
                          disabled={itemBusyId === item.id}
                          className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                        >
                          {itemBusyId === item.id ? "…" : "Write now"}
                        </button>
                      )}
                    </div>
                  </div>
                  {item.keyPoints && item.keyPoints.length > 0 && (
                    <ul className="mt-2.5 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                      {item.keyPoints.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={e => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition ${
          dragOver
            ? "border-indigo-500 bg-indigo-500/5"
            : "border-border bg-panel hover:border-ring"
        }`}
      >
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={e => {
            doUpload(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <svg viewBox="0 0 24 24" fill="none" className="mx-auto h-9 w-9 text-muted-foreground">
          <path
            d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="mt-3 text-sm font-medium text-foreground">
          {uploading ? "Uploading…" : "Drop files here or click to browse"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">Accepts .txt, .md, .pdf, .docx — up to 20MB each</p>
      </div>

      {/* Documents table */}
      <div className="overflow-hidden rounded-xl border border-border bg-panel">
        {loading ? (
          <TableSkeleton rows={4} />
        ) : docs.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Upload a folder of notes, reports, or transcripts and the engine will mine article
              ideas from each one, then write and publish them autonomously.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-medium">Document</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium">Ideas</th>
                <th className="px-3 py-3 font-medium">Uploaded</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map(doc => (
                <Fragment key={doc.id}>
                  <tr
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60"
                    onClick={() => toggleExpand(doc)}
                  >
                    <td className="max-w-sm px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-muted-foreground/70 transition ${expandedId === doc.id ? "rotate-90" : ""}`}
                        >
                          ▸
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">{doc.filename}</div>
                          <div className="truncate text-xs text-muted-foreground/70">
                            {formatBytes(doc.sizeBytes)}
                            {doc.errorMessage ? ` · ${doc.errorMessage}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3.5">
                      <Badge map={DOC_STATUS} status={doc.status} />
                    </td>
                    <td className="px-3 py-3.5 text-foreground/80">{doc.ideaCount}</td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-muted-foreground">
                      {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          setPendingDelete(doc);
                        }}
                        disabled={busyId === doc.id}
                        className="rounded-md px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-500/15 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                  {expandedId === doc.id && (
                    <tr className="border-b border-border bg-shell/40 last:border-0">
                      <td colSpan={5} className="px-5 py-4">
                        {itemsLoading ? (
                          <p className="text-xs text-muted-foreground">Loading ideas…</p>
                        ) : items.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {doc.status === "failed"
                              ? "Extraction failed — no ideas to show."
                              : "No ideas yet. The engine mines ideas shortly after upload."}
                          </p>
                        ) : (
                          <div className="space-y-3">
                            {items.map(item => (
                              <div
                                key={item.id}
                                className="rounded-lg border border-border bg-panel p-4"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-medium text-foreground">{item.title}</div>
                                    <p className="mt-0.5 text-xs text-muted-foreground">{item.angle}</p>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2">
                                    <Badge map={ITEM_STATUS} status={item.status} />
                                    {(item.status === "idea" || item.status === "failed") && (
                                      <button
                                        onClick={() => writeNow(item)}
                                        disabled={itemBusyId === item.id}
                                        className="rounded-md bg-indigo-500 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                                      >
                                        {itemBusyId === item.id ? "…" : "Write now"}
                                      </button>
                                    )}
                                  </div>
                                </div>
                                {item.keyPoints && item.keyPoints.length > 0 && (
                                  <ul className="mt-2.5 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                                    {item.keyPoints.map((p, i) => (
                                      <li key={i}>{p}</li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete document?"
        message={`"${pendingDelete?.filename}" and all its mined ideas will be removed. Articles already published stay untouched.`}
        confirmLabel="Delete"
        danger
        busy={busyId === pendingDelete?.id}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
