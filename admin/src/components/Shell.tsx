/**
 * The Studio shell — sidebar and topbar, ported from the design export.
 *
 * The sidebar is the product's mental model, in working order:
 * PLAN (idea bank) → FACTS → REVIEW → SCHEDULE → LIVE, with the sources that
 * feed the plan (feeds, library, all articles) grouped separately below.
 */
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Bell,
  CircleDollarSign,
  Building2,
  ChevronDown,
  Plus,
  Trash2,
  CalendarClock,
  Database,
  FileCheck2,
  LayoutDashboard,
  Library as LibraryIcon,
  Lightbulb,
  LogOut,
  Menu,
  Newspaper,
  Radio,
  Rss,
  SearchCheck,
  Settings2,
  UserPlus,
  X,
} from "lucide-react";

import { api, clearToken } from "../lib/api";
import {
  activeInstall,
  addInstall,
  listInstalls,
  removeInstall,
  setActiveInstall,
  type Install,
} from "../lib/installs";

const PIPELINE = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/onboard", label: "New Client", icon: UserPlus, badge: "SETUP" },
  { to: "/ideas", label: "Idea Bank", icon: Lightbulb, badge: "PLAN" },
  { to: "/facts", label: "Facts", icon: Database },
  { to: "/review", label: "Review", icon: FileCheck2 },
  { to: "/schedule", label: "Schedule", icon: CalendarClock },
  { to: "/live", label: "Live", icon: Radio },
  { to: "/costs", label: "Costs", icon: CircleDollarSign },
];

const SOURCES = [
  { to: "/articles", label: "All Articles", icon: Newspaper },
  { to: "/feeds", label: "Feeds", icon: Rss },
  { to: "/library", label: "Library", icon: LibraryIcon },
];

/**
 * Optional: keyword and rank research through the operator's own DataForSEO
 * credentials. Hidden unless the feature is switched on, so an install without
 * them never shows a tool it cannot use. The engine answers 404 there, which
 * is the signal.
 */
const RESEARCH = [{ to: "/seo", label: "SEO Desk", icon: SearchCheck }];

function NavItem({
  to,
  label,
  icon: Icon,
  badge,
  end,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  end?: boolean;
  onNavigate: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
          isActive
            ? "bg-primary/10 border border-primary/25 text-primary font-semibold"
            : "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
        }`
      }
    >
      <Icon size={16} />
      <span>{label}</span>
      {badge && (
        <span className="ml-auto rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-foreground">
          {badge}
        </span>
      )}
    </NavLink>
  );
}

export default function Shell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<"up" | "down" | "unknown">("unknown");
  const [hasSeoTools, setHasSeoTools] = useState(false);

  useEffect(() => {
    api
      .pipelineStatus()
      .then(() => setHealth("up"))
      .catch(() => setHealth("down"));
    // Off installs answer 404 here, which is the whole signal.
    api
      .seoStatus()
      .then((status) => setHasSeoTools(status.enabled))
      .catch(() => setHasSeoTools(false));
  }, []);

  const close = () => setOpen(false);
  const logout = () => {
    clearToken();
    navigate("/login");
  };

  const sidebar = (
    <div className="flex h-full flex-col px-4 py-5">
      <div className="mb-6 flex items-center gap-3 px-2">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/40 bg-primary/15 font-heading text-xl font-bold text-primary shadow-[0_0_14px_rgba(255,91,55,0.25)]">
          O
        </div>
        <div>
          <div className="font-heading text-xl font-bold uppercase tracking-wider">OCTYPO</div>
          <div className="font-mono text-[10px] font-bold tracking-[0.22em] text-primary">
            STUDIO ENGINE
          </div>
        </div>
        <button className="ml-auto text-muted-foreground lg:hidden" onClick={close} aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="mb-2.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Engine Pipeline
      </div>
      <nav className="space-y-1">
        {PIPELINE.map((item) => (
          <NavItem key={item.to} {...item} onNavigate={close} />
        ))}
      </nav>

      <div className="mb-2.5 mt-6 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Sources
      </div>
      <nav className="space-y-1">
        {SOURCES.map((item) => (
          <NavItem key={item.to} {...item} onNavigate={close} />
        ))}
      </nav>

      {hasSeoTools && (
        <>
          <div className="mb-2.5 mt-6 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Research
          </div>
          <nav className="space-y-1">
            {RESEARCH.map((item) => (
              <NavItem key={item.to} {...item} onNavigate={close} />
            ))}
          </nav>
        </>
      )}

      <div className="mt-auto space-y-1 border-t border-border pt-4">
        <NavItem to="/settings" label="Settings" icon={Settings2} onNavigate={close} />
        <button
          onClick={logout}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          <LogOut size={16} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background font-sans text-foreground selection:bg-primary/20">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-border bg-card/80 lg:block">
          {sidebar}
        </aside>

        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-black/60" onClick={close} />
            <aside className="absolute inset-y-0 left-0 w-72 border-r border-border bg-card">
              {sidebar}
            </aside>
          </div>
        )}

        <main className="min-w-0 flex-1 pb-16 lg:pb-8">
          <header className="flex h-14 items-center justify-between border-b border-border bg-card/60 px-5 backdrop-blur lg:px-8">
            <div className="flex items-center gap-3">
              <button
                className="text-muted-foreground hover:text-foreground lg:hidden"
                onClick={() => setOpen(true)}
                aria-label="Open menu"
              >
                <Menu size={20} />
              </button>
              <InstallSwitcher health={health} />
            </div>
            <div className="flex items-center gap-3">
              <button className="relative rounded-md border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                <Bell size={16} />
              </button>
              <div className="flex size-7 items-center justify-center rounded-md border border-accent-foreground/30 bg-secondary font-mono text-xs font-semibold text-accent-foreground">
                OP
              </div>
            </div>
          </header>
          <div className="mx-auto max-w-[1400px] space-y-6 px-5 py-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The client folders. One deployment per client stays the architecture; this
 * is the operator's single cockpit over all of them — pick a client, and every
 * screen in the Studio talks to that client's engine, with that client's spend
 * a click away.
 */
function InstallSwitcher({ health }: { health: "up" | "down" | "unknown" }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [installs, setInstalls] = useState<Install[]>(listInstalls());
  const [costs, setCosts] = useState<Record<string, string>>({});
  const active = activeInstall();

  // Spend per install, fetched lazily when the list opens. "Since restart" is
  // the honest scope of the in-memory meter.
  useEffect(() => {
    if (!open) return;
    for (const install of installs) {
      const base = install.baseUrl || "";
      fetch(`${base}/api/admin/costs`, {
        headers: { Authorization: `Bearer ${install.token || localStorage.getItem("octypo_admin_token") || ""}` },
      })
        .then((res) => res.json())
        .then((data) => {
          const eur = ((data?.spend ?? {}) as { spentTodayEur?: number }).spentTodayEur;
          if (typeof eur === "number")
            setCosts((prev) => ({ ...prev, [install.id]: `€${eur.toFixed(2)} today` }));
        })
        .catch(() => undefined);
    }
  }, [open, installs]);

  const choose = (id: string) => {
    setActiveInstall(id);
    window.location.reload();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 rounded-full border border-border bg-input px-3 py-1 text-xs hover:border-primary/40"
      >
        <div
          className={`size-2 rounded-full ${
            health === "up"
              ? "bg-chart-2 shadow-[0_0_8px] shadow-chart-2/80"
              : health === "down"
                ? "bg-destructive"
                : "bg-muted-foreground"
          }`}
        />
        <span className="font-mono text-muted-foreground">
          Client: <span className="font-semibold text-foreground">{active.name}</span>
        </span>
        <ChevronDown size={13} className="text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-9 z-50 w-80 rounded-xl border border-border bg-card p-2 shadow-xl">
          {installs.map((install) => (
            <div
              key={install.id}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${
                install.id === active.id ? "bg-primary/10" : "hover:bg-accent"
              }`}
            >
              <button onClick={() => choose(install.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Building2 size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{install.name}</span>
                {costs[install.id] && (
                  <span className="ms-auto shrink-0 font-mono text-[11px] text-chart-2">
                    {costs[install.id]}
                  </span>
                )}
              </button>
              {install.id !== "local" && (
                <button
                  onClick={() => {
                    const wasActive = install.id === active.id;
                    removeInstall(install.id);
                    setInstalls(listInstalls());
                    // Reload if the active install vanished, so no screen keeps
                    // showing the removed client's data.
                    if (wasActive) window.location.reload();
                  }}
                  className="ms-2 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          <div className="mt-1 border-t border-border pt-1">
            <button
              onClick={() => setAdding(true)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus size={14} /> Add client install
            </button>
          </div>
        </div>
      )}

      {adding && (
        <AddInstall
          onClose={() => setAdding(false)}
          onAdded={() => {
            setInstalls(listInstalls());
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

function AddInstall({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = url.replace(/\/+$/, "");
      const res = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error || `login failed (${res.status})`);
      addInstall({ name, baseUrl: base, token: body.token });
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5">
        <h3 className="mb-4 font-heading text-lg font-bold uppercase tracking-wide">Add client install</h3>
        <div className="space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Client name (e.g. Acme Bakery)"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Engine URL"
            className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm"
            dir="ltr"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy || !name || !password}
              className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
