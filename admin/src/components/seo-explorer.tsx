/**
 * The endpoint explorer: everything DataForSEO sells, not a chosen subset.
 *
 * The curated tools answer the questions we ask every week and know what
 * their columns mean. This does the opposite job — around seven hundred
 * endpoints, discovered from the provider, with the body passed through as
 * typed and the answer rendered from its own shape. A new endpoint is usable
 * the day it ships, without a release here.
 *
 * Which means this screen must never imply more knowledge than it has: the
 * parameter body is a starting template, not a schema, and when a call is
 * wrong the provider's own message is what gets shown.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Download, Loader2, Play, Search } from "lucide-react";

import { api, ApiError } from "../lib/api";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton } from "./studio";
import { money } from "./seo-results";
import type { SeoCatalogue, SeoEndpoint, SeoExplorerRun } from "../lib/types";

const KIND_TONE: Record<string, "primary" | "success" | "info" | "neutral" | "danger"> = {
  live: "primary",
  task_post: "info",
  tasks_ready: "neutral",
  task_get: "neutral",
  reference: "success",
  result: "neutral",
};

const inputClass =
  "w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none";

/** How many endpoints the list renders before asking for a narrower search. */
const LIST_CAP = 300;

export function SeoExplorer({
  market,
}: {
  market: { locationCode: number | null; languageCode: string | null };
}) {
  const [catalogue, setCatalogue] = useState<SeoCatalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<string>("all");
  const [selected, setSelected] = useState<SeoEndpoint | null>(null);
  const [body, setBody] = useState("{}");
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState("");
  const [run, setRun] = useState<SeoExplorerRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    api
      .seoCatalogue()
      .then(setCatalogue)
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : "Could not load the endpoint list.")
      );
  }, []);

  const visible = useMemo(() => {
    if (!catalogue) return [];
    const needle = query.trim().toLowerCase();
    return catalogue.endpoints.filter((endpoint) => {
      if (family !== "all" && endpoint.family !== family) return false;
      if (!needle) return true;
      return endpoint.path.toLowerCase().includes(needle) || endpoint.label.toLowerCase().includes(needle);
    });
  }, [catalogue, query, family]);

  async function choose(endpoint: SeoEndpoint) {
    setSelected(endpoint);
    setRun(null);
    setError(null);
    setBodyError(null);
    setShowRaw(false);
    try {
      const template = await api.seoTemplate(endpoint.path, endpoint.family, market);
      setBody(JSON.stringify(template.params, null, 2));
    } catch {
      setBody("{}");
    }
  }

  async function call(refresh: boolean) {
    if (!selected) return;
    let params: Record<string, unknown> = {};
    try {
      params = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      setBodyError("That is not valid JSON.");
      return;
    }
    setBodyError(null);
    setRunning(true);
    setError(null);
    try {
      const result = await api.seoCall({
        path: selected.path,
        family: selected.family,
        params,
        refresh,
        taskId: taskId.trim() || undefined,
        locationCode: market.locationCode ?? undefined,
        languageCode: market.languageCode ?? undefined,
      });
      setRun(result.run);
      // A queued job is only useful if its handle is kept; carry it straight
      // into the field the collecting endpoint will need it in.
      if (result.run.taskId && result.run.kind === "task_post") setTaskId(result.run.taskId);
    } catch (err) {
      setRun(null);
      setError(err instanceof ApiError ? err.message : "The call failed.");
    } finally {
      setRunning(false);
    }
  }

  if (loadError) {
    return (
      <Card>
        <EmptyState title="The endpoint list is unavailable">{loadError}</EmptyState>
      </Card>
    );
  }

  if (!catalogue) {
    return (
      <Card>
        <EmptyState title="Reading the account's endpoint list" />
      </Card>
    );
  }

  // `min-w-0` on both columns below is load-bearing: a grid item defaults to
  // min-width:auto, so the 640px-wide results table would stretch the whole
  // page sideways on a phone instead of scrolling inside its own box.
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(280px,360px)_1fr] xl:items-start">
      <Card className="min-w-0 xl:sticky xl:top-4">
        <CardHeader
          title="Endpoints"
          action={<Chip tone="info">{catalogue.endpoints.length}</Chip>}
        />
        <div className="space-y-3 px-4 py-3">
          <label className="relative block">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              className={`${inputClass} pl-9`}
              placeholder="ranked_keywords, reviews, llm…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            className={inputClass}
            value={family}
            onChange={(event) => setFamily(event.target.value)}
          >
            <option value="all">All families</option>
            {catalogue.families.map((name) => (
              <option key={name} value={name}>
                {name.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          {catalogue.missing.length > 0 && (
            <p className="text-xs text-destructive">
              Not listed right now: {catalogue.missing.join(", ")}
            </p>
          )}
        </div>
        <ul className="max-h-[60vh] divide-y divide-border/60 overflow-y-auto">
          {visible.slice(0, LIST_CAP).map((endpoint) => (
            <li key={endpoint.path}>
              <button
                onClick={() => void choose(endpoint)}
                className={`flex w-full flex-col items-start gap-1 px-4 py-2.5 text-left transition hover:bg-accent/50 ${
                  selected?.path === endpoint.path ? "bg-primary/10" : ""
                }`}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate text-sm">{endpoint.label}</span>
                  <Chip tone={KIND_TONE[endpoint.kind] ?? "neutral"}>{endpoint.kind}</Chip>
                </span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">
                  {endpoint.path}
                </span>
              </button>
            </li>
          ))}
          {visible.length === 0 && <EmptyState title="Nothing matches that" />}
          {visible.length > LIST_CAP && (
            <li className="px-4 py-3 text-xs text-muted-foreground">
              {visible.length - LIST_CAP} more — narrow the search to see them.
            </li>
          )}
        </ul>
      </Card>

      <div className="min-w-0 space-y-6">
        {!selected ? (
          <Card>
            <EmptyState title="Pick an endpoint">
              Every endpoint the account can call, straight from DataForSEO's own list — SERP
              across every engine, keyword data, Labs, backlinks, on-page crawls, merchant, app
              and business data, and the AI-visibility family.
            </EmptyState>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title={selected.label}
                action={
                  <span className="flex items-center gap-2">
                    <Chip tone={KIND_TONE[selected.kind] ?? "neutral"}>{selected.kind}</Chip>
                    <Chip tone="neutral">{selected.method}</Chip>
                    <Chip tone={selected.price ? "primary" : "neutral"}>
                      {selected.price
                        ? selected.price.perRequestUsd === 0 && selected.price.perResultUsd === 0
                          ? "free"
                          : `${money(selected.price.perRequestUsd, 4)} + ${money(
                              selected.price.perResultUsd,
                              6
                            )}/row`
                        : "price unknown"}
                    </Chip>
                  </span>
                }
              />
              <div className="space-y-3 px-5 py-4">
                <p className="break-all font-mono text-[11px] text-muted-foreground">{selected.path}</p>

                {selected.needsId && (
                  <label className="block space-y-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Task id
                    </span>
                    <input
                      className={inputClass}
                      value={taskId}
                      placeholder="from a task_post above"
                      onChange={(event) => setTaskId(event.target.value)}
                    />
                  </label>
                )}

                {selected.method === "POST" && (
                  <label className="block space-y-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      Parameters — a starting point, not a schema
                    </span>
                    <textarea
                      className={`${inputClass} min-h-[180px] font-mono text-xs`}
                      spellCheck={false}
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                    />
                  </label>
                )}
                {bodyError && <p className="text-xs text-destructive">{bodyError}</p>}

                <div className="flex flex-wrap items-center gap-2">
                  <PrimaryButton onClick={() => void call(false)} disabled={running}>
                    {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    Call
                  </PrimaryButton>
                  <GhostButton onClick={() => void call(true)} disabled={running}>
                    Bypass cache
                  </GhostButton>
                  <span className="text-xs text-muted-foreground">
                    The provider validates the body. Its error text is shown as sent.
                  </span>
                </div>
              </div>
            </Card>

            {error && (
              <Card className="border-destructive/40 bg-destructive/5 px-5 py-3 text-sm text-destructive">
                {error}
              </Card>
            )}

            {run && <RunResult run={run} showRaw={showRaw} onToggleRaw={() => setShowRaw(!showRaw)} />}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Rendering an answer whose shape is not known in advance ──────────────── */

type Cell = string | number | boolean | null;

function isScalar(value: unknown): value is Cell {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Columns, inferred.
 *
 * Every row of a DataForSEO list shares most of its keys, but not all, and
 * several carry nested objects that no generic table can lay out. So the
 * columns are the keys that hold a scalar in at least one row, ordered by how
 * often they appear — and the nested rest stays reachable by expanding a row,
 * rather than being dropped and silently lost.
 */
export function inferColumns(rows: Record<string, unknown>[], cap = 14): string[] {
  const counts = new Map<string, number>();
  for (const row of rows.slice(0, 100)) {
    for (const [key, value] of Object.entries(row)) {
      if (!isScalar(value)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([key]) => key);
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
  return String(value);
}

/** A CSV of exactly the columns on screen — the nested parts stay in the JSON. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(",")),
  ].join("\n");
}

function RunResult({
  run,
  showRaw,
  onToggleRaw,
}: {
  run: SeoExplorerRun;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const rows = run.rows.length > 0 ? run.rows : run.results.length > 1 ? run.results : [];
  const columns = useMemo(() => inferColumns(rows), [rows]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  function download(text: string, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = linkRef.current;
    if (!anchor) return;
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const stem = run.path.split("/").filter(Boolean).join("-");

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {run.cached ? (
          <Chip tone="success">cached · free</Chip>
        ) : (
          <Chip tone="primary">{money(run.costUsd, 4)} spent</Chip>
        )}
        <Chip tone="neutral">{run.statusMessage}</Chip>
        {run.taskId && <Chip tone="info">task {run.taskId}</Chip>}
        <span>{new Date(run.fetchedAt).toLocaleString()}</span>
        <span className="ml-auto flex gap-2">
          <GhostButton onClick={() => void navigator.clipboard?.writeText(JSON.stringify(run, null, 2))}>
            <Copy size={12} />
            Copy JSON
          </GhostButton>
          {rows.length > 0 && (
            <GhostButton onClick={() => download(toCsv(rows, columns), `${stem}.csv`, "text/csv")}>
              <Download size={12} />
              CSV
            </GhostButton>
          )}
          <GhostButton onClick={onToggleRaw}>{showRaw ? "Hide raw" : "Raw"}</GhostButton>
        </span>
      </div>
      {/* One hidden anchor, reused: the export is a click, not a navigation. */}
      <a ref={linkRef} className="hidden" aria-hidden="true" />

      {rows.length > 0 && (
        <Card>
          <CardHeader title={`${rows.length} rows`} action={<Chip tone="neutral">{columns.length} columns shown</Chip>} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="w-8 px-2 py-2.5" />
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                    >
                      {column.replace(/_/g, " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((row, index) => (
                  <Fragment key={index}>
                    <tr
                      className="cursor-pointer transition hover:bg-accent/40"
                      onClick={() => setExpanded(expanded === index ? null : index)}
                    >
                      <td className="px-2 py-2 text-muted-foreground">
                        {expanded === index ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </td>
                      {columns.map((column) => (
                        <td key={column} dir="auto" className="max-w-[320px] truncate px-3 py-2">
                          {show(row[column])}
                        </td>
                      ))}
                    </tr>
                    {expanded === index && (
                      <tr>
                        <td colSpan={columns.length + 1} className="bg-accent/20 px-4 py-3">
                          <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed">
                            {JSON.stringify(row, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {rows.length === 0 && run.head && (
        <Card>
          <CardHeader title="Answer" />
          <pre className="max-h-[32rem] overflow-auto px-5 py-4 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(run.head, null, 2)}
          </pre>
        </Card>
      )}

      {rows.length === 0 && !run.head && !run.taskId && (
        <Card>
          <EmptyState title="The call succeeded and returned nothing">
            {run.statusMessage}
          </EmptyState>
        </Card>
      )}

      {showRaw && (
        <Card>
          <CardHeader title="Raw response" />
          <pre className="max-h-[32rem] overflow-auto px-5 py-4 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(run, null, 2)}
          </pre>
        </Card>
      )}
    </div>
  );
}
