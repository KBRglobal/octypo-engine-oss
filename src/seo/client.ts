/**
 * DataForSEO, for a person clicking a button.
 *
 * The engine already has a keyword-data provider (`research/keyword-data.ts`),
 * and it deliberately swallows every failure: research informs a decision, it
 * is not the decision, so a provider outage must degrade a ranking rather than
 * stop a publish.
 *
 * A desk tool is the opposite case. Someone typed a domain, pressed a button
 * and is now looking at an empty table — "no rows" and "your account is out of
 * money" must not look the same. So this client throws, carries the provider's
 * own message, and reports what the call cost, because every call here is a
 * purchase somebody made on purpose.
 */

import { dataForSeoConfigFromEnv, type DataForSeoConfig } from "../research/keyword-data.js";

const DFS_BASE = "https://api.dataforseo.com/v3";
const DEFAULT_TIMEOUT_MS = 60_000;

/** A failure worth showing: the provider's own words, not a generic retry. */
export class SeoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly providerCode?: number
  ) {
    super(message);
    this.name = "SeoApiError";
  }
}

/**
 * DataForSEO nests its answer three different ways, and which one an endpoint
 * uses is not guessable from its name, so all three are handed over rather
 * than flattened into one lossy "rows":
 *
 * - `result[0].items[]` — the list endpoints (ranked keywords, backlinks, SERP)
 * - `result[0]` — the summary endpoints (backlinks summary, rank overview)
 * - `result[]` — one entry per thing asked about (bulk search volume)
 */
export interface SeoResponse<T = Record<string, unknown>> {
  /** `result[0].items[]`, empty when the endpoint has no item list. */
  rows: T[];
  /** `result[0]` — where a summary endpoint keeps its answer. */
  head: Record<string, unknown> | null;
  /** `result[]` itself, for the endpoints that answer one entry per input. */
  results: Record<string, unknown>[];
  /** What DataForSEO charged for this call, in USD. */
  costUsd: number;
  /** The task's own id — the handle a queued job is collected by later. */
  taskId: string | null;
  /** The task's status line, which for a queued job is "Task Created." */
  statusMessage: string;
}

/**
 * A queued task reports 20100 ("Task Created"), not 20000, and carries no
 * result at all. Treating that as a failure would make every asynchronous
 * endpoint — the whole On-Page crawl among them — look broken.
 */
const TASK_CREATED = 20100;

export interface SeoClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Which country and language a question is being asked about. */
export interface Market {
  locationCode?: number;
  languageCode?: string;
}

/**
 * DataForSEO answers 200 OK with the failure inside the body, at two levels:
 * the envelope's `status_code` and each task's own. 20000 is success; a task
 * that failed still arrives in a 200. Reading only the HTTP status is how a
 * quota error becomes an empty table.
 */
export function readEnvelope<T>(payload: unknown): SeoResponse<T> {
  if (!payload || typeof payload !== "object") {
    throw new SeoApiError("The provider returned something that was not a response.", 502);
  }
  const body = payload as Record<string, unknown>;
  const code = typeof body.status_code === "number" ? body.status_code : 0;
  if (code !== 20000) {
    throw new SeoApiError(
      typeof body.status_message === "string" ? body.status_message : "The provider refused the request.",
      502,
      code
    );
  }

  const tasks = Array.isArray(body.tasks) ? (body.tasks as Record<string, unknown>[]) : [];
  const task = tasks[0];
  if (!task) throw new SeoApiError("The provider returned no task.", 502);

  const taskCode = typeof task.status_code === "number" ? task.status_code : 0;
  if (taskCode !== 20000 && taskCode !== TASK_CREATED) {
    throw new SeoApiError(
      typeof task.status_message === "string" ? task.status_message : "The task failed.",
      502,
      taskCode
    );
  }

  const result = Array.isArray(task.result)
    ? (task.result.filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[])
    : [];
  const head = result[0] ?? null;

  return {
    rows: head && Array.isArray(head.items) ? (head.items as T[]) : [],
    head,
    results: result,
    costUsd: typeof body.cost === "number" ? body.cost : 0,
    taskId: typeof task.id === "string" ? task.id : null,
    statusMessage: typeof task.status_message === "string" ? task.status_message : "Ok.",
  };
}

export class SeoClient {
  constructor(
    private readonly config: DataForSeoConfig,
    private readonly options: SeoClientOptions = {}
  ) {}

  private authHeader(): string {
    const token = Buffer.from(`${this.config.login}:${this.config.password}`).toString("base64");
    return `Basic ${token}`;
  }

  /** Whatever this account was configured with, for the UI to show and label. */
  get defaults(): { locationCode?: number; languageCode?: string } {
    return { locationCode: this.config.locationCode, languageCode: this.config.languageCode };
  }

  private async send(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const res = await doFetch(`${DFS_BASE}${path}`, {
        ...init,
        headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
        signal: controller.signal,
      });
      if (res.status === 401) {
        throw new SeoApiError("DataForSEO rejected the login for this install.", 401);
      }
      if (!res.ok) {
        throw new SeoApiError(`DataForSEO answered ${res.status}.`, 502);
      }
      return await res.json();
    } catch (error) {
      if (error instanceof SeoApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SeoApiError("DataForSEO took too long to answer.", 504);
      }
      throw new SeoApiError("Could not reach DataForSEO.", 502);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One live task, in a market.
   *
   * The market is a third argument rather than two more keys in `params` on
   * purpose: spread into the body, an absent override would write
   * `location_code: undefined`, JSON would drop the key, and DataForSEO would
   * quietly answer for the United States — the wrong country, with no error.
   */
  async post<T = Record<string, unknown>>(
    path: string,
    params: Record<string, unknown>,
    market: Market = {}
  ): Promise<SeoResponse<T>> {
    const body = [
      {
        location_code: market.locationCode ?? this.config.locationCode,
        language_code: market.languageCode ?? this.config.languageCode,
        ...params,
      },
    ];
    return readEnvelope<T>(await this.send(path, { method: "POST", body: JSON.stringify(body) }));
  }

  /** A free appendix read — balance, prices, locations. */
  async get<T = Record<string, unknown>>(path: string): Promise<SeoResponse<T>> {
    return readEnvelope<T>(await this.send(path, { method: "GET" }));
  }
}

/** Null when this install has no DataForSEO login — the desk then stays hidden. */
export function seoClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: SeoClientOptions = {}
): SeoClient | null {
  const config = dataForSeoConfigFromEnv(env);
  return config ? new SeoClient(config, options) : null;
}
