/**
 * Cluster locale resolution — which language and country an article is
 * written for.
 *
 * No language is privileged. A row for the exact cluster wins; a '*' row is
 * the site-wide setting; nothing at all means the en/US default (the golden
 * test in src/writer/prompt-golden.test.ts freezes that path).
 *
 * Security note (T-quick-01): stored language/country values are operator
 * input on the way to a model prompt. They are allowlisted at the admin API,
 * and — defense in depth — anything outside the fixed ISO 639-1 list resolves
 * to the default here. Prompts only ever interpolate `languageName`, which is
 * derived from the list below, never from the stored string.
 *
 * Deliberately separate from src/config/domain.ts CONTENT_LANGUAGE /
 * LANGUAGE_RULE — those serve the legacy octypo writer-agents path, which is
 * env-level and has no cluster concept.
 */

import { logger } from "../lib/logger.js";

export interface ClusterLocale {
  /** ISO 639-1 code, guaranteed to be on the fixed list below. */
  language: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Plain English language name — the ONLY value that reaches prompts. */
  languageName: string;
  /** True when no setting exists and the en/US default applies. */
  isDefault: boolean;
}

/**
 * Every ISO 639-1 code. This fixed list is the allowlist: a code is valid only
 * if it appears here, so what an operator stored never decides what is valid.
 */
const ISO_639_1_CODES: readonly string[] = (
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch " +
  "co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga " +
  "gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja " +
  "jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv " +
  "mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or " +
  "os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg sh si sk sl sm sn so sq " +
  "sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve " +
  "vi vo wa wo xh yi yo za zh zu"
).split(" ");

/**
 * Code → plain English name. Plain names are what models follow reliably (see
 * the CONTENT_LANGUAGE comment in domain.ts). Derived from the runtime's own
 * language data, and with no prototype, so "constructor" is not a key.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = (() => {
  const display = new Intl.DisplayNames(["en"], { type: "language" });
  const names: Record<string, string> = Object.create(null);
  for (const code of ISO_639_1_CODES) names[code] = display.of(code) ?? code;
  return Object.freeze(names);
})();

/** The internal English name for a code, or null when the code is not on the list. */
export function languageNameFor(code: unknown): string | null {
  return typeof code === "string" ? (LANGUAGE_NAMES[code] ?? null) : null;
}

export const DEFAULT_LOCALE: ClusterLocale = Object.freeze({
  language: "en",
  country: "US",
  languageName: "English",
  isDefault: true,
});

interface SettingsRow {
  cluster: string;
  language: string;
  country: string;
}

export interface ResolveLocaleDeps {
  /** Injected row loader for tests; defaults to the cluster_settings table. */
  loadSettings?: (scopes: string[]) => Promise<SettingsRow[]>;
}

async function loadFromDb(scopes: string[]): Promise<SettingsRow[]> {
  // Dynamic imports keep this module inert for callers that inject deps —
  // no database pool is touched unless the default loader actually runs.
  const [{ db }, { clusterSettings }, { inArray }] = await Promise.all([
    import("../db.js"),
    import("../schema/index.js"),
    import("drizzle-orm"),
  ]);
  return db
    .select({
      cluster: clusterSettings.cluster,
      language: clusterSettings.language,
      country: clusterSettings.country,
    })
    .from(clusterSettings)
    .where(inArray(clusterSettings.cluster, scopes));
}

/**
 * Resolve the locale for a cluster: exact row → '*' row → en/US default.
 *
 * Never throws — a locale lookup failure must not stop an article from being
 * written; it falls back to the default (today's behavior) and logs.
 */
export async function resolveLocale(
  cluster: string | null,
  deps?: ResolveLocaleDeps
): Promise<ClusterLocale> {
  const scopes = cluster && cluster !== "*" ? [cluster, "*"] : ["*"];
  let rows: SettingsRow[] = [];
  try {
    rows = await (deps?.loadSettings ?? loadFromDb)(scopes);
  } catch (error) {
    logger.warn({ error, cluster }, "[Locale] Settings lookup failed — using the default");
    return DEFAULT_LOCALE;
  }

  const valid = (rows ?? []).filter(
    (row) =>
      row &&
      languageNameFor(row.language) !== null &&
      typeof row.country === "string" &&
      /^[A-Z]{2}$/.test(row.country)
  );
  const invalid = (rows ?? []).filter((row) => row && row.language && !valid.includes(row));
  if (invalid.length > 0) {
    logger.warn(
      { cluster, invalid: invalid.map((r) => r.cluster) },
      "[Locale] Ignoring cluster_settings rows outside the allowlist"
    );
  }

  const row =
    valid.find((r) => cluster && r.cluster === cluster) ?? valid.find((r) => r.cluster === "*");
  if (!row) return DEFAULT_LOCALE;

  return {
    language: row.language,
    country: row.country,
    languageName: LANGUAGE_NAMES[row.language]!,
    isDefault: false,
  };
}
