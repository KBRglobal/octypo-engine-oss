/**
 * New-client wizard: the whole onboarding path on one guided page.
 *
 * The owner used to do this across a terminal and four screens; each step here
 * reads its "done" state live from the active install, so the page is both the
 * wizard and the checklist — reopen it any time to see what a client still
 * needs. Nothing on this page invents a new flow: every action calls the same
 * endpoints the individual screens use.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Database,
  FileQuestion,
  Globe,
  Hammer,
  PenLine,
  Server,
  Sparkles,
} from "lucide-react";

import { api } from "../lib/api";
import { activeInstall, addInstall, listInstalls, setActiveInstall } from "../lib/installs";
import { Card, Chip, GhostButton, PrimaryButton } from "../components/studio";
import { useToast } from "../components/Toast";

interface StepState {
  server: boolean;
  bank: boolean;
  research: boolean;
  questionnaire: boolean;
  facts: boolean;
  firstArticle: boolean;
}

export default function Onboard() {
  const { toast } = useToast();
  const [state, setState] = useState<StepState>({
    server: false,
    bank: false,
    research: false,
    questionnaire: false,
    facts: false,
    firstArticle: false,
  });
  const [clusters, setClusters] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: StepState = { ...state };
      try {
        await api.pipelineStatus();
        next.server = true;
      } catch {
        next.server = false;
      }
      try {
        const { summary, ideas } = await api.listIdeas({ limit: 500 });
        next.bank = summary.total > 0;
        next.firstArticle = summary.written > 0;
        if (!cancelled) {
          setClusters(
            [...new Set(ideas.map((i) => i.cluster).filter((c): c is string => Boolean(c)))].sort()
          );
        }
      } catch {
        next.bank = false;
      }
      try {
        const { briefs } = await api.serpBriefs();
        next.research = briefs.length > 0;
      } catch {
        next.research = false;
      }
      try {
        const { facts } = await api.listFacts();
        next.facts = facts.length > 0;
        next.questionnaire = next.questionnaire || facts.length > 0;
      } catch {
        next.facts = false;
      }
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const done = Object.values(state).filter(Boolean).length;

  const steps = [
    { key: "server", title: "Connect the client's engine", icon: Server, done: state.server },
    { key: "bank", title: "Build the idea bank", icon: Hammer, done: state.bank },
    { key: "research", title: "Competitor research", icon: Globe, done: state.research },
    { key: "questionnaire", title: "Client questionnaire", icon: FileQuestion, done: state.questionnaire },
    { key: "facts", title: "Paste answers as facts", icon: Database, done: state.facts },
    { key: "firstArticle", title: "Write the first article", icon: PenLine, done: state.firstArticle },
  ] as const;

  // Land on the first thing that still needs the owner — the Mobbin-surveyed
  // pattern (Circle, Remote, Customer.io): rail shows the journey, the pane
  // shows exactly one step.
  const [selected, setSelected] = useState<string | null>(null);
  const activeKey = selected ?? steps.find((s) => !s.done)?.key ?? "firstArticle";

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">New Client</h1>
          <p className="text-sm text-muted-foreground">
            One guided path. Come back anytime — it doubles as the client's checklist.
          </p>
        </div>
        <Chip tone={done === 6 ? "success" : "primary"}>{done}/6 done</Chip>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit lg:sticky lg:top-6">
          <div className="px-5 pb-2 pt-4">
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span>Setup checklist</span>
              <span>{done}/6</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-chart-2 transition-all"
                style={{ width: `${(done / 6) * 100}%` }}
              />
            </div>
          </div>
          <ol className="px-3 pb-3">
            {steps.map((step, i) => {
              const active = step.key === activeKey;
              return (
                <li key={step.key} className="relative">
                  {i < steps.length - 1 && (
                    <span
                      className={`absolute left-[22px] top-9 h-[calc(100%-20px)] w-px ${
                        step.done ? "bg-chart-2/50" : "bg-border"
                      }`}
                    />
                  )}
                  <button
                    onClick={() => setSelected(step.key)}
                    className={`relative z-10 flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm transition ${
                      active ? "bg-accent font-semibold text-accent-foreground" : "hover:bg-muted"
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                        step.done
                          ? "bg-chart-2 text-white"
                          : active
                            ? "border-2 border-ring text-foreground"
                            : "border border-border bg-card text-muted-foreground"
                      }`}
                    >
                      {step.done ? <Check size={13} /> : i + 1}
                    </span>
                    <span className={step.done && !active ? "text-muted-foreground line-through decoration-border" : ""}>
                      {step.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>

        <Card className="h-fit">
          {steps.map((step, i) =>
            step.key !== activeKey ? null : (
              <div key={step.key}>
                <div className="flex items-center gap-3 border-b border-border px-5 py-4">
                  <step.icon size={17} className={step.done ? "text-chart-2" : "text-accent-foreground"} />
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Step {i + 1} of 6{step.done && " · done"}
                    </p>
                    <h2 className="text-base font-semibold">{step.title}</h2>
                  </div>
                  {i < steps.length - 1 && (
                    <span className="ml-auto">
                      <GhostButton onClick={() => setSelected(steps[i + 1].key)}>Next step →</GhostButton>
                    </span>
                  )}
                </div>
                <div className="px-5 py-4">
                  {step.key === "server" && <ServerStep onChanged={refresh} />}
                  {step.key === "bank" && <BankStep onChanged={refresh} ready={state.server} />}
                  {step.key === "research" && (
                    <ResearchStep clusters={clusters} onChanged={refresh} toast={toast} />
                  )}
                  {step.key === "questionnaire" && (
                    <QuestionnaireStep
                      clusters={clusters}
                      toast={toast}
                      onGenerated={() => setState((s) => ({ ...s, questionnaire: true }))}
                    />
                  )}
                  {step.key === "facts" && (
                    <FactsStep clusters={clusters} onChanged={refresh} toast={toast} />
                  )}
                  {step.key === "firstArticle" && (
                    <FirstArticleStep onChanged={refresh} toast={toast} />
                  )}
                </div>
              </div>
            )
          )}
        </Card>
      </div>
    </>
  );
}

function ServerStep({ onChanged }: { onChanged: () => void }) {
  const { toast } = useToast();
  const installs = listInstalls();
  const active = activeInstall();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");

  const connect = () => {
    if (!name.trim() || !baseUrl.trim() || !token.trim()) return;
    const created = addInstall({ name: name.trim(), baseUrl: baseUrl.trim(), token: token.trim() });
    setActiveInstall(created.id);
    toast(`Connected: ${created.name}`, "success");
    window.location.reload();
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Active install: <span className="font-medium text-foreground">{active.name}</span>
        {installs.length > 1 && " — switch installs from the header."}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Client name"
          className="rounded-md border border-border bg-input px-3 py-2"
        />
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://engine.example.com"
          className="rounded-md border border-border bg-input px-3 py-2"
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Admin token"
          type="password"
          className="rounded-md border border-border bg-input px-3 py-2"
        />
      </div>
      <PrimaryButton onClick={connect} disabled={!name.trim() || !baseUrl.trim() || !token.trim()}>
        Connect install
      </PrimaryButton>
      <button className="ml-3 text-xs text-muted-foreground underline" onClick={onChanged}>
        Re-check
      </button>
    </div>
  );
}

function BankStep({ onChanged, ready }: { onChanged: () => void; ready: boolean }) {
  const { toast } = useToast();
  const [seeds, setSeeds] = useState("");
  const [target, setTarget] = useState(300);
  const [busy, setBusy] = useState(false);

  const seedList = seeds
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const build = async () => {
    setBusy(true);
    try {
      const result = await api.buildIdeas({ seeds: seedList, target, articlesPerMonth: 100, persist: true });
      toast(`Bank built: ${result.inserted ?? result.produced} ideas`, "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        3-6 seed phrases that describe the client's business — one per line, in the site's language.
      </p>
      <textarea
        value={seeds}
        onChange={(e) => setSeeds(e.target.value)}
        rows={4}
        dir="auto"
        placeholder={"wedding cakes\ncustom birthday cakes"}
        className="w-full rounded-md border border-border bg-input px-3 py-2"
      />
      <div className="flex items-center gap-3">
        <label className="text-xs text-muted-foreground">Ideas to plan</label>
        <input
          type="number"
          value={target}
          onChange={(e) => setTarget(Number(e.target.value) || 300)}
          className="w-24 rounded-md border border-border bg-input px-3 py-2"
        />
        <PrimaryButton onClick={build} disabled={!ready || seedList.length === 0 || busy}>
          <Sparkles size={14} /> {busy ? "Building…" : "Build the bank"}
        </PrimaryButton>
      </div>
      {!ready && <p className="text-xs text-destructive">Connect the engine first.</p>}
    </div>
  );
}

function ResearchStep({
  clusters,
  onChanged,
  toast,
}: {
  clusters: string[];
  onChanged: () => void;
  toast: (m: string, t?: "success" | "error") => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");

  const auto = async () => {
    setBusy(true);
    try {
      const res = await api.serpBriefBuild();
      toast(`Researched ${res.built.length}/${res.requested} clusters`, "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async (cluster: string) => {
    try {
      const res = await api.serpBriefPrompts(cluster);
      const prompt = res.prompts[0]?.prompt;
      if (!prompt) throw new Error("No queries for this cluster yet");
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied — run it on your own subscription, paste the answer below", "success");
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
      toast(`Stored for ${pasteFor}`, "success");
      setPasteFor(null);
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  if (clusters.length === 0)
    return <p className="text-sm text-muted-foreground">Build the bank first — research runs per cluster.</p>;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-3">
        <PrimaryButton onClick={auto} disabled={busy}>
          <Globe size={14} /> {busy ? "Researching…" : "Auto-research all clusters"}
        </PrimaryButton>
        <span className="text-xs text-muted-foreground">or copy a prompt per cluster — costs nothing:</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {clusters.map((c) => (
          <GhostButton key={c} onClick={() => copyPrompt(c)}>
            <ClipboardCopy size={13} /> {c}
          </GhostButton>
        ))}
      </div>
      {pasteFor && (
        <div className="space-y-2">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={5}
            dir="auto"
            placeholder={`Paste the answer for ${pasteFor}…`}
            className="w-full rounded-md border border-border bg-input px-3 py-2"
          />
          <div className="flex gap-2">
            <PrimaryButton onClick={paste} disabled={pasteText.trim().length < 100}>
              Save brief
            </PrimaryButton>
            <GhostButton onClick={() => setPasteFor(null)}>Cancel</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function QuestionnaireStep({
  clusters,
  toast,
  onGenerated,
}: {
  clusters: string[];
  toast: (m: string, t?: "success" | "error") => void;
  onGenerated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");

  const topics = useMemo(() => clusters.slice(0, 3), [clusters]);

  const generate = async () => {
    setBusy(true);
    try {
      const parts: string[] = [];
      for (const topic of topics.length ? topics : ["*"]) {
        const res = await api.factQuestionnaire(topic.replace(/-/g, " "), topic);
        if (res.questions.length) {
          parts.push(`— ${topic.replace(/-/g, " ")} —\n` + res.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"));
        }
      }
      const doc =
        "Content questionnaire: your answers are the fuel for the articles. A partial answer beats none.\n\n" +
        parts.join("\n\n");
      setText(doc);
      onGenerated();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        The engine writes the questions a real buyer needs answered. Copy and send on WhatsApp.
      </p>
      <PrimaryButton onClick={generate} disabled={busy || clusters.length === 0}>
        <FileQuestion size={14} /> {busy ? "Writing questions…" : "Generate questionnaire"}
      </PrimaryButton>
      {text && (
        <div className="space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            dir="auto"
            className="w-full rounded-md border border-border bg-input px-3 py-2"
          />
          <GhostButton
            onClick={() => {
              navigator.clipboard.writeText(text);
              toast("Questionnaire copied — paste it into WhatsApp", "success");
            }}
          >
            <ClipboardCopy size={13} /> Copy for WhatsApp
          </GhostButton>
        </div>
      )}
    </div>
  );
}

function FactsStep({
  clusters,
  onChanged,
  toast,
}: {
  clusters: string[];
  onChanged: () => void;
  toast: (m: string, t?: "success" | "error") => void;
}) {
  const [cluster, setCluster] = useState("*");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const facts = text
      .split("\n")
      .map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
      .filter((l) => l.length > 5);
    if (facts.length === 0) return;
    setBusy(true);
    try {
      const res = await api.addFacts({ cluster: cluster === "*" ? undefined : cluster, facts });
      toast(`${res.inserted} facts saved`, "success");
      setText("");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        One fact per line, exactly as the client answered — prices, sizes, areas, names. The writer
        will only ever state what appears here.
      </p>
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">Cluster</label>
        <select
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          className="rounded-md border border-border bg-input px-2 py-1.5"
        >
          <option value="*">Site-wide</option>
          {clusters.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        dir="auto"
        placeholder={"A full-day booking starts at about $250\nDelivery takes 3 working days"}
        className="w-full rounded-md border border-border bg-input px-3 py-2"
      />
      <PrimaryButton onClick={save} disabled={busy || text.trim().length < 6}>
        <Database size={14} /> {busy ? "Saving…" : "Save facts"}
      </PrimaryButton>
    </div>
  );
}

function FirstArticleStep({
  onChanged,
  toast,
}: {
  onChanged: () => void;
  toast: (m: string, t?: "success" | "error") => void;
}) {
  const [busy, setBusy] = useState(false);

  const write = async () => {
    setBusy(true);
    try {
      const { ideas } = await api.listIdeas({ status: "planned", limit: 1 });
      if (!ideas.length) throw new Error("No planned ideas — build the bank first");
      await api.writeIdeaNow(ideas[0].id);
      toast(`Writing now: ${ideas[0].title} — check Review in ~3 minutes`, "success");
      onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        The engine writes the top idea now. It lands in Review, held for your approval — nothing
        publishes without you.
      </p>
      <PrimaryButton onClick={write} disabled={busy}>
        <PenLine size={14} /> {busy ? "Writing…" : "Write the first article"}
      </PrimaryButton>
    </div>
  );
}
