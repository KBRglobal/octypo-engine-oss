/**
 * The SEO desk — our own research bench, in place of a Semrush seat.
 *
 * Every button here spends real money on a real account, so the page is built
 * around that fact rather than hiding it: the price is on the button before it
 * is pressed, the balance is in the header, a repeated question is answered
 * from the cache for nothing and says so, and buying the same answer again is
 * a separate, deliberate button.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, Loader2, RefreshCw, Search, Wallet } from "lucide-react";

import { api, ApiError } from "../lib/api";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton } from "../components/studio";
import {
  BacklinksView,
  CompetitorsView,
  DomainOverviewView,
  GapView,
  KeywordsView,
  RankedKeywordsView,
  SerpView,
  money,
} from "../components/seo-results";
import { SeoExplorer } from "../components/seo-explorer";
import { SeoReportTool } from "../components/seo-report";
import type {
  SeoAnchor,
  SeoBacklinkSummary,
  SeoCompetitor,
  SeoDomainOverview,
  SeoGapKeyword,
  SeoHistoryEntry,
  SeoKeyword,
  SeoMarket,
  SeoRankedKeyword,
  SeoReferringDomain,
  SeoRun,
  SeoSerpResult,
  SeoStatus,
  SeoToolId,
} from "../lib/types";

const FIELD_LABELS: Record<"target" | "keyword" | "rival", { label: string; placeholder: string }> = {
  target: { label: "Domain", placeholder: "example.com" },
  rival: { label: "Their domain", placeholder: "competitor.com" },
  keyword: { label: "Keyword", placeholder: "wedding catering chicago" },
};

/**
 * The chosen country outlives the page.
 *
 * Nearly every lookup here is about the same two or three markets, and the
 * provider's default is the United States — which answers a foreign domain with
 * an empty result rather than an error. Re-picking the country on every visit
 * is how that wrong answer eventually gets believed.
 */
const MARKET_KEY = "octypo_seo_market";

const inputClass =
  "w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none";

export default function Seo() {
  const [status, setStatus] = useState<SeoStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  // "explorer" is not a tool — it is the rest of the API. Kept in the same
  // tab row because it answers the same question when no curated tool fits.
  const [active, setActive] = useState<SeoToolId | "explorer" | "report">("report");
  const [fields, setFields] = useState({ target: "", keyword: "", rival: "" });
  const [limit, setLimit] = useState<number | null>(null);
  const [run, setRun] = useState<SeoRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SeoHistoryEntry[]>([]);
  const [markets, setMarkets] = useState<SeoMarket[]>([]);
  const [market, setMarket] = useState<{ locationCode: number | null; languageCode: string | null }>(
    () => {
      try {
        const saved = localStorage.getItem(MARKET_KEY);
        if (saved) return JSON.parse(saved) as { locationCode: number; languageCode: string };
      } catch {
        // A corrupt preference is not worth failing the page over.
      }
      return { locationCode: null, languageCode: null };
    }
  );

  const tool = useMemo(
    () =>
      active === "explorer" || active === "report"
        ? null
        : status?.tools.find((item) => item.id === active) ?? null,
    [status, active]
  );

  const loadStatus = useCallback(() => {
    setLoadingStatus(true);
    api
      .seoStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : "The desk is unreachable."))
      .finally(() => setLoadingStatus(false));
  }, []);

  const loadHistory = useCallback(() => {
    api
      .seoHistory()
      .then((data) => setHistory(data.lookups))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    loadStatus();
    loadHistory();
    api
      .seoMarkets()
      .then((data) => setMarkets(data.markets))
      .catch(() => setMarkets([]));
  }, [loadStatus, loadHistory]);

  // Falls back to whatever the install was configured with.
  useEffect(() => {
    if (market.locationCode === null && status?.locationCode) {
      setMarket({ locationCode: status.locationCode, languageCode: status.languageCode });
    }
  }, [status, market.locationCode]);

  const chosenMarket = markets.find((entry) => entry.code === market.locationCode) ?? null;

  function pickCountry(code: number) {
    const country = markets.find((entry) => entry.code === code);
    // A country's languages are its own, often with no English on offer, so
    // carrying the previous language over would ask for nothing.
    const languageCode =
      country?.languages.find((language) => language.code === market.languageCode)?.code ??
      country?.languages[0]?.code ??
      null;
    const next = { locationCode: code, languageCode };
    setMarket(next);
    try {
      localStorage.setItem(MARKET_KEY, JSON.stringify(next));
    } catch {
      // Private window, blocked storage — the choice just will not be remembered.
    }
  }

  function pickLanguage(code: string) {
    const next = { ...market, languageCode: code };
    setMarket(next);
    try {
      localStorage.setItem(MARKET_KEY, JSON.stringify(next));
    } catch {
      // As above.
    }
  }

  // A tool's own default is the right limit until someone types another one.
  useEffect(() => {
    setLimit(null);
    setRun(null);
    setError(null);
  }, [active]);

  const effectiveLimit = limit ?? tool?.defaultLimit ?? 100;

  /**
   * The price scales with the rows asked for, so the button re-quotes as the
   * limit changes rather than showing the default's price for every run.
   */
  const [quoted, setQuoted] = useState<number | null>(null);
  useEffect(() => {
    if (!tool) return;
    if (limit === null) {
      setQuoted(tool.estimateUsd);
      return;
    }
    let live = true;
    api
      .seoQuote(tool.id, effectiveLimit)
      .then((data) => live && setQuoted(data.estimateUsd))
      .catch(() => live && setQuoted(null));
    return () => {
      live = false;
    };
  }, [tool, limit, effectiveLimit]);

  const missing = (tool?.needs ?? []).filter((need) => !fields[need].trim());

  async function execute(refresh: boolean) {
    if (!tool || missing.length > 0) return;
    setRunning(true);
    setError(null);
    try {
      const result = await api.seoRun(tool.id, {
        target: fields.target || undefined,
        keyword: fields.keyword || undefined,
        rival: fields.rival || undefined,
        limit: effectiveLimit,
        locationCode: market.locationCode ?? undefined,
        languageCode: market.languageCode ?? undefined,
        refresh,
      });
      setRun(result);
      if (!result.cached) {
        loadHistory();
        loadStatus();
      }
    } catch (err) {
      setRun(null);
      setError(err instanceof ApiError ? err.message : "The lookup failed.");
    } finally {
      setRunning(false);
    }
  }

  if (loadingStatus) {
    return (
      <Card>
        <EmptyState title="Opening the desk" />
      </Card>
    );
  }

  if (!status?.enabled) {
    return (
      <Card>
        <EmptyState title="The SEO desk is off on this install">
          Set <code className="font-mono text-xs">SEO_TOOLS_ENABLED=1</code> together with the
          DataForSEO login to turn it on.
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">SEO Desk</h1>
          <p className="text-sm text-muted-foreground">
            Search demand, rankings and links, straight from the account. Every lookup is a purchase.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={status.balanceUsd !== null && status.balanceUsd < 5 ? "danger" : "success"}>
            <Wallet size={11} />
            {status.balanceUsd === null ? "balance unknown" : `${money(status.balanceUsd)} left`}
          </Chip>
        </div>
      </div>

      <Card className="flex flex-wrap items-end gap-4 px-5 py-4">
        <span className="flex items-center gap-1.5 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          <Globe size={12} />
          Market
        </span>
        <label className="block space-y-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Country
          </span>
          <select
            className={inputClass}
            value={market.locationCode ?? ""}
            disabled={markets.length === 0}
            onChange={(event) => pickCountry(Number(event.target.value))}
          >
            {markets.length === 0 && <option value="">{status.locationCode ?? "loading"}</option>}
            {markets.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Language
          </span>
          <select
            className={inputClass}
            value={market.languageCode ?? ""}
            disabled={!chosenMarket}
            onChange={(event) => pickLanguage(event.target.value)}
          >
            {(chosenMarket?.languages ?? []).map((language) => (
              <option key={language.code} value={language.code}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <p className="pb-2 text-xs text-muted-foreground">
          Rankings and search volume are per country. Link data is global.
        </p>
      </Card>

      {status.error && (
        <Card className="border-destructive/40 bg-destructive/5 px-5 py-3 text-sm text-destructive">
          {status.error}
        </Card>
      )}

      <nav className="flex flex-wrap gap-2">
        <button
          onClick={() => setActive("report")}
          className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
            active === "report"
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          Prospect report
        </button>
        {status.tools.map((item) => (
          <button
            key={item.id}
            onClick={() => setActive(item.id)}
            className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
              item.id === active
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
        <button
          onClick={() => setActive("explorer")}
          className={`rounded-md border px-3 py-1.5 text-xs font-semibold transition ${
            active === "explorer"
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border border-dashed text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
        >
          All endpoints
        </button>
      </nav>

      {active === "report" && <SeoReportTool market={market} />}

      {active === "explorer" && <SeoExplorer market={market} />}

      {tool && (
        <Card>
          <CardHeader
            title={tool.label}
            action={<span className="text-xs text-muted-foreground">{tool.hint}</span>}
          />
          <div className="grid gap-4 px-5 py-4 md:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] md:items-end">
            {tool.needs.map((need) => (
              <label key={need} className="block space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {FIELD_LABELS[need].label}
                </span>
                <input
                  className={inputClass}
                  value={fields[need]}
                  placeholder={FIELD_LABELS[need].placeholder}
                  onChange={(event) => setFields({ ...fields, [need]: event.target.value })}
                  onKeyDown={(event) => event.key === "Enter" && void execute(false)}
                />
              </label>
            ))}

            {tool.maxLimit > 1 && (
              <label className="block space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Rows (max {tool.maxLimit})
                </span>
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  max={tool.maxLimit}
                  value={effectiveLimit}
                  onChange={(event) => setLimit(Number(event.target.value) || null)}
                />
              </label>
            )}

            <div className="flex items-center gap-2">
              <PrimaryButton onClick={() => void execute(false)} disabled={running || missing.length > 0}>
                {running ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                Look up
                <span className="font-mono text-xs opacity-80">
                  {quoted === null ? "" : `~${money(quoted, quoted < 0.1 ? 3 : 2)}`}
                </span>
              </PrimaryButton>
              <GhostButton onClick={() => void execute(true)} disabled={running || missing.length > 0}>
                <RefreshCw size={12} />
                Buy fresh
              </GhostButton>
            </div>
          </div>
        </Card>
      )}

      {tool && error && (
        <Card className="border-destructive/40 bg-destructive/5 px-5 py-3 text-sm text-destructive">
          {error}
        </Card>
      )}

      {tool && run && !running && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {run.cached ? (
              <Chip tone="success">cached · free</Chip>
            ) : (
              <Chip tone="primary">{money(run.costUsd, 4)} spent</Chip>
            )}
            <span>fetched {new Date(run.fetchedAt).toLocaleString()}</span>
          </div>
          <Results run={run} />
        </div>
      )}

      {tool && running && (
        <Card>
          <EmptyState title="Asking DataForSEO">
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              A live lookup takes a few seconds.
            </span>
          </EmptyState>
        </Card>
      )}

      {tool && !running && !run && !error && (
        <Card>
          <EmptyState title="Nothing looked up yet">
            Fill the field above and press Look up. Repeating a question inside its freshness window
            costs nothing.
          </EmptyState>
        </Card>
      )}

      {history.length > 0 && (
        <Card>
          <CardHeader
            title="Recent lookups"
            action={
              <GhostButton
                danger
                onClick={() => {
                  void api.seoClearCache().then(() => {
                    setHistory([]);
                    setRun(null);
                  });
                }}
              >
                Clear cache
              </GhostButton>
            }
          />
          <ul className="divide-y divide-border/60">
            {history.slice(0, 12).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <Chip tone="neutral">{entry.tool}</Chip>
                  <span className="truncate text-muted-foreground">
                    {[entry.input.target, entry.input.rival, entry.input.keyword]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {money(entry.costUsd, 4)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/**
 * The run's payload is shaped by whichever tool produced it, so it is read
 * per tool rather than typed into one union the server would have to promise.
 */
function Results({ run }: { run: SeoRun }) {
  const data = run.data;

  switch (run.tool) {
    case "domain-overview":
      return (
        <DomainOverviewView
          organic={(data.organic as SeoDomainOverview | null) ?? null}
          links={(data.links as SeoBacklinkSummary | null) ?? null}
        />
      );
    case "ranked-keywords":
      return (
        <RankedKeywordsView
          rows={(data.keywords as SeoRankedKeyword[]) ?? []}
          total={(data.total as number | null) ?? null}
        />
      );
    case "keywords":
      return (
        <KeywordsView
          seed={(data.seed as SeoKeyword | null) ?? null}
          ideas={(data.ideas as SeoKeyword[]) ?? []}
        />
      );
    case "backlinks":
      return (
        <BacklinksView
          summary={(data.summary as SeoBacklinkSummary | null) ?? null}
          referringDomains={(data.referringDomains as SeoReferringDomain[]) ?? []}
          anchors={(data.anchors as SeoAnchor[]) ?? []}
        />
      );
    case "competitors":
      return <CompetitorsView rows={(data.competitors as SeoCompetitor[]) ?? []} />;
    case "keyword-gap":
      return (
        <GapView
          rows={(data.missing as SeoGapKeyword[]) ?? []}
          rival={(data.rival as string) ?? ""}
          total={(data.total as number | null) ?? null}
        />
      );
    case "serp":
      return (
        <SerpView
          rows={(data.results as SeoSerpResult[]) ?? []}
          keyword={(data.keyword as string) ?? ""}
        />
      );
    default:
      return null;
  }
}
