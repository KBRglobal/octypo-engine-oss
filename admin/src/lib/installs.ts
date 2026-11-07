/**
 * The client registry — the "folders" of the Studio.
 *
 * Octypo is one deployment per client on purpose (isolation is the product's
 * safety story), but the operator needs one cockpit over all of them. So the
 * Studio keeps a local registry of installs — name, engine URL, admin token —
 * and every API call goes to whichever install is active. Engines stay
 * strangers to each other; only this browser knows the whole fleet.
 */

export interface Install {
  id: string;
  name: string;
  /** Engine base URL, no trailing slash. Empty string = this console's own engine. */
  baseUrl: string;
  token: string;
}

const KEY = "octypo_installs";
const ACTIVE_KEY = "octypo_active_install";

export function listInstalls(): Install[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Install[]) : [];
    if (parsed.length > 0) return parsed;
  } catch {
    // fall through to the default
  }
  return [{ id: "local", name: "This install", baseUrl: "", token: "" }];
}

export function saveInstalls(installs: Install[]): void {
  localStorage.setItem(KEY, JSON.stringify(installs));
}

export function activeInstall(): Install {
  const id = localStorage.getItem(ACTIVE_KEY);
  const installs = listInstalls();
  return installs.find((install) => install.id === id) ?? installs[0];
}

export function setActiveInstall(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function addInstall(install: Omit<Install, "id">): Install {
  const created = {
    ...install,
    id: crypto.randomUUID(),
    baseUrl: install.baseUrl.replace(/\/+$/, ""),
  };
  saveInstalls([...listInstalls(), created]);
  return created;
}

export function removeInstall(id: string): void {
  saveInstalls(listInstalls().filter((install) => install.id !== id));
  if (localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
}
