/**
 * The truth library. The engine writes only what lives here, so this screen is
 * where article richness actually comes from — not from a bigger model.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, ListChecks, Plus, Sparkles, Trash2, X } from "lucide-react";

import { api } from "../lib/api";
import type { Fact } from "../lib/types";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton } from "../components/studio";
import { useToast } from "../components/Toast";

export default function Facts() {
  const { toast } = useToast();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [selected, setSelected] = useState<string>("*");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listFacts()
      .then((res) => setFacts(res.facts))
      .catch((err) => toast((err as Error).message, "error"))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(load, [load]);

  const clusters = useMemo(() => {
    const set = new Set(facts.map((fact) => fact.cluster));
    set.add("*");
    return [...set].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));
  }, [facts]);

  const visible = facts.filter((fact) => fact.cluster === selected);

  const add = async () => {
    const items = draft
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!items.length) return;
    try {
      await api.addFacts({ cluster: selected, facts: items });
      setDraft("");
      toast(`${items.length} facts added`, "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const remove = async (fact: Fact) => {
    try {
      await api.deleteFact(fact.id);
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Facts</h1>
          <p className="text-sm text-muted-foreground">
            The engine states only what is confirmed here. Article depth is bought on this screen.
          </p>
        </div>
        <PrimaryButton onClick={() => setWizardOpen(true)}>
          <Sparkles size={15} /> Generate questionnaire
        </PrimaryButton>
      </div>

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Clusters" />
          <nav className="p-2">
            {clusters.map((cluster) => {
              const count = facts.filter((fact) => fact.cluster === cluster).length;
              return (
                <button
                  key={cluster}
                  onClick={() => setSelected(cluster)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm transition ${
                    selected === cluster
                      ? "bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <span>{cluster === "*" ? "Site-wide" : cluster}</span>
                  <span className="font-mono text-[11px]">{count}</span>
                </button>
              );
            })}
          </nav>
          <LocaleCard cluster={selected} />
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title={selected === "*" ? "Site-wide facts" : `Facts — ${selected}`}
              action={<Chip tone="success">{visible.length} confirmed</Chip>}
            />
            {loading ? (
              <EmptyState title="Loading…" />
            ) : visible.length === 0 ? (
              <EmptyState title="Nothing confirmed yet">
                The writer refuses to invent. Every price, duration and constraint an article
                should state must be added here first — or collected through the questionnaire.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border/60">
                {visible.map((fact) => (
                  <li key={fact.id} className="flex items-start justify-between gap-4 px-5 py-3">
                    <div>
                      <p className="text-sm leading-relaxed">{fact.fact}</p>
                      <div className="mt-1 flex gap-2">
                        <Chip tone="neutral">{fact.source}</Chip>
                      </div>
                    </div>
                    <GhostButton danger onClick={() => remove(fact)}>
                      <Trash2 size={13} />
                    </GhostButton>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Add facts" />
            <div className="space-y-3 p-5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                placeholder={"One fact per line, exactly as the customer confirmed it.\nA full-day booking costs $250–400."}
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
              <div className="flex justify-end">
                <PrimaryButton onClick={add} disabled={!draft.trim()}>
                  <Plus size={15} /> Add to {selected === "*" ? "site-wide" : selected}
                </PrimaryButton>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {wizardOpen && (
        <QuestionnaireWizard
          cluster={selected}
          onClose={() => setWizardOpen(false)}
          onSaved={load}
        />
      )}
    </>
  );
}

/**
 * Native-language setting for the selected cluster. The writer CREATES content
 * in this language from the confirmed facts (never translates). A cluster with
 * no explicit row inherits the site-wide ("*") row, which defaults to en/US.
 */
function LocaleCard({ cluster }: { cluster: string }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<{ cluster: string; language: string; country: string }[]>([]);
  const [languages, setLanguages] = useState<Record<string, string>>({});
  const [language, setLanguage] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listClusterSettings()
      .then((res) => {
        setRows(res.settings);
        setLanguages(res.languages);
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  const own = rows.find((row) => row.cluster === cluster);
  const siteWide = rows.find((row) => row.cluster === "*");
  const effective = own ?? siteWide ?? { cluster: "*", language: "en", country: "US" };

  // Editing state follows the selected cluster.
  useEffect(() => {
    setLanguage(effective.language);
    setCountry(effective.country);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, rows.length]);

  const dirty = language !== effective.language || country !== effective.country;

  const save = async () => {
    setBusy(true);
    try {
      await api.putClusterSetting({ cluster, language, country });
      toast(`Content language for ${cluster === "*" ? "site-wide" : cluster}: ${languages[language] ?? language}`, "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.deleteClusterSetting(cluster);
      toast(cluster === "*" ? "Back to default (English / US)" : "Back to site-wide language", "success");
      load();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border/60 p-4">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Globe size={13} /> Content language
      </p>
      <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
        Written natively in this language from the confirmed facts — never translated.
        {!own && cluster !== "*" && " Inherited from site-wide."}
      </p>
      <div className="space-y-2">
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="w-full rounded-md border border-border bg-input px-2 py-1.5 text-sm"
        >
          {Object.entries(languages).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <input
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
          placeholder="Country (IL, US, DE…)"
          className="w-full rounded-md border border-border bg-input px-2 py-1.5 font-mono text-sm uppercase"
        />
        <div className="flex items-center justify-between gap-2">
          {(own || cluster === "*") && (
            <GhostButton onClick={reset} disabled={busy || (cluster === "*" && !siteWide)}>
              Reset
            </GhostButton>
          )}
          <PrimaryButton onClick={save} disabled={busy || !dirty || !/^[A-Z]{2}$/.test(country)}>
            Save
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function QuestionnaireWizard({
  cluster,
  onClose,
  onSaved,
}: {
  cluster: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [topic, setTopic] = useState(cluster === "*" ? "" : cluster);
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const res = await api.factQuestionnaire(topic, cluster);
      setQuestions(res.questions);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const facts = Object.values(answers)
      .map((answer) => answer.trim())
      .filter(Boolean);
    if (!facts.length) return;
    try {
      await api.addFacts({ cluster, facts });
      toast(`${facts.length} answers saved as confirmed facts`, "success");
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <Card className="flex max-h-[85vh] w-full max-w-2xl flex-col">
        <CardHeader
          title="Fact questionnaire"
          action={
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
              <X size={17} />
            </button>
          }
        />
        <div className="space-y-4 overflow-y-auto p-5">
          {questions.length === 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                The engine asks the strong model what it would need to know to write this cluster
                well — the exact facts it would otherwise have been tempted to invent. Send the
                questions to the customer; their answers become confirmed facts.
              </p>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="Topic, e.g. mobile LED screen rental for events"
                className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
              />
              <div className="flex justify-end">
                <PrimaryButton onClick={generate} disabled={busy || !topic.trim()}>
                  <ListChecks size={15} /> {busy ? "Thinking…" : "Generate questions"}
                </PrimaryButton>
              </div>
            </>
          ) : (
            <>
              {questions.map((question, index) => (
                <div key={index}>
                  <p className="mb-1 text-sm font-medium">{question}</p>
                  <input
                    value={answers[index] ?? ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [index]: e.target.value }))}
                    placeholder="The customer's answer — leave blank to skip"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                  />
                </div>
              ))}
              <div className="flex justify-end gap-2 pt-2">
                <GhostButton onClick={onClose}>Later</GhostButton>
                <PrimaryButton onClick={save}>Save answered as facts</PrimaryButton>
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
