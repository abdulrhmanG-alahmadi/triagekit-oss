import { afterEach, expect, test } from "bun:test";
import TicketApi from "../eval/ticket-api.mjs";

const context = {
  vars: { subject: "Invoices", body: "Where do I download invoices?" },
};
const classification = {
  category: "billing",
  priority: "low",
  summary: "The customer asks for the invoice.",
};
const live = {
  model: "vendor/exact-model",
  promptVersion: "ticket-v1",
  classifiedAt: "2026-09-08T00:00:00.000Z",
};
const original = { fetch: globalThis.fetch, env: { ...process.env } };
let posts = 0;
let requestUrls: string[] = [];

function stubApi(patch: Record<string, unknown> = {}) {
  posts = 0;
  requestUrls = [];
  let submitted: unknown;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requestUrls.push(String(url));
    if (init?.method === "POST") {
      posts++;
      submitted = JSON.parse(String(init.body));
      return new Response("", { status: 201 });
    }
    return Response.json({
      ...(submitted as object),
      status: "classified",
      attempts: 2,
      lastErrorCode: null,
      classification: { ...classification, ...live, ...patch },
    });
  }) as typeof fetch;
  process.env.API_BASE_URL = "http://127.0.0.1:1/";
  process.env.API_KEY = "evaluation-test-key-".repeat(3);
  process.env.EVAL_EXPECT_PROVIDER = "openrouter";
  process.env.OPENROUTER_MODEL = live.model;
  return new TicketApi();
}

afterEach(() => {
  globalThis.fetch = original.fetch;
  process.env = { ...original.env };
});

test("evaluation refuses to run without an explicit live model", async () => {
  const provider = stubApi();
  delete process.env.OPENROUTER_MODEL;
  expect((await provider.callApi("", context)).error).toBeDefined();
  expect(posts).toBe(0);
});

test("evaluation accepts only the exact expected model and valid provenance", async () => {
  expect(await stubApi().callApi("", context)).toMatchObject({
    output: classification,
    metadata: { model: live.model, promptVersion: live.promptVersion },
  });
  for (const patch of [
    { model: "vendor/another-model" },
    { model: "fake-v1" },
    { promptVersion: " " },
    { classifiedAt: "not a date" },
  ]) {
    const result = await stubApi(patch).callApi("", context);
    expect(result.error).toBeDefined();
    expect(result.output).toBeUndefined();
  }
});

test("evaluation retains the attempted ticket ID when polling or transport fails", async () => {
  const provider = stubApi();
  let ticketId: string | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    ticketId = JSON.parse(init.body as string).id;
    throw new TypeError("simulated network interruption");
  }) as unknown as typeof fetch;
  const result = await provider.callApi("", context);
  expect(ticketId).toMatch(/^eval-[a-f0-9-]{36}$/);
  expect(result).toMatchObject({
    error: "Evaluation API request failed",
    metadata: { ticketId },
  });
});

test("evaluation requests preserve the API base URL prefix", async () => {
  for (const prefix of ["", "/", "/proxy", "/proxy/", "/proxy///"]) {
    const provider = stubApi();
    process.env.API_BASE_URL = `https://tickets.example${prefix}`;
    const result = await provider.callApi("", context);
    expect(result.output).toEqual(classification);
    const path = prefix.startsWith("/proxy") ? "/proxy" : "";
    expect(requestUrls).toEqual([
      `https://tickets.example${path}/api/v1/tickets`,
      `https://tickets.example${path}/api/v1/tickets/${result.metadata?.ticketId}`,
    ]);
  }
});

test("evaluation rejects API base URLs with unsafe or ambiguous components", async () => {
  for (const url of [
    "https://tickets.example/proxy?token=secret",
    "https://tickets.example/proxy#fragment",
    "https://tickets.example/proxy?",
    "https://tickets.example/proxy#",
    "https://user:password@tickets.example/proxy",
    "ftp://tickets.example/proxy",
    "not a URL",
  ]) {
    const provider = stubApi();
    process.env.API_BASE_URL = url;
    expect((await provider.callApi("", context)).error).toBeDefined();
    expect(requestUrls).toEqual([]);
  }
});
