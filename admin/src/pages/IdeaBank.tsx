/**
 * The plan: every article this install intends to write, with the evidence
 * behind it. Building the bank happens here; writing draws from it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ClipboardCopy, Globe, Hammer, PenLine, SkipForward, Star, X } from "lucide-react";

import { api } from "../lib/api";
import type { BankBuildResult, BankSummary, Idea } from "../lib/types";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton, Stat } from "../components/studio";
import { useToast } from "../components/Toast";

const STATUS_TONE: Record<Idea["status"], "neutral" | "info" | "success" | "primary"> = {
  planned: "neutral",
  queued: "info",
  written: "success",
  skipped: "neutral",
};

export default function IdeaBank() {
  const { toast } = useToast();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [summary, setSummary] = useState<BankSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [clusterFilter, setClusterFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listIdeas({ status: statusFilter || undefined, cluster: clusterFilter || undefined, limit: 500 })
      .then((res) => {
        setIdeas(res.ideas);
        setSummary(res.summary);
      })
      .catch((err) => toast((err).message, "error"))
      .finally(() => setLoading(false));
  }, [statusFilter, clusterFilter, toast]);

  useEffect(load, [load]);

  const clusters = useMemo(
    () => [...new Set(ideas.map((idea) => idea.cluster).filter((c): c is string => Boolean(c)))].sort(),
    [ideas]
  );

  const writeNow = async (idea: Idea) => {
    try {
      await api.writeIdeaNow(idea.id);
      toast(`Queued: ${idea.title}`, "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const skip = async (idea: Idea) => {
    try {
      await api.skipIdea(idea.id);
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Idea Bank</h1>
          <p className="text-sm text-muted-foreground">
            The plan: what gets written, in what order, and why.
          </p>
        </div>
        <PrimaryButton onClick={() => setBuilderOpen(true)}>
          <Hammer size={15} /> Build bank
        </PrimaryButton>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Planned" value={summary.planned} />
          <Stat label="Queued" value={summary.queued} tone="primary" />
          <Stat label="Written" value={summary.written} tone="success" />
          <Stat label="Total" value={summary.total} />
        </div>
      )}

      <Card>
        <CardHeader
          title="Planned articles"
          action={
            <div className="flex items-center gap-2">
              <select
                value={clusterFilter}
                onChange={(e) => setClusterFilter(e.target.value)}
                className="rounded-md border border-border bg-input px-2 py-1.5 text-xs text-foreground"
              >
                <option value="">All clusters</option>
                {clusters.map((cluster) => (
                  <option key={cluster} value={cluster}>
                    {cluster}
                  </option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-md border border-border bg-input px-2 py-1.5 text-xs text-foreground"
              >
                <option value="">All statuses</option>
                {["planned", "queued", "written", "skipped"].map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          }
        />
        {loading ? (
          <EmptyState title="Loading…" />
        ) : ideas.length === 0 ? (
          <EmptyState title="The bank is empty">
            Build it from a handful of seed phrases — the engine researches the market, plans the
            clusters and titles every idea.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2.5 font-semibold">Title</th>
                  <th className="px-3 py-2.5 font-semibold">Keyword</th>
                  <th className="px-3 py-2.5 font-semibold">Cluster</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Volume</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {ideas.map((idea) => (
                  <tr key={idea.id} className="hover:bg-accent/40">
                    <td className="max-w-md px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        {idea.isPillar && <Star size={13} className="shrink-0 text-primary" />}
                        <span className="truncate font-medium">{idea.title}</span>
                      </div>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-muted-foreground">
                      {idea.targetKeyword}
                    </td>
                    <td className="px-3 py-2.5">
                      {idea.cluster && <Chip tone="info">{idea.cluster}</Chip>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">
                      {idea.searchVolume ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <Chip tone={STATUS_TONE[idea.status]}>{idea.status}</Chip>
                    </td>
                    <td className="px-5 py-2.5">
                      <div className="flex justify-end gap-2">
                        {idea.status === "planned" && (
                          <>
                            <GhostButton onClick={() => writeNow(idea)}>
                              <PenLine size={13} /> Write now
                            </GhostButton>
                            <GhostButton onClick={() => skip(idea)}>
                              <SkipForward size={13} /> Skip
                            </GhostButton>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <SerpResearch clusters={clusters} />

      {builderOpen && <Builder onClose={() => setBuilderOpen(false)} onBuilt={load} />}
    </>
  );
}

/**
 * The once-per-client competitive snapshot. Two ways to pay for it: the
 * automatic path spends the install's search API once, the manual path costs
 * nothing — copy the prompt, run it on your own subscription, paste it back.
 */
function SerpResearch({ clusters }: { clusters: string[] }) {
  const { toast } = useToast();
  const [briefs, setBriefs] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");

  const load = useCallback(() => {
    api
      .serpBriefs()
      .then((res) => {
        const map: Record<string, string | null> = {};
        for (const b of res.briefs) map[b.cluster] = b.updatedAt;
        setBriefs(map);
      })
      .catch(() => setBriefs({}));
  }, []);
  useEffect(load, [load]);

  const buildAuto = async (cluster?: string) => {
    setBusy(cluster ?? "*");
    try {
      const res = await api.serpBriefBuild(cluster);
      toast(`Research done for ${res.built.length}/${res.requested} clusters`, "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const copyPrompt = async (cluster: string) => {
    try {
      const res = await api.serpBriefPrompts(cluster);
      const prompt = res.prompts[0]?.prompt;
      if (!prompt) throw new Error("No queries for this cluster yet");
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied — run it on your subscription model, then paste the answer", "success");
      setPasteFor(cluster);
      setPasteText("");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const paste = async () => {
    if (!pasteFor) return;
    try {
      await api.serpBriefPaste(pasteFor, pasteText);
      toast(`Brief stored for ${pasteFor}`, "success");
      setPasteFor(null);
      setPasteText("");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  if (clusters.length === 0) return null;

  return (
    <Card>
      <CardHeader
        title="Competitor research"
        action={
          <GhostButton onClick={() => buildAuto()} disabled={busy !== null}>
            <Globe size={14} /> {busy === "*" ? "Researching…" : "Auto-build all"}
          </GhostButton>
        }
      />
      <p className="px-5 pb-2 text-xs text-muted-foreground">
        Once per client. Auto uses the install's search API; Copy prompt costs nothing — run it on
        your own subscription and paste the answer back.
      </p>
      <ul className="divide-y divide-border/60">
        {clusters.map((cluster) => (
          <li key={cluster} className="px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{cluster}</span>
                {briefs[cluster] !== undefined ? (
                  <Chip tone="success">
                    <Check size={12} /> researched
                  </Chip>
                ) : (
                  <Chip tone="neutral">not yet</Chip>
                )}
              </div>
              <div className="flex items-center gap-2">
                <GhostButton onClick={() => buildAuto(cluster)} disabled={busy !== null}>
                  <Globe size={14} /> {busy === cluster ? "…" : "Auto"}
                </GhostButton>
                <GhostButton onClick={() => copyPrompt(cluster)}>
                  <ClipboardCopy size={14} /> Copy prompt
                </GhostButton>
              </div>
            </div>
            {pasteFor === cluster && (
              <div className="mt-3 space-y-2">
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder="Paste the model's answer here…"
                  rows={5}
                  className="w-full rounded-md border border-border bg-background p-2 text-sm"
                  dir="auto"
                />
                <div className="flex justify-end gap-2">
                  <GhostButton onClick={() => setPasteFor(null)}>Cancel</GhostButton>
                  <PrimaryButton onClick={paste} disabled={pasteText.trim().length < 100}>
                    Save brief
                  </PrimaryButton>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Builder({ onClose, onBuilt }: { onClose: () => void; onBuilt: () => void }) {
  const { toast } = useToast();
  const [seeds, setSeeds] = useState("");
  const [target, setTarget] = useState(300);
  const [perMonth, setPerMonth] = useState(100);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<BankBuildResult | null>(null);

  const seedList = seeds
    .split("\n")
    .map((seed) => seed.trim())
    .filter(Boolean);

  const run = async (persist: boolean) => {
    setBusy(true);
    try {
      const result = await api.buildIdeas({ seeds: seedList, target, articlesPerMonth: perMonth, persist });
      if (persist) {
        toast(`${result.inserted ?? result.produced} ideas in the bank`, "success");
        onBuilt();
        onClose();
      } else {
        setPreview(result);
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <Card className="w-full max-w-lg">
        <CardHeader
          title="Build the bank"
          action={
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X size={17} />
            </button>
          }
        />
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Seed phrases — one per line, the customer's actual subjects
            </label>
            <textarea
              value={seeds}
              onChange={(e) => setSeeds(e.target.value)}
              rows={5}
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              placeholder={"mobile led screens\nevent signage\nstreet activations"}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Target ideas
              </label>
              <input
                type="number"
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Articles / month
              </label>
              <input
                type="number"
                value={perMonth}
                onChange={(e) => setPerMonth(Number(e.target.value))}
                className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm"
              />
            </div>
          </div>

          {preview && (
            <div className="rounded-md border border-border bg-input p-3 text-xs">
              <span className="font-mono">
                {preview.produced}/{preview.requested}
              </span>{" "}
              ideas supported by the evidence — about{" "}
              <span className="font-mono">{preview.coverageMonths}</span> months of coverage.
              {preview.produced < preview.requested && " Add seeds to go deeper."}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <GhostButton onClick={() => run(false)} disabled={busy || seedList.length === 0}>
              Preview only
            </GhostButton>
            <PrimaryButton onClick={() => run(true)} disabled={busy || seedList.length === 0}>
              {busy ? "Researching…" : "Build & save"}
            </PrimaryButton>
          </div>
        </div>
      </Card>
    </div>
  );
}
