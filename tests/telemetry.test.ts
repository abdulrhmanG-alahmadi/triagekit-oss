import { expect, spyOn, test } from "bun:test";
import { createTelemetry } from "../src/telemetry";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";
import { createLogger } from "../src/log";
import { processJob } from "../src/worker";
import type { Job, Store } from "../src/store";

const key = "private-telemetry-api-key".repeat(3);
const config = readConfig({
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  API_KEYS: key,
});

test("JSON logs include timestamp, service and level", () => {
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    const logger = createLogger("triagekit-worker");
    logger({ event: "worker_started" });
    logger({ event: "worker_slot_error", level: "error" });
    expect(output.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
      [
        {
          time: expect.any(String),
          service: "triagekit-worker",
          level: "info",
          event: "worker_started",
        },
        {
          time: expect.any(String),
          service: "triagekit-worker",
          level: "error",
          event: "worker_slot_error",
        },
      ],
    );
  } finally {
    output.mockRestore();
  }
});

test("opt-in API and worker OTLP spans flush at shutdown without private data", async () => {
  const payloads: any[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/v1/traces");
      payloads.push(await request.json());
      return Response.json({});
    },
  });
  const disabled = createTelemetry("triagekit-disabled");
  expect(disabled.tracer.startSpan("disabled").isRecording()).toBe(false);
  await disabled.shutdown();
  expect(payloads).toHaveLength(0);
  const endpoint = new URL("/v1/traces", collector.url).href;
  const api = createTelemetry("triagekit-api", endpoint);
  const worker = createTelemetry("triagekit-worker", endpoint);
  const events: Record<string, unknown>[] = [];
  const job: Job = {
    id: "private-ticket-id",
    subject: "PRIVATE SUBJECT",
    body: "PRIVATE CUSTOMER BODY",
    attempts: 1,
    lastErrorCode: null,
    attemptToken: "private-attempt-token",
  };
  const store = {
    allowRequest: async () => true,
    get: async () => {
      throw new Error(`PRIVATE DB ERROR ${key}`);
    },
    complete: async () => true,
    fail: async () => true,
  } as unknown as Store;
  try {
    const app = createApp(
      config,
      store,
      (entry) => events.push(entry),
      api.tracer,
    );
    const response = await app.handle(
      new Request(
        `http://localhost/api/v1/tickets/${job.id}?private-query=secret`,
        {
          headers: {
            authorization: `Bearer ${key}`,
            cookie: "session=private-cookie",
          },
        },
      ),
    );
    expect(response.status).toBe(500);
    const unauthorized = await app.handle(
      new Request("http://localhost/api/v1/tickets", {
        method: "POST",
        body: job.body,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(unauthorized.status).toBe(401);
    await processJob(
      store,
      job,
      async () => ({
        text: JSON.stringify({
          category: "billing",
          priority: "low",
          summary: "PRIVATE MODEL SUMMARY",
        }),
        model: "private-model-id",
      }),
      config,
      (entry) => events.push(entry),
      worker.tracer,
    );
    await processJob(
      store,
      job,
      async () => {
        throw new Error(`PRIVATE PROVIDER ERROR ${job.body}`);
      },
      config,
      (entry) => events.push(entry),
      worker.tracer,
    );
    await api.shutdown();
    await worker.shutdown();
    const resources = payloads.flatMap((payload) => payload.resourceSpans);
    expect(
      resources
        .map(
          (resource) =>
            resource.resource.attributes.find(
              (attribute: any) => attribute.key === "service.name",
            ).value.stringValue,
        )
        .sort(),
    ).toEqual(["triagekit-api", "triagekit-worker"]);
    const spans = resources.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope: any) => scope.spans),
    );
    expect(spans.map((span) => span.name).sort()).toEqual(
      [
        "GET /api/v1/tickets/:id",
        "POST unmatched",
        "classification.inference",
        "classification.inference",
        "classification.persist_failure",
        "classification.persist_result",
        "classification.process",
        "classification.process",
      ].sort(),
    );
    const roots = spans.filter(
      (span) => span.name === "classification.process",
    );
    for (const child of spans.filter(
      (span) =>
        span.name.startsWith("classification.") &&
        span.name !== "classification.process",
    )) {
      expect(roots).toContainEqual(
        expect.objectContaining({
          spanId: child.parentSpanId,
          traceId: child.traceId,
        }),
      );
    }
    expect(roots.map((span) => span.traceId)[0]).not.toBe(
      roots.map((span) => span.traceId)[1],
    );
    expect(roots.some((span) => span.status?.code === 2)).toBe(true);
    const serialized = JSON.stringify({ payloads, events });
    for (const value of [
      key,
      job.id,
      job.subject,
      job.body,
      job.attemptToken,
      "private-query",
      "private-cookie",
      "PRIVATE MODEL SUMMARY",
      "private-model-id",
      "PRIVATE DB ERROR",
      "PRIVATE PROVIDER ERROR",
    ])
      expect(serialized).not.toContain(value);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "classification_attempt_failed",
        level: "error",
        code: "unexpected_error",
      }),
    );
  } finally {
    await Promise.allSettled([api.shutdown(), worker.shutdown()]);
    await collector.stop(true);
  }
});

test("native shutdown exports an in-flight early error before closing telemetry", async () => {
  const payloads: any[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(await request.json());
      return Response.json({});
    },
  });
  const telemetry = createTelemetry(
    "triagekit-api",
    new URL("/v1/traces", collector.url).href,
  );
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<boolean>();
  const app = createApp(
    config,
    {
      allowRequest: async () => {
        entered.resolve();
        return released.promise;
      },
    } as unknown as Store,
    () => {},
    telemetry.tracer,
  ).listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const pending = fetch(new URL("/api/v1/tickets", app.server!.url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: "{",
      signal: AbortSignal.timeout(2_000),
    });
    await entered.promise;
    const stopped = app.stop();
    released.resolve(false);
    await stopped;
    await telemetry.shutdown();
    const response = await pending;
    expect(response.status).toBe(429);
    await response.body?.cancel();
    const spans = payloads.flatMap((payload) =>
      payload.resourceSpans.flatMap((resource: any) =>
        resource.scopeSpans.flatMap((scope: any) => scope.spans),
      ),
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toContainEqual({
      key: "http.response.status_code",
      value: { intValue: 429 },
    });
  } finally {
    released.resolve(false);
    if (app.server) await app.stop(true);
    await telemetry.shutdown();
    await collector.stop(true);
  }
});
