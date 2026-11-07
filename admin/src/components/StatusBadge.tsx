const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  published: { label: "Published", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground border-border" },
  in_review: { label: "In Review", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  scheduled: { label: "Scheduled", cls: "bg-sky-500/10 text-sky-400 border-sky-500/30" },
  archived: { label: "Archived", cls: "bg-zinc-500/10 text-muted-foreground border-zinc-500/30" },
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? {
    label: status,
    cls: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${style.cls}`}
    >
      {style.label}
    </span>
  );
}
