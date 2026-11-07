/**
 * What this install is: identity, capabilities the customer bought, and the
 * schedulers' pace. Read-only on purpose — these are environment decisions,
 * changed at deploy time, and a screen that silently edits production config
 * is how a customer's site changes behaviour with no audit trail.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

import { Card, CardHeader, Chip, EmptyState } from "../components/studio";
import { api } from "../lib/api";
import { activeInstall } from "../lib/installs";

const ALL_CAPABILITIES = [
  ["stock-images", "Real stock photography"],
  ["generated-images", "AI image generation"],
  ["image-optimisation", "WebP optimisation & storage"],
  ["cdn-delivery", "CDN image delivery"],
  ["article-video", "Promo video per article"],
  ["internal-links", "Internal linking"],
  ["search-research", "Live search research"],
  ["indexnow", "Instant indexing pings"],
  ["document-library", "Document library"],
] as const;

interface StatusPayload {
  capabilities?: string[];
  scheduler?: { running: boolean; config?: { globalDailyLimit?: number; intervalMinutes?: number } };
  ideaBank?: { scheduler?: { dailyLimit?: number; running?: boolean } };
}

interface HealthPayload {
  version?: string;
  builtAt?: string;
}

export default function Settings() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState(false);
  const [health, setHealth] = useState<HealthPayload | null>(null);

  // Read from the ACTIVE install so Settings reflects the client the operator
  // selected, not always the local engine.
  useEffect(() => {
    api
      .pipelineStatus()
      .then((s) => setStatus(s as unknown as StatusPayload))
      .catch(() => setError(true));
    // /health is unauthenticated; a fetch failure renders as a quiet dash.
    fetch(`${activeInstall().baseUrl}/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((h) => setHealth((h as HealthPayload) ?? null))
      .catch(() => setHealth(null));
  }, []);

  const version = typeof health?.version === "string" && health.version ? health.version.slice(0, 7) : null;
  const builtAt =
    typeof health?.builtAt === "string" && !Number.isNaN(Date.parse(health.builtAt))
      ? new Date(health.builtAt).toLocaleString()
      : null;

  const granted = new Set(status?.capabilities ?? []);

  return (
    <>
      <div>
        <h1 className="font-heading text-3xl font-bold uppercase tracking-wide">Settings</h1>
        <p className="text-sm text-muted-foreground">
          This install's plan and pace. Changed at deploy time, on purpose — not from a screen.
        </p>
      </div>

      {error ? (
        <Card>
          <EmptyState title="Engine unreachable" />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="Capabilities"
              action={<Chip tone="primary">{granted.size} granted</Chip>}
            />
            <ul className="divide-y divide-border/60">
              {ALL_CAPABILITIES.map(([key, label]) => {
                const on = granted.has(key);
                return (
                  <li key={key} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-sm font-medium">{label}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">{key}</p>
                    </div>
                    {on ? (
                      <CheckCircle2 size={17} className="text-chart-2" />
                    ) : (
                      <XCircle size={17} className="text-muted-foreground/50" />
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card className="h-fit">
            <CardHeader title="Pace" />
            <ul className="divide-y divide-border/60 text-sm">
              <li className="flex items-center justify-between px-5 py-3">
                <span>RSS scheduler</span>
                <Chip tone={status?.scheduler?.running ? "success" : "neutral"}>
                  {status?.scheduler?.running ? "running" : "off"}
                </Chip>
              </li>
              <li className="flex items-center justify-between px-5 py-3">
                <span>Daily article limit</span>
                <span className="font-mono text-xs">
                  {status?.scheduler?.config?.globalDailyLimit ?? "—"}
                </span>
              </li>
              <li className="flex items-center justify-between px-5 py-3">
                <span>Idea-bank writes per day</span>
                <span className="font-mono text-xs">
                  {status?.ideaBank?.scheduler?.dailyLimit ?? "—"}
                </span>
              </li>
              <li className="flex items-center justify-between px-5 py-3">
                <span>Engine version</span>
                <span className="font-mono text-xs">{version ?? "—"}</span>
              </li>
              <li className="flex items-center justify-between px-5 py-3">
                <span>Built</span>
                <span className="font-mono text-xs">{builtAt ?? "—"}</span>
              </li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
