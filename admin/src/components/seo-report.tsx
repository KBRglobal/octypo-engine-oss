/**
 * Building the document we send a prospect.
 *
 * Three fields, because the third one matters: the category, in the words the
 * business would use. Everything else the desk can measure, but what a company
 * actually sells is not in any API, and without it the demand section is
 * guessed from a thin site — which is how an events company ends up with a
 * page about stickers. So the form says plainly that the section depends on it.
 */
import { useEffect, useState } from "react";
import { ExternalLink, FileText, Link2, ListChecks, Loader2 } from "lucide-react";

import { api, ApiError } from "../lib/api";
import { Card, CardHeader, Chip, EmptyState, GhostButton, PrimaryButton } from "./studio";
import { money } from "./seo-results";
import type { SeoReportResult, SeoReportSummary } from "../lib/types";

/**
 * Which country a domain plainly belongs to.
 *
 * The desk remembers the last market picked, and the report is the one place
 * where the wrong one is expensive: a `.de` business measured in the United
 * States comes back with nothing to say, and the document looks authoritative
 * while being about the wrong country. A country-code domain states its market
 * out loud, so a mismatch is worth catching before the money is spent.
 *
 * Only unambiguous suffixes are listed. `.com` says nothing, and guessing from
 * it would be the same mistake in the other direction.
 */
const TLD_MARKETS: Record<string, { code: number; name: string }> = {
  il: { code: 2376, name: "Israel" },
  ae: { code: 2784, name: "United Arab Emirates" },
  uk: { code: 2826, name: "United Kingdom" },
  de: { code: 2276, name: "Germany" },
  fr: { code: 2250, name: "France" },
  es: { code: 2724, name: "Spain" },
  it: { code: 2380, name: "Italy" },
  nl: { code: 2528, name: "Netherlands" },
  au: { code: 2036, name: "Australia" },
  ca: { code: 2124, name: "Canada" },
  in: { code: 2356, name: "India" },
  br: { code: 2076, name: "Brazil" },
  sa: { code: 2682, name: "Saudi Arabia" },
};

export function marketFromDomain(domain: string): { code: number; name: string } | null {
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  const suffix = host.split(".").pop() ?? "";
  return TLD_MARKETS[suffix] ?? null;
}

const inputClass =
  "w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none";

/** What each omitted section means, in the operator's terms. */
const OMITTED_REASONS: Record<string, string> = {
  visibility: "no organic data for this domain",
  links: "no backlinks in the index",
  topKeywords: "it ranks for nothing measurable",
  demand: "no category given, or nothing came back for it",
  gaps: "no comparable rival, or none of their keywords are on topic",
  "gaps:off-topic": "the rival's keywords are about another business",
  "competitors:none-comparable": "only platforms came back — nothing its own size",
  competitors: "no comparable rival",
  aiDemand: "nobody asks assistants about these phrases yet",
  site: "the site did not answer our crawler",
};

export function SeoReportTool({
  market,
}: {
  market: { locationCode: number | null; languageCode: string | null };
}) {
  const [fields, setFields] = useState({ domain: "", clientName: "", seed: "" });
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState<SeoReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<SeoReportSummary[]>([]);
  const [copied, setCopied] = useState(false);

  const loadRecent = () =>
    api
      .seoReports()
      .then((data) => setRecent(data.reports))
      .catch(() => setRecent([]));

  useEffect(() => {
    void loadRecent();
  }, []);

  async function build() {
    if (!fields.domain.trim()) return;
    setBuilding(true);
    setError(null);
    setCopied(false);
    try {
      const built = await api.seoBuildReport({
        domain: fields.domain,
        clientName: fields.clientName || undefined,
        seed: fields.seed || undefined,
        locationCode: market.locationCode ?? undefined,
        languageCode: market.languageCode ?? undefined,
      });
      setResult(built);
      void loadRecent();
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : "The report could not be built.");
    } finally {
      setBuilding(false);
    }
  }

  const shareUrl = (path: string) => `${window.location.origin}${path}`;

  async function downloadWorklist(token: string, domain: string) {
    try {
      const markdown = await api.seoWorklistMarkdown(token);
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${domain}-worklist.md`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not build the work list.");
    }
  }

  const expected = marketFromDomain(fields.domain);
  const marketMismatch =
    expected !== null && market.locationCode !== null && expected.code !== market.locationCode;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Prospect report"
          action={<span className="text-xs text-muted-foreground">One domain in, one document to send.</span>}
        />
        <div className="grid gap-4 px-5 py-4 md:grid-cols-[repeat(auto-fit,minmax(200px,1fr))] md:items-end">
          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Their domain
            </span>
            <input
              className={inputClass}
              placeholder="example.com"
              value={fields.domain}
              onChange={(event) => setFields({ ...fields, domain: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Business name
            </span>
            <input
              className={inputClass}
              placeholder="shown on the cover"
              value={fields.clientName}
              onChange={(event) => setFields({ ...fields, clientName: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              What they sell
            </span>
            <input
              className={inputClass}
              placeholder="event production"
              dir="auto"
              value={fields.seed}
              onChange={(event) => setFields({ ...fields, seed: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && void build()}
            />
          </label>
          <PrimaryButton
            onClick={() => void build()}
            disabled={building || !fields.domain.trim() || marketMismatch}
          >
            {building ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
            Build report
          </PrimaryButton>
        </div>
        {marketMismatch && (
          <p className="border-t border-destructive/30 bg-destructive/5 px-5 py-3 text-xs text-destructive">
            This is a {expected!.name} domain and the market above is set to something else. Measured
            in the wrong country it will come back nearly empty — switch the country first.
          </p>
        )}
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          The demand, gap and assistant sections need the category, in their words. Without them it
          is left out rather than filled from a thin site. A report costs about $0.20 and takes three
          to five minutes — most of it is crawling every page of their site.
        </p>
      </Card>

      {error && (
        <Card className="border-destructive/40 bg-destructive/5 px-5 py-3 text-sm text-destructive">
          {error}
        </Card>
      )}

      {building && (
        <Card>
          <EmptyState title="Measuring">
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Visibility, rankings, page one, demand, links, their Google profile, what an assistant
              answers, and a crawl of every page. Three to five minutes.
            </span>
          </EmptyState>
        </Card>
      )}

      {result && !building && (
        <Card>
          <CardHeader
            title={result.report.clientName}
            action={<Chip tone="primary">{money(result.report.costUsd, 4)}</Chip>}
          />
          <div className="space-y-4 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-input px-3 py-2 font-mono text-xs">
                {shareUrl(result.path)}
              </code>
              <GhostButton
                onClick={() => {
                  void navigator.clipboard?.writeText(shareUrl(result.path));
                  setCopied(true);
                }}
              >
                <Link2 size={12} />
                {copied ? "Copied" : "Copy link"}
              </GhostButton>
              <GhostButton onClick={() => window.open(result.path, "_blank", "noopener")}>
                <ExternalLink size={12} />
                Open
              </GhostButton>
              {/* The operator's half: what to change, never shown to the client. */}
              <GhostButton onClick={() => void downloadWorklist(result.token, result.report.domain)}>
                <ListChecks size={12} />
                Work list
              </GhostButton>
            </div>

            {/* What the client will NOT see, and why — the operator's half. */}
            {result.report.omitted.length > 0 && (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3">
                <p className="text-xs font-semibold text-foreground">Left out of the document</p>
                <ul className="mt-2 space-y-1">
                  {result.report.omitted.map((name) => (
                    <li key={name} className="text-xs text-muted-foreground">
                      <span className="font-mono">{name}</span> — {OMITTED_REASONS[name] ?? "no data"}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <iframe
              title="report preview"
              src={result.path}
              className="h-[70vh] w-full rounded-md border border-border bg-card"
            />
          </div>
        </Card>
      )}

      {recent.length > 0 && (
        <Card>
          <CardHeader title="Reports sent" action={<Chip tone="info">{recent.length}</Chip>} />
          <ul className="divide-y divide-border/60">
            {recent.map((report) => (
              <li key={report.token} className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
                <span className="flex min-w-0 items-center gap-3">
                  <a
                    href={report.path}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate font-semibold text-primary hover:underline"
                  >
                    {report.clientName}
                  </a>
                  <span className="truncate font-mono text-xs text-muted-foreground">{report.domain}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {report.createdAt ? new Date(report.createdAt).toLocaleDateString() : ""} ·{" "}
                  {money(report.costUsd, 3)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
