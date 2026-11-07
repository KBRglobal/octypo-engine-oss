/**
 * Where the target phrases stand in Google, this month against last.
 *
 * The one card on the Overview that is about the outcome rather than the
 * output. Articles written is what the engine did; phrases on page one is
 * what the client bought. It reads from the monthly tracker and never asks
 * for a measurement itself — the button is for the day a client asks "and
 * now?", and it says what it costs.
 */
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Minus, RefreshCw } from "lucide-react";

import { api } from "../lib/api";
import { Card, CardHeader, Chip, EmptyState, GhostButton, Stat } from "./studio";
import type { RankMovement, RankReport } from "../lib/types";

const delta = (current: number, previous: number | undefined) =>
  previous === undefined ? "" : `${current - previous >= 0 ? "+" : ""}${current - previous} since last`;

function Movement({ row }: { row: RankMovement }) {
  const icon =
    row.change === null ? (
      <Minus size={12} className="text-muted-foreground" />
    ) : row.change > 0 ? (
      <ArrowUp size={12} className="text-chart-2" />
    ) : row.change < 0 ? (
      <ArrowDown size={12} className="text-destructive" />
    ) : (
      <Minus size={12} className="text-muted-foreground" />
    );

  return (
    <li className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm">
      <span dir="auto" className="min-w-0 truncate">
        {row.keyword}
      </span>
      <span className="flex shrink-0 items-center gap-3 font-mono text-xs">
        <span className="text-muted-foreground">{row.searchVolume?.toLocaleString("en-US") ?? "—"}/mo</span>
        <span className="flex w-16 items-center justify-end gap-1">
          {icon}
          {row.position === null ? <span className="text-muted-foreground">not ranking</span> : `#${row.position}`}
        </span>
      </span>
    </li>
  );
}

export function RankCard() {
  const [report, setReport] = useState<RankReport | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = () =>
    api
      .ranks()
      .then(setReport)
      .catch(() => setFailed(true));

  useEffect(() => {
    void load();
  }, []);

  async function measureNow() {
    setMeasuring(true);
    try {
      await api.measureRanks();
      await load();
    } finally {
      setMeasuring(false);
    }
  }

  if (failed) return null;

  const current = report?.current ?? null;
  const previous = report?.previous ?? undefined;
  const movers = (report?.movements ?? []).filter((row) => row.position !== null).slice(0, 8);

  return (
    <Card>
      <CardHeader
        title="Rankings"
        action={
          <span className="flex items-center gap-2">
            {current && (
              <Chip tone="neutral">measured {new Date(current.measuredAt).toLocaleDateString()}</Chip>
            )}
            <GhostButton onClick={() => void measureNow()} disabled={measuring}>
              <RefreshCw size={12} className={measuring ? "animate-spin" : ""} />
              Measure now · ~$0.10
            </GhostButton>
          </span>
        }
      />
      {!current ? (
        <EmptyState title="No reading yet">
          The tracker measures every target phrase once a month, on its own. The first reading
          comes a few minutes after the bank is built.
        </EmptyState>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
            <Stat label="On page one" value={current.top10} tone="primary" sub={delta(current.top10, previous?.top10)} />
            <Stat label="In the top three" value={current.top3} tone="success" sub={delta(current.top3, previous?.top3)} />
            <Stat label="Ranking at all" value={current.ranking} sub={delta(current.ranking, previous?.ranking)} />
            <Stat label="Phrases tracked" value={current.tracked} sub="from the bank and the articles" />
          </div>
          {movers.length > 0 && (
            <ul className="divide-y divide-border/60 border-t border-border">
              {movers.map((row) => (
                <Movement key={row.keyword} row={row} />
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
