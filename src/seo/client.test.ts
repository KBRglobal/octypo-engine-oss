import { describe, expect, it } from "vitest";

import { readEnvelope, SeoApiError } from "./client.js";

const ok = (tasks: unknown[], cost = 0) => ({ status_code: 20000, cost, tasks });

describe("readEnvelope", () => {
  it("reads the items of a list endpoint", () => {
    const response = readEnvelope(
      ok([{ status_code: 20000, result: [{ total_count: 2, items: [{ a: 1 }, { a: 2 }] }] }], 0.024)
    );
    expect(response.rows).toHaveLength(2);
    expect(response.head?.total_count).toBe(2);
    expect(response.costUsd).toBe(0.024);
  });

  it("keeps a summary endpoint's answer as the head, with no rows", () => {
    const response = readEnvelope(
      ok([{ status_code: 20000, result: [{ target: "a.com", backlinks: 91 }] }])
    );
    expect(response.rows).toEqual([]);
    expect(response.head).toEqual({ target: "a.com", backlinks: 91 });
  });

  it("keeps one entry per input for the endpoints shaped that way", () => {
    const response = readEnvelope(
      ok([{ status_code: 20000, result: [{ keyword: "a" }, { keyword: "b" }] }])
    );
    expect(response.results).toHaveLength(2);
  });

  // A failed DataForSEO call arrives as HTTP 200 with the failure in the body.
  // Reading only the HTTP status is how a quota error becomes an empty table.
  it("throws on an envelope error even though the HTTP call succeeded", () => {
    expect(() =>
      readEnvelope({ status_code: 40200, status_message: "Payment Required.", tasks: [] })
    ).toThrow(/Payment Required/);
  });

  it("throws on a task error inside a successful envelope", () => {
    expect(() =>
      readEnvelope(ok([{ status_code: 40501, status_message: "Invalid Field: 'target'." }]))
    ).toThrow(/Invalid Field/);
  });

  it("carries the provider's own code", () => {
    try {
      readEnvelope({ status_code: 40200, status_message: "Payment Required.", tasks: [] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SeoApiError);
      expect((error as SeoApiError).providerCode).toBe(40200);
    }
  });

  it("rejects a body that is not a response at all", () => {
    expect(() => readEnvelope("<html>502</html>")).toThrow(SeoApiError);
  });
});
