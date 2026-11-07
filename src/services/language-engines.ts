/**
 * Language engines: a model chosen for one language.
 *
 * General models write some languages far better than others. An operator can
 * point any language at a model that specializes in it, through any
 * OpenAI-compatible endpoint, hosted or local:
 *
 *   LANGUAGE_ENGINES_JSON='{"ja":{"baseURL":"https://host/v1","model":"name","apiKeyEnv":"JA_MODEL_KEY"}}'
 *
 * The config names the variable holding the key, never the key, so the JSON can
 * be read, logged and committed safely. A bad entry is reported and skipped: it
 * must not stop the engine, because the general models still work.
 */

import { languageNameFor } from "../config/locale.js";

export interface LanguageEngineSpec {
  language: string;
  languageName: string;
  baseURL: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  jsonMode: boolean;
}

export interface LanguageEngineConfig {
  specs: LanguageEngineSpec[];
  problems: string[];
}

const DEFAULT_MAX_TOKENS = 8192;
/** The OpenAI client refuses an empty key; local servers ignore this one. */
const NO_KEY = "not-needed";

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function parseEntry(
  language: string,
  entry: unknown,
  env: NodeJS.ProcessEnv
): LanguageEngineSpec | string {
  const languageName = languageNameFor(language);
  if (!languageName) return `"${language}" is not an ISO 639-1 language code`;
  if (typeof entry !== "object" || entry === null) return `${language}: expected an object`;

  const { baseURL, model, apiKeyEnv, maxTokens, jsonMode } = entry as Record<string, unknown>;
  if (typeof baseURL !== "string" || !isHttpUrl(baseURL)) {
    return `${language}: baseURL must be an http or https URL`;
  }
  if (typeof model !== "string" || !model.trim()) return `${language}: model is required`;

  let apiKey = NO_KEY;
  if (apiKeyEnv !== undefined) {
    if (typeof apiKeyEnv !== "string") return `${language}: apiKeyEnv must be a variable name`;
    const value = env[apiKeyEnv]?.trim();
    if (!value) return `${language}: ${apiKeyEnv} is not set`;
    apiKey = value;
  }

  if (maxTokens !== undefined && !(Number.isInteger(maxTokens) && (maxTokens as number) > 0)) {
    return `${language}: maxTokens must be a positive whole number`;
  }

  return {
    language,
    languageName,
    baseURL,
    model: model.trim(),
    apiKey,
    maxTokens: (maxTokens as number | undefined) ?? DEFAULT_MAX_TOKENS,
    jsonMode: jsonMode === true,
  };
}

export function parseLanguageEngines(
  raw: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): LanguageEngineConfig {
  if (!raw?.trim()) return { specs: [], problems: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { specs: [], problems: ["LANGUAGE_ENGINES_JSON is not valid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { specs: [], problems: ["LANGUAGE_ENGINES_JSON must be an object keyed by language code"] };
  }

  const specs: LanguageEngineSpec[] = [];
  const problems: string[] = [];
  for (const [language, entry] of Object.entries(parsed)) {
    const result = parseEntry(language, entry, env);
    if (typeof result === "string") problems.push(result);
    else specs.push(result);
  }
  return { specs, problems };
}
