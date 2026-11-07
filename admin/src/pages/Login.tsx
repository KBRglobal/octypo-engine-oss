import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";

import { api, getToken, setToken, ApiError } from "../lib/api";

export function Login() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (getToken()) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const { token } = await api.login(password);
      setToken(token);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setError("Admin is disabled — set ADMIN_PASSWORD on the server.");
      } else {
        setError("Wrong password. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-shell p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500 text-xl font-bold text-white shadow-lg shadow-indigo-500/30">
            O
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-foreground">Octypo Admin</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to manage your content engine</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="rounded-xl border border-border bg-panel p-6 shadow-2xl"
        >
          <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Password
          </label>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            className="mt-2 w-full rounded-lg border border-border bg-shell px-3 py-2.5 text-sm text-foreground placeholder-muted-foreground/60 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          />
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-5 w-full rounded-lg bg-indigo-500 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
