/**
 * One HTTP call, classified.
 *
 * Every adapter needs the same three things and gets them wrong in the same
 * three ways, so they live here once:
 *
 *  - A timeout. A customer's WordPress that accepts the connection and then
 *    never answers would otherwise hold a publish job open until the reaper
 *    kills it.
 *  - A distinction between "the site is broken" (5xx, DNS, TCP, TLS, timeout)
 *    and "the site refused this request" (4xx). The first is worth retrying,
 *    the second never is, and a queue that cannot tell them apart either gives
 *    up on a blip or hammers a site with a payload it will always reject.
 *  - Never throwing. A thrown error inside a publish is an unclassified result,
 *    and an unclassified result is how an engine claims success for a write
 *    that never happened.
 */

import type { PublishErrorCode } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

export type HttpResult =
  | { ok: true; status: number; body: unknown; text: string }
  | { ok: false; status: number; code: PublishErrorCode; message: string };

export type FetchLike = typeof fetch;

/**
 * 401/403 are the credential story; 404 is its own story (adapters recover from
 * it); 429 and 5xx are the site, not us; anything else 4xx is a payload we must
 * not keep resending.
 */
export function classifyStatus(status: number): PublishErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429 || status >= 500) return "unreachable";
  if (status >= 400) return "rejected";
  return "unknown";
}

/** Trim a remote error body to something a log line can carry. */
export function summarise(text: string, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as { message?: unknown; code?: unknown; error?: unknown };
    const message = record.message ?? record.error;
    if (typeof message === "string" && message.trim()) {
      return record.code ? `${String(record.code)}: ${message}` : message;
    }
  }
  return text.slice(0, 300).replace(/\s+/g, " ").trim();
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | undefined;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export async function request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await doFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A CMS behind a proxy answers HTML on a bad day. That is not a parse bug,
      // it is a broken site — handled below by status, not by throwing.
      body = undefined;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: classifyStatus(response.status),
        message: summarise(text, body) || `HTTP ${response.status}`,
      };
    }
    return { ok: true, status: response.status, body, text };
  } catch (error) {
    // AbortError, ECONNREFUSED, ENOTFOUND, TLS failures — the site is not there.
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: 0,
      code: "unreachable",
      message: aborted ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch binary content (a hero image) with the same guarantees. */
export async function requestBytes(
  url: string,
  options: RequestOptions = {}
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; message: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status} fetching ${url}` };
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) return { ok: false, message: `empty body fetching ${url}` };
    return {
      ok: true,
      bytes: buffer,
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
