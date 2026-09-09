import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";
import { Store } from "../src/store";
import {
  connectTestDatabase,
  prepareDatabase,
  resetTables,
  testDatabaseUrl,
} from "./helpers";

const sql = connectTestDatabase(4);
const store = new Store(sql);
const key = "integration-test-key-".repeat(3);
const config = readConfig({ DATABASE_URL: testDatabaseUrl(), API_KEYS: key });
const app = createApp(config, store, () => {});
const ticket = { id: "t-1001", subject: "", body: "Please send the invoice." };
function request(
  path: string,
  options: RequestInit = {},
  authenticated = true,
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...options,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${key}` } : {}),
        ...options.headers,
      },
    }),
  );
}
const post = (body: unknown) =>
  request("/api/v1/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function classify(
  id: string,
  category: "billing" | "technical",
  priority: "low" | "medium",
) {
  await store.ingest({ ...ticket, id });
  const job = (await store.claim(3, 60_000))!;
  await store.complete(
    job,
    { category, priority, summary: "The customer needs help." },
    "fake",
    "v1",
  );
}
beforeAll(() => prepareDatabase(sql));
beforeEach(() => resetTables(sql));
afterAll(() => sql.close());

test("credentials guard the API while health and documentation stay public", async () => {
  expect((await request("/api/v1/tickets", {}, false)).status).toBe(401);
  expect((await request("/health/ready", {}, false)).status).toBe(200);
  expect((await request("/openapi/json", {}, false)).status).toBe(200);
  const production = createApp(
    { ...config, production: true },
    store,
    () => {},
  );
  expect(
    (await production.handle(new Request("http://localhost/openapi/json")))
      .status,
  ).toBe(401);
});

test("ingestion is durable, idempotent and conflicts on changed content", async () => {
  const created = await post(ticket);
  expect(created.status).toBe(201);
  expect(created.headers.get("location")).toBe("/api/v1/tickets/t-1001");
  expect(await created.json()).toMatchObject({
    status: "pending",
    attempts: 0,
    lastErrorCode: null,
  });
  expect((await post(ticket)).status).toBe(200);
  expect((await post({ ...ticket, body: "Different" })).status).toBe(409);
});

test("tickets can be read and missing ones return a problem document", async () => {
  await post(ticket);
  const found = await request("/api/v1/tickets/t-1001");
  expect((await found.json()).classification).toBeNull();
  const missing = await request("/api/v1/tickets/missing");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  const problem = await missing.json();
  expect(problem.code).toBe("ticket_not_found");
  expect(problem.requestId).toBe(missing.headers.get("x-request-id"));
});

test("listing filters by classification, status and prompt version", async () => {
  await classify("t-billing", "billing", "medium");
  await classify("t-technical", "technical", "low");
  await post(ticket);
  const ids = async (query: string) =>
    (await (await request(`/api/v1/tickets${query}`)).json()).items.map(
      (item: { id: string }) => item.id,
    );
  expect(await ids("")).toEqual(["t-1001", "t-technical", "t-billing"]);
  expect(await ids("?category=billing&priority=medium")).toEqual(["t-billing"]);
  expect(await ids("?category=billing&priority=low")).toEqual([]);
  expect(await ids("?status=pending")).toEqual(["t-1001"]);
  expect(await ids("?promptVersion=v1")).toEqual(["t-technical", "t-billing"]);
  const job = (await store.claim(1, 60_000))!;
  await store.fail(job, "model_http_400", false, 1, 0);
  expect(await ids("?status=failed")).toEqual(["t-1001"]);
  expect((await request("/api/v1/tickets?status=bogus")).status).toBe(422);
});

test("listing pages with cursors bound to their filters", async () => {
  for (const id of ["t-1", "t-2", "t-3"]) await classify(id, "billing", "low");
  const first = await (await request("/api/v1/tickets?limit=2")).json();
  expect(first.items.map((item: { id: string }) => item.id)).toEqual([
    "t-3",
    "t-2",
  ]);
  const next = await (
    await request(`/api/v1/tickets?limit=2&cursor=${first.nextCursor}`)
  ).json();
  expect(next.items.map((item: { id: string }) => item.id)).toEqual(["t-1"]);
  expect(next.nextCursor).toBeNull();
  expect(
    (
      await request(
        `/api/v1/tickets?limit=2&category=billing&cursor=${first.nextCursor}`,
      )
    ).status,
  ).toBe(400);
});

test("prompt-version filters reject NUL without leaking database errors", async () => {
  await classify("t-billing", "billing", "medium");
  const valid = await request("/api/v1/tickets?promptVersion=v1");
  expect(valid.status).toBe(200);
  expect(
    (await valid.json()).items.map((item: { id: string }) => item.id),
  ).toEqual(["t-billing"]);

  const response = await request("/api/v1/tickets?promptVersion=v5%00suffix");
  expect(response.status).toBe(422);
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  const problem = await response.json();
  expect(problem).toMatchObject({
    status: 422,
    code: "validation_error",
    detail: "The request does not match the documented schema.",
    instance: "/api/v1/tickets",
    requestId: response.headers.get("x-request-id"),
  });
  expect(JSON.stringify(problem)).not.toMatch(/suffix|Postgres|SQL|0x00/);

  for (const promptVersion of ["", "إصدار-🚀", "x".repeat(128)]) {
    const listed = await request(
      `/api/v1/tickets?promptVersion=${encodeURIComponent(promptVersion)}`,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [], nextCursor: null });
  }
  expect(
    (await request(`/api/v1/tickets?promptVersion=${"x".repeat(129)}`)).status,
  ).toBe(422);
});

test("the OpenAPI document advertises only reachable responses", async () => {
  const spec = await (await request("/openapi/json")).json();
  const ingest = spec.paths["/api/v1/tickets"].post.responses;
  expect(ingest["201"]).toBeDefined();
  expect(ingest["422"]).toBeDefined();
  expect(ingest["405"]).toBeUndefined();
  expect(ingest["408"]).toBeDefined();
  expect(
    spec.paths["/api/v1/tickets/{id}/classification-runs/{runId}"].put
      .responses["409"],
  ).toBeDefined();
  expect(spec.components.securitySchemes.bearerAuth.type).toBe("http");
});

test("invalid inputs and unknown fields are rejected without reflecting ticket content", async () => {
  for (const body of [
    { ...ticket, extra: true },
    { ...ticket, body: " " },
    { ...ticket, id: "../bad" },
    { ...ticket, subject: "x".repeat(501) },
    { ...ticket, body: "x".repeat(20_001) },
  ]) {
    const response = await post(body);
    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(await response.text()).not.toContain(ticket.body);
  }
  expect((await request("/api/v1/tickets?limit=101")).status).toBe(422);
  expect((await request("/api/v1/tickets?category=unknown")).status).toBe(422);
  expect((await request("/api/v1/tickets?cursor=bad")).status).toBe(400);
  // Elysia only parses declared media types; Bun rejects oversized bodies at the transport.
  expect(
    (await request("/api/v1/tickets", { method: "POST", body: "{}" })).status,
  ).toBe(415);
  expect(
    (
      await request("/api/v1/tickets", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(ticket),
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await request("/api/v1/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
  ).toBe(400);
});

test("unknown paths and methods return 404", async () => {
  expect((await request("/api/v1/tickets", { method: "DELETE" })).status).toBe(
    404,
  );
  expect(
    (await request("/api/v1/no-such-resource", { method: "PUT" })).status,
  ).toBe(404);
});

test("request limits are shared by API instances and return retry guidance", async () => {
  const limited = createApp(
    { ...config, rateLimitPerMinute: 1 },
    store,
    () => {},
  );
  const call = () =>
    limited.handle(
      new Request("http://localhost/api/v1/tickets", {
        headers: { Authorization: `Bearer ${key}` },
      }),
    );
  expect((await call()).status).toBe(200);
  const response = await call();
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
});

test("classification runs are conditional, idempotent and attributed", async () => {
  const original = await (await post(ticket)).json();
  const job = (await store.claim(1, 60_000))!;
  await store.fail(job, "invalid_model_output", false, 1, 0);
  const runId = crypto.randomUUID();
  const path = `/api/v1/tickets/${ticket.id}/classification-runs/${runId}`;
  const put = (body: unknown) =>
    request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await request(path, { method: "PUT" }, false)).status).toBe(401);
  expect((await request(path, { method: "PUT", body: "{}" })).status).toBe(415);
  expect((await put({ previousRunId: "invalid" })).status).toBe(422);
  expect(
    (await put({ previousRunId: original.classificationRunId, extra: true }))
      .status,
  ).toBe(422);
  const created = await put({ previousRunId: original.classificationRunId });
  expect(created.status).toBe(201);
  expect(created.headers.get("location")).toBe(path);
  const run = await created.json();
  expect(run).toMatchObject({
    id: runId,
    status: "pending",
    attempts: 0,
    previousRunId: original.classificationRunId,
  });
  expect(run.requestedBy).toMatch(/^[a-f0-9]{64}$/);
  expect((await request(path)).status).toBe(200);
  expect(
    (await put({ previousRunId: original.classificationRunId })).status,
  ).toBe(200);
  const conflict = await put({ previousRunId: crypto.randomUUID() });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).code).toBe("run_conflict");
});

test("classification history pages newest first and rejects unknown resources", async () => {
  const original = await (await post(ticket)).json();
  const job = (await store.claim(1, 60_000))!;
  await store.fail(job, "invalid_model_output", false, 1, 0);
  const runId = crypto.randomUUID();
  await request(`/api/v1/tickets/${ticket.id}/classification-runs/${runId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previousRunId: original.classificationRunId }),
  });
  const history = `/api/v1/tickets/${ticket.id}/classification-runs`;
  const page = await (await request(`${history}?limit=1`)).json();
  expect(page.items.map((item: { id: string }) => item.id)).toEqual([runId]);
  const next = await (
    await request(`${history}?limit=1&cursor=${page.nextCursor}`)
  ).json();
  expect(next.items[0].failure.code).toBe("invalid_model_output");
  expect(next.nextCursor).toBeNull();
  expect((await request(`${history}?limit=101`)).status).toBe(422);
  expect((await request(`${history}/invalid`)).status).toBe(422);
  expect((await request(`${history}/${crypto.randomUUID()}`)).status).toBe(404);
  expect(
    (await request("/api/v1/tickets/missing/classification-runs")).status,
  ).toBe(404);
});
