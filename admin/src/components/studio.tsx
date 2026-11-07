/**
 * Small shared pieces of the Studio design language, so every page speaks it
 * the same way: one card, one stat, one chip, one empty state.
 */
import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-card shadow-sm ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h2 className="font-heading text-lg font-bold uppercase tracking-wide">{title}</h2>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "caution";
}) {
  const valueTone =
    tone === "primary"
      ? "text-primary"
      : tone === "success"
        ? "text-chart-2"
        : tone === "warning"
          ? "text-destructive"
          : tone === "caution"
            ? "text-caution"
            : "text-foreground";
  return (
    <Card className="p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 font-heading text-3xl font-bold tracking-wide ${valueTone}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

const CHIP_TONES: Record<string, string> = {
  neutral: "border-border bg-input text-muted-foreground",
  primary: "border-primary/40 bg-primary/10 text-primary",
  success: "border-chart-2/40 bg-chart-2/10 text-chart-2",
  info: "border-accent-foreground/40 bg-secondary text-accent-foreground",
  danger: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function Chip({ tone = "neutral", children }: { tone?: keyof typeof CHIP_TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${CHIP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="font-heading text-xl font-bold uppercase tracking-wide text-foreground">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
        danger
          ? "border-destructive/40 text-destructive hover:bg-destructive/10"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
