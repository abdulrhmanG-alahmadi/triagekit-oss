import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createApp, maxBodyBytes } from "../src/app";
import { readConfig } from "../src/config";
import { readJsonBody } from "../src/http";
import type { Store, Ticket } from "../src/store";

const key = `${"native-http-test-key-".repeat(3)}._~+/==`;
const config = readConfig({
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  API_KEYS: key,
});
const ticket: Ticket = {
  classificationRunId: crypto.randomUUID(),
  id: "private-ticket-id",
  subject: "PRIVATE SUBJECT",
  body: "PRIVATE CUSTOMER BODY",
  status: "pending",
  attempts: 0,
  lastErrorCode: null,
  classification: null,
  failure: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const logs: Record<string, unknown>[] = [];
const store = {
  allowRequest: async () => true,
  get: async () => ticket,
  ingest: async (input: Pick<Ticket, "id" | "subject" | "body">) => ({
    created: true,
    ticket: { ...ticket, ...input },
  }),
  requestRun: async (
    ticketId: string,
    id: string,
    previousRunId: string,
    requestedBy: string,
  ) => ({
    created: true,
    run: {
      id,
      ticketId,
      previousRunId,
      requestedBy,
      requestedAt: ticket.createdAt,
      status: "pending",
      attempts: 0,
      classification: null,
      failure: null,
    },
  }),
} as unknown as Store;
const app = createApp(config, store, (entry) => logs.push(entry)).listen({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: maxBodyBytes,
});
const baseUrl = app.server!.url;
afterAll(async () => {
  await app.stop(true);
});

test("native transport rejects bodies over 128 KiB before application parsing", async () => {
  const response = await fetch(new URL("/api/v1/tickets", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: "x".repeat(maxBodyBytes + 1),
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.status).toBe(413);
  expect(response.headers.get("x-request-id")).toBeNull();
  await response.body?.cancel();
});

test.each(["POST", "PUT"])(
  "empty %s JSON bodies are invalid JSON, not unsupported media types",
  async (method) => {
    const path =
      method === "POST"
        ? "/api/v1/tickets"
        : `/api/v1/tickets/json-ticket/classification-runs/${crypto.randomUUID()}`;
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: "",
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_json" });
  },
);

test("native authentication still precedes body parsing", async () => {
  for (const credential of ["invalid", key]) {
    const response = await fetch(new URL("/api/v1/tickets", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "text/plain",
      },
      body: "{",
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(credential === key ? 415 : 401);
    await response.body?.cancel();
  }
});

test.each([
  "application/json",
  "Application/JSON",
  "application/json ; charset=utf-8",
])(
  "JSON requests accept media type %s and preserve Unicode",
  async (contentType) => {
    const input = {
      id: "json-ticket",
      subject: "مرحبًا",
      body: "An invoice question 🧾",
    };
    const previousRunId = crypto.randomUUID();
    for (const [method, path, body] of [
      ["POST", "/api/v1/tickets", input],
      [
        "PUT",
        `/api/v1/tickets/json-ticket/classification-runs/${crypto.randomUUID()}`,
        { previousRunId },
      ],
    ] as const) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": contentType,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject(body);
    }
  },
);

test("malformed UTF-8 is rejected instead of changing ticket content", async () => {
  const response = await fetch(new URL("/api/v1/tickets", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: Buffer.concat([
      Buffer.from('{"id":"invalid-utf8","subject":"","body":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "invalid_json" });
});

test("JSON body deadline cancels a continuously dripping stream", async () => {
  let chunks = 0;
  let cancelled = false;
  let drip: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("{"));
      drip = setInterval(() => {
        chunks++;
        if (chunks === 50) {
          clearInterval(drip);
          controller.enqueue(Buffer.from("}"));
          controller.close();
        } else controller.enqueue(Buffer.from(" "));
      }, 10);
    },
    cancel() {
      cancelled = true;
      clearInterval(drip);
    },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  try {
    await expect(readJsonBody(request, 60)).rejects.toMatchObject({
      status: 408,
      code: "request_timeout",
    });
    expect(chunks).toBeGreaterThan(1);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  } finally {
    clearInterval(drip!);
  }
});

test("JSON streaming decoder preserves Unicode split across chunks", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of Buffer.from('{"text":"مرحبًا 🧾"}'))
        controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  expect(
    await readJsonBody(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    ),
  ).toEqual({ text: "مرحبًا 🧾" });
});

test.each([false, true])(
  "JSON body reading cancels on client abort (already aborted: %s)",
  async (alreadyAborted) => {
    const abort = new AbortController();
    let cancelled = false;
    let close: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("{}"));
        close = setTimeout(() => controller.close(), 200);
      },
      cancel() {
        cancelled = true;
        clearTimeout(close);
      },
    });
    if (alreadyAborted) abort.abort();
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: abort.signal,
    });
    const disconnect = setTimeout(() => abort.abort(), 20);
    try {
      await expect(readJsonBody(request)).rejects.toMatchObject({
        code: "invalid_json",
      });
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      clearTimeout(close!);
      clearTimeout(disconnect);
    }
  },
);

test("OpenAPI describes JSON requests, problem responses and transport-only 413s", async () => {
  const spec = await (await fetch(new URL("/openapi/json", baseUrl))).json();
  for (const operation of [
    spec.paths["/api/v1/tickets"].post,
    spec.paths["/api/v1/tickets/{id}/classification-runs/{runId}"].put,
  ]) {
    expect(Object.keys(operation.requestBody.content)).toEqual([
      "application/json",
    ]);
    expect(
      operation.responses["201"].content["application/json"],
    ).toBeDefined();
    expect(operation.responses["413"].content).toBeUndefined();
    for (const status of [400, 401, 408, 409, 415, 422, 429, 500, 503])
      expect(Object.keys(operation.responses[status].content)).toEqual([
        "application/problem+json",
      ]);
  }
  expect(
    spec.paths["/health/ready"].get.responses["503"].content[
      "application/problem+json"
    ],
  ).toBeDefined();
});

test("native authenticated responses carry request IDs and logs contain route templates without ticket data", async () => {
  const response = await fetch(
    new URL(`/api/v1/tickets/${ticket.id}`, baseUrl),
    {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2_000),
    },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(await response.json()).toEqual(ticket);
  // Elysia schedules afterResponse independently of the client receiving the body.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "http_request",
      requestId: response.headers.get("x-request-id"),
      route: "/api/v1/tickets/:id",
      status: 200,
    }),
  );
  const serialized = JSON.stringify(logs);
  for (const privateValue of [key, ticket.id, ticket.subject, ticket.body])
    expect(serialized).not.toContain(privateValue);
});

test("concurrent requests keep error IDs and authenticated principals isolated", async () => {
  const otherKey = "other-native-http-key-".repeat(3);
  const events: Record<string, unknown>[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const concurrent = createApp(
    { ...config, apiKeys: [key, otherKey] },
    {
      ...store,
      allowRequest: async () => {
        await gate;
        return true;
      },
    } as unknown as Store,
    (entry) => events.push(entry),
  );
  const cases = [
    [401, "POST", "/api/v1/tickets", undefined, "{"],
    [404, "GET", "/unmatched", key, undefined],
    [400, "POST", "/api/v1/tickets", key, "{"],
    [422, "POST", "/api/v1/tickets", key, "{}"],
    ...[key, otherKey].map(
      (credential) =>
        [
          201,
          "PUT",
          `/api/v1/tickets/isolated/classification-runs/${crypto.randomUUID()}`,
          credential,
          JSON.stringify({ previousRunId: crypto.randomUUID() }),
        ] as const,
    ),
  ] as const;
  const pending = cases.map(
    async ([status, method, path, credential, body]) => ({
      status,
      credential,
      response: await concurrent.handle(
        new Request(`http://localhost${path}`, {
          method,
          body,
          headers: {
            "content-type": "application/json",
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
        }),
      ),
    }),
  );
  release();
  const responses = await Promise.all(pending);
  // Elysia schedules afterResponse for early errors on the next event-loop turn.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ids = new Set<string>();
  for (const { status, credential, response } of responses) {
    const id = response.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    if (id) ids.add(id);
    expect(response.status).toBe(status);
    const data = await response.json();
    if (status === 201 && credential)
      expect(data.requestedBy).toBe(
        createHash("sha256").update(credential).digest("hex"),
      );
    else expect(data.requestId).toBe(id);
    const entries = events.filter(
      (entry) => entry.event === "http_request" && entry.requestId === id,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status });
  }
  expect(ids.size).toBe(cases.length);
  for (const failure of [false, new Error("database unavailable")]) {
    const blocked = createApp(
      config,
      {
        ...store,
        allowRequest: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
      } as unknown as Store,
      (entry) => events.push(entry),
    );
    const response = await blocked.handle(
      new Request("http://localhost/api/v1/tickets", {
        method: "POST",
        body: "{",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
      }),
    );
    expect(response.status).toBe(failure === false ? 429 : 503);
    expect((await response.json()).requestId).toBe(
      response.headers.get("x-request-id"),
    );
  }
});

test("server response validation errors return a safe 500 instead of blaming the request", async () => {
  const invalidStore = {
    allowRequest: async () => true,
    list: async () => ({
      items: "PRIVATE BAD SERVER RESPONSE",
      nextCursor: null,
    }),
  } as unknown as Store;
  const invalidApp = createApp(config, invalidStore, () => {});
  const response = await invalidApp.handle(
    new Request("http://localhost/api/v1/tickets", {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  const problem = await response.json();
  expect(problem.code).toBe("internal_error");
  expect(problem.requestId).toBe(response.headers.get("x-request-id"));
  expect(JSON.stringify(problem)).not.toContain("PRIVATE BAD SERVER RESPONSE");
  const invalidQuery = await invalidApp.handle(
    new Request("http://localhost/api/v1/tickets?limit=101", {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
  expect(invalidQuery.status).toBe(422);
});

test("documentation is public outside production and authenticated inside it", async () => {
  for (const path of ["/openapi", "/openapi/json"]) {
    const open = await app.handle(new Request(`http://localhost${path}`));
    expect(open.status).toBe(200);
    const locked = await createApp(
      { ...config, production: true },
      store,
      () => {},
    ).handle(new Request(`http://localhost${path}`));
    expect(locked.status).toBe(401);
  }
});

test("Server Timing is enabled only outside production", async () => {
  const development = await app.handle(
    new Request("http://localhost/health/live"),
  );
  expect(development.headers.get("server-timing")).toContain("total;dur=");
  const production = await createApp(
    { ...config, production: true },
    store,
    () => {},
  ).handle(new Request("http://localhost/health/live"));
  expect(production.status).toBe(200);
  expect(production.headers.get("server-timing")).toBeNull();
});
