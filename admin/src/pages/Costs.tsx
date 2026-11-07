/**
 * What this client costs us. The ledger is the durable truth — it survives
 * restarts — and this page is what the margin conversation is had over.
 */
import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { Card, CardHeader, Chip, EmptyState, Stat } from "../components/studio";

interface Ledger {
  todayUsd: number;
  monthUsd: number;
  totalUsd: number;
  perDay: { day: string; usd: number; calls: number }[];
  perModel: { model: string; usd: number; calls: number }[];
  articlesMetered: number;
  avgArticleUsd: number;
}

const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

export default function Costs() {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .costs()
      .then((data) => setLedger((data as { ledger?: Ledger }).ledger ?? null))
      .catch(() => setFailed(true));
  }, []);

  return (
    <>
      <div>
        <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Costs</h1>
        <p className="text-sm text-muted-foreground">
          The durable ledger — every model call this install ever paid for.
        </p>
      </div>

      {failed || !ledger ? (
        <Card>
          <EmptyState title={failed ? "Engine unreachable" : "No spend recorded yet"}>
            The ledger fills as articles are written.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Today" value={usd(ledger.todayUsd)} />
            <Stat label="This month" value={usd(ledger.monthUsd)} tone="primary" />
            <Stat label="All time" value={usd(ledger.totalUsd)} />
            <Stat
              label="Avg / article"
              value={usd(ledger.avgArticleUsd)}
              sub={`${ledger.articlesMetered} articles metered`}
              tone="success"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="By model" />
              {ledger.perModel.length === 0 ? (
                <EmptyState title="Nothing yet" />
              ) : (
                <ul className="divide-y divide-border/60">
                  {ledger.perModel.map((row) => (
                    <li key={row.model} className="flex items-center justify-between px-5 py-3 text-sm">
                      <span className="font-mono text-xs">{row.model}</span>
                      <span className="flex items-center gap-3">
                        <Chip tone="neutral">{row.calls} calls</Chip>
                        <span className="font-mono">{usd(row.usd)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader title="Last 30 days" />
              {ledger.perDay.length === 0 ? (
                <EmptyState title="Nothing yet" />
              ) : (
                <ul className="divide-y divide-border/60">
                  {[...ledger.perDay].reverse().map((row) => (
                    <li key={row.day} className="flex items-center justify-between px-5 py-2.5 text-sm">
                      <span className="font-mono text-xs text-muted-foreground">{row.day}</span>
                      <span className="flex items-center gap-3">
                        <span className="font-mono text-xs text-muted-foreground">{row.calls} calls</span>
                        <span className="font-mono">{usd(row.usd)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
