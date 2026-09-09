import { expect, test } from "bun:test";
import { apiClient } from "../src/client";
import { checkOperations } from "../scripts/check-operations";

const key = "client-test-credential-".repeat(3);

test("Eden preserves proxy prefixes and rejects ambiguous base URLs", async () => {
  for (const baseUrl of [
    "https://api.example.test/proxy/triage",
    "https://api.example.test/proxy/triage/",
  ]) {
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://api.example.test/proxy/triage/api/v1/operations",
      );
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      return Response.json({
        pending: 0,
        classified: 0,
        failed: 0,
        inFlight: 0,
        oldestPendingSeconds: 0,
      });
    }) as typeof fetch;
    expect(
      (await checkOperations(baseUrl, key, undefined, fetcher)).alerts,
    ).toEqual([]);
  }
  for (const suffix of ["?tenant=one", "#fragment", "?", "#"])
    expect(() =>
      apiClient(`https://api.example.test/proxy${suffix}`, key),
    ).toThrow("query or fragment");
});

test("Eden client keeps credentials scoped and exposes queue alerts", async () => {
  const metrics = {
    pending: 1,
    classified: 2,
    failed: 0,
    inFlight: 0,
    oldestPendingSeconds: 300,
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.url).toBe("https://api.example.test/api/v1/operations");
    expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(request.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(metrics);
  }) as typeof fetch;
  const check = () =>
    checkOperations("https://api.example.test", key, undefined, fetcher);
  expect((await check()).alerts).toEqual([]);
  metrics.oldestPendingSeconds = 301;
  metrics.failed = 2;
  expect((await check()).alerts).toEqual(["queue_stalled", "failed_tickets"]);
  metrics.oldestPendingSeconds = Number.NaN;
  await expect(check()).rejects.toThrow("invalid queue metrics");
  const denied = (async (_input: RequestInfo | URL) =>
    Response.json(
      { detail: "private error" },
      { status: 401 },
    )) as typeof fetch;
  await expect(
    checkOperations("https://api.example.test", key, undefined, denied),
  ).rejects.toThrow("HTTP 401");
  expect(() => apiClient("file:///tmp/test", key)).toThrow("HTTP or HTTPS");
  expect(() => apiClient("https://user:secret@example.test", key)).toThrow(
    "without credentials",
  );
  expect(() => apiClient("https://api.example.test", "short")).toThrow(
    "credential",
  );
  await expect(
    checkOperations(
      "https://api.example.test",
      key,
      { maxPendingSeconds: 0, maxFailedTickets: 0 },
      fetcher,
    ),
  ).rejects.toThrow("thresholds");
});
