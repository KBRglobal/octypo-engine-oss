/**
 * What each SEO tool's answer looks like on screen.
 *
 * One table component, seven column sets. The page owns the asking; this file
 * owns only the showing, so a new tool is a column set rather than a new page.
 *
 * Null is rendered as a dash everywhere, never as 0 or "—0". On this desk a
 * zero is a claim about the world ("nobody searches this") and the provider
 * genuinely does not sell data for every phrase; the two must not look alike.
 */
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

import { Card, CardHeader, Chip, EmptyState, Stat } from "./studio";
import type {
  SeoAnchor,
  SeoBacklinkSummary,
  SeoCompetitor,
  SeoDomainOverview,
  SeoGapKeyword,
  SeoKeyword,
  SeoRankedKeyword,
  SeoReferringDomain,
  SeoSerpResult,
} from "../lib/types";

export const dash = "—";

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return dash;
  return Math.round(value).toLocaleString("en-US");
}

export function money(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return dash;
  return `$${value.toFixed(digits)}`;
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return dash;
  return `${Math.round(value * 100)}%`;
}

/** A difficulty or spam score, coloured the way a person reads it. */
export function scoreTone(score: number | null): "success" | "neutral" | "danger" {
  if (score === null) return "neutral";
  if (score >= 60) return "danger";
  if (score >= 30) return "neutral";
  return "success";
}

interface Column<T> {
  header: string;
  /** Right-align the numbers, left-align the words. */
  numeric?: boolean;
  width?: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  empty,
  keyOf,
}: {
  rows: T[];
  columns: Column<T>[];
  empty: string;
  keyOf: (row: T, index: number) => string;
}) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    // Tables are the one thing allowed to be wider than the phone; the scroll
    // lives here so the page body never moves sideways.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            {columns.map((column) => (
              <th
                key={column.header}
                className={`px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground ${
                  column.numeric ? "text-right" : ""
                }`}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {rows.map((row, index) => (
            <tr key={keyOf(row, index)} className="transition hover:bg-accent/40">
              {columns.map((column) => (
                <td
                  key={column.header}
                  className={`px-4 py-2.5 align-top ${column.numeric ? "text-right font-mono text-xs" : ""}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Difficulty({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">{dash}</span>;
  return <Chip tone={scoreTone(value)}>{Math.round(value)}</Chip>;
}

function External({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return <span className="text-muted-foreground">{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      <span className="line-clamp-1 break-all">{children}</span>
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  );
}

const KEYWORD_COLUMNS: Column<SeoKeyword>[] = [
  // dir="auto" because the desk researches right-to-left markets: without
  // it a phrase that mixes a Latin brand with right-to-left words renders in the
  // wrong order, which is unreadable rather than merely untidy.
  {
    header: "Keyword",
    render: (row) => (
      <span dir="auto" className="block break-words">
        {row.keyword}
      </span>
    ),
  },
  { header: "Volume", numeric: true, render: (row) => count(row.volume) },
  { header: "Difficulty", numeric: true, render: (row) => <Difficulty value={row.difficulty} /> },
  { header: "CPC", numeric: true, render: (row) => money(row.cpc) },
  { header: "Intent", render: (row) => row.intent ?? dash },
];

export function DomainOverviewView({
  organic,
  links,
}: {
  organic: SeoDomainOverview | null;
  links: SeoBacklinkSummary | null;
}) {
  if (!organic && !links) {
    return (
      <Card>
        <EmptyState title="Nothing known about this domain">
          DataForSEO has no organic or link data for it.
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Organic keywords" value={count(organic?.organicKeywords)} tone="primary" />
        <Stat
          label="Monthly traffic"
          value={count(organic?.organicTraffic)}
          sub="DataForSEO estimate"
        />
        <Stat label="Top 3" value={count(organic?.top3)} sub={`Top 10: ${count(organic?.top10)}`} />
        <Stat
          label="Traffic value"
          value={organic?.organicTrafficCost ? money(organic.organicTrafficCost, 0) : dash}
          sub="What the same clicks would cost in ads"
          tone="success"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Backlinks" value={count(links?.backlinks)} />
        <Stat
          label="Referring domains"
          value={count(links?.referringDomains)}
          sub={`${count(links?.nofollowDomains)} nofollow`}
        />
        <Stat label="Broken links" value={count(links?.brokenBacklinks)} tone="caution" />
        <Stat
          label="Spam score"
          value={links?.spamScore === null || links?.spamScore === undefined ? dash : `${links.spamScore}`}
          tone={links?.spamScore && links.spamScore >= 30 ? "warning" : "default"}
        />
      </div>
    </div>
  );
}

export function RankedKeywordsView({ rows, total }: { rows: SeoRankedKeyword[]; total: number | null }) {
  return (
    <Card>
      <CardHeader
        title="Ranked keywords"
        action={<Chip tone="info">{total === null ? `${rows.length} shown` : `${count(total)} total`}</Chip>}
      />
      <DataTable
        rows={rows}
        keyOf={(row, index) => `${row.keyword}-${index}`}
        empty="This domain ranks for nothing we can see"
        columns={[
          { header: "#", numeric: true, width: "60px", render: (row) => count(row.position) },
          ...KEYWORD_COLUMNS,
          { header: "Traffic", numeric: true, render: (row) => count(row.trafficEstimate) },
          { header: "Page", render: (row) => <External href={row.url}>{row.url ?? dash}</External> },
        ]}
      />
    </Card>
  );
}

export function KeywordsView({ seed, ideas }: { seed: SeoKeyword | null; ideas: SeoKeyword[] }) {
  return (
    <div className="space-y-6">
      {seed && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Searches / month" value={count(seed.volume)} tone="primary" />
          <Stat label="Difficulty" value={seed.difficulty === null ? dash : `${seed.difficulty}`} />
          <Stat label="Cost per click" value={money(seed.cpc)} />
          <Stat label="Intent" value={seed.intent ?? dash} sub={`Competition ${percent(seed.competition)}`} />
        </div>
      )}
      <Card>
        <CardHeader title="Related phrases" action={<Chip tone="info">{ideas.length}</Chip>} />
        <DataTable
          rows={ideas}
          keyOf={(row) => row.keyword}
          empty="No related phrases came back"
          columns={KEYWORD_COLUMNS}
        />
      </Card>
    </div>
  );
}

export function BacklinksView({
  summary,
  referringDomains,
  anchors,
}: {
  summary: SeoBacklinkSummary | null;
  referringDomains: SeoReferringDomain[];
  anchors: SeoAnchor[];
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Backlinks" value={count(summary?.backlinks)} tone="primary" />
        <Stat label="Referring domains" value={count(summary?.referringDomains)} />
        <Stat label="Broken" value={count(summary?.brokenBacklinks)} tone="caution" />
        <Stat
          label="Spam score"
          value={summary?.spamScore === null || summary?.spamScore === undefined ? dash : `${summary.spamScore}`}
          tone={summary?.spamScore && summary.spamScore >= 30 ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Who links here" action={<Chip tone="info">{referringDomains.length}</Chip>} />
          <DataTable
            rows={referringDomains}
            keyOf={(row) => row.domain}
            empty="No referring domains"
            columns={[
              { header: "Domain", render: (row) => <External href={`https://${row.domain}`}>{row.domain}</External> },
              { header: "Rank", numeric: true, render: (row) => count(row.rank) },
              { header: "Links", numeric: true, render: (row) => count(row.backlinks) },
              {
                header: "Since",
                numeric: true,
                render: (row) => (row.firstSeen ? row.firstSeen.slice(0, 10) : dash),
              },
              {
                header: "Status",
                render: (row) =>
                  row.lostDate ? <Chip tone="danger">lost</Chip> : <Chip tone="success">live</Chip>,
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Anchor text" action={<Chip tone="info">{anchors.length}</Chip>} />
          <DataTable
            rows={anchors}
            keyOf={(row, index) => `${row.anchor}-${index}`}
            empty="No anchors"
            columns={[
              {
                header: "Anchor",
                render: (row) => (
                  <span dir="auto" className="block break-words">
                    {row.anchor}
                  </span>
                ),
              },
              { header: "Links", numeric: true, render: (row) => count(row.backlinks) },
              { header: "Domains", numeric: true, render: (row) => count(row.referringDomains) },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

export function CompetitorsView({ rows }: { rows: SeoCompetitor[] }) {
  return (
    <Card>
      <CardHeader title="Competing domains" action={<Chip tone="info">{rows.length}</Chip>} />
      <DataTable
        rows={rows}
        keyOf={(row) => row.domain}
        empty="No competitors found"
        columns={[
          { header: "Domain", render: (row) => <External href={`https://${row.domain}`}>{row.domain}</External> },
          { header: "Shared keywords", numeric: true, render: (row) => count(row.intersections) },
          {
            header: "Avg position",
            numeric: true,
            render: (row) => (row.avgPosition === null ? dash : row.avgPosition.toFixed(1)),
          },
          { header: "Their keywords", numeric: true, render: (row) => count(row.organicKeywords) },
          { header: "Their traffic", numeric: true, render: (row) => count(row.organicTraffic) },
        ]}
      />
    </Card>
  );
}

export function GapView({ rows, rival, total }: { rows: SeoGapKeyword[]; rival: string; total: number | null }) {
  return (
    <Card>
      <CardHeader
        title={`What ${rival} has and you do not`}
        action={<Chip tone="info">{total === null ? `${rows.length}` : `${count(total)} total`}</Chip>}
      />
      <DataTable
        rows={rows}
        keyOf={(row) => row.keyword}
        empty="Nothing they rank for that you are missing"
        columns={[
          ...KEYWORD_COLUMNS,
          { header: "Their #", numeric: true, render: (row) => count(row.theirPosition) },
          {
            header: "Their page",
            render: (row) => <External href={row.theirUrl}>{row.theirUrl ?? dash}</External>,
          },
        ]}
      />
    </Card>
  );
}

export function SerpView({ rows, keyword }: { rows: SeoSerpResult[]; keyword: string }) {
  return (
    <Card>
      <CardHeader title={`Google right now — ${keyword}`} action={<Chip tone="info">{rows.length}</Chip>} />
      {rows.length === 0 ? (
        <EmptyState title="No organic results came back" />
      ) : (
        <ol className="divide-y divide-border/60">
          {rows.map((row, index) => (
            <li key={`${row.url}-${index}`} className="flex gap-4 px-5 py-3.5">
              <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-sm text-muted-foreground">
                {count(row.position)}
              </span>
              <div className="min-w-0 space-y-1">
                <span dir="auto" className="block">
                  <External href={row.url}>{row.title ?? row.url ?? dash}</External>
                </span>
                <p className="font-mono text-[11px] text-muted-foreground">{row.domain ?? dash}</p>
                {row.description && (
                  <p dir="auto" className="line-clamp-2 text-xs text-muted-foreground">
                    {row.description}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
