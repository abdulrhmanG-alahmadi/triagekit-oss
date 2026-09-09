import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { connectDatabase } from "../src/database";
import { readConfig } from "../src/config";
import { createApp } from "../src/app";
import { createClassifier, ModelError, type Classify } from "../src/classifier";
import { Store } from "../src/store";
import { processJob, runWorker } from "../src/worker";
import { seed } from "../scripts/seed";
import samples from "../samples/tickets.json";
import {
  connectTestDatabase,
  prepareDatabase,
  resetTables,
  testDatabaseUrl,
} from "./helpers";

const url = testDatabaseUrl();
const sql = connectTestDatabase();
const store = new Store(sql);
const config = readConfig({
  DATABASE_URL: url,
  API_KEYS: "test-key-".repeat(8),
  RETRY_BASE_MS: "0",
  POLL_INTERVAL_MS: "10",
});
const quiet = () => {};
const valid = JSON.stringify({
  category: "billing",
  priority: "low",
  summary: "The customer needs an invoice.",
});
function spawnWorker(providerUrl: string, env: Record<string, string> = {}) {
  return Bun.spawn(
    [
      process.execPath,
      "--preload",
      `${import.meta.dir}/fixtures/local-provider.ts`,
      `${import.meta.dir}/../src/worker.ts`,
    ],
    {
      env: {
        DATABASE_URL: url,
        LLM_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "local-test-key",
        OPENROUTER_MODEL: "test/model",
        TEST_PROVIDER_URL: providerUrl,
        POLL_INTERVAL_MS: "10",
        RETRY_BASE_MS: "0",
        WORKER_CONCURRENCY: "1",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}
beforeAll(async () => {
  await prepareDatabase(sql);
});
beforeEach(async () => {
  await resetTables(sql);
});
afterAll(async () => {
  await sql.close();
});

test("malformed model output is never stored and bounded retries end in failure", async () => {
  await store.ingest(samples[0]!);
  const classifier: Classify = async () => ({
    text: '{"category":"injected"}',
    model: "test",
  });
  for (let i = 0; i < config.maxAttempts; i++) {
    const job = (await store.claim(config.maxAttempts, config.leaseMs))!;
    await processJob(store, job, classifier, config, quiet);
  }
  const ticket = (await store.get(samples[0]!.id))!;
  expect(ticket.status).toBe("failed");
  expect(ticket.classification).toBeNull();
  expect(ticket.failure?.code).toBe("invalid_model_output");
});

test("format-only model summaries fail validation instead of being published", async () => {
  for (const [index, summary] of [
    "\u200b",
    "\u200d\u200c\u2060",
    "\u00ad",
  ].entries()) {
    await store.ingest({ ...samples[0]!, id: `invisible-${index}` });
    const job = (await store.claim(1, config.leaseMs))!;
    await processJob(
      store,
      job,
      async () => ({
        text: JSON.stringify({ category: "other", priority: "low", summary }),
        model: "test",
      }),
      { ...config, maxAttempts: 1 },
      quiet,
    );
    const ticket = (await store.get(job.id))!;
    expect(ticket.status).toBe("failed");
    expect(ticket.classification).toBeNull();
    expect(ticket.failure?.code).toBe("invalid_model_output");
  }
});

test("worker deadlines persist timeout failure codes", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        }),
      ),
  });
  try {
    await store.ingest(samples[0]!);
    const job = (await store.claim(1, config.leaseMs))!;
    await processJob(
      store,
      job,
      createClassifier({
        mode: "openrouter",
        apiKey: "local-test-key",
        model: "test/model",
        timeoutMs: 100,
        endpoint: server.url.href,
      }),
      { ...config, modelTimeoutMs: 100, maxAttempts: 1 },
      quiet,
    );
    const ticket = (await store.get(job.id))!;
    expect(ticket.status).toBe("failed");
    expect(ticket.classification).toBeNull();
    expect(ticket.failure?.code).toBe("model_timeout");
  } finally {
    await server.stop(true);
  }
});

test("persisted retry reasons control repair prompts through the real worker pipeline", async () => {
  const sent: { id: string; messages: { role: string; content: string }[] }[] =
    [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { messages } = await request.json();
      const { subject: id } = JSON.parse(messages[1].content);
      sent.push({ id, messages });
      if (sent.filter((entry) => entry.id === id).length === 1) {
        if (id === "model_http_429") return new Response("", { status: 429 });
        if (id === "model_timeout")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              },
            }),
          );
        return Response.json({
          model: "test/model",
          choices: [
            { finish_reason: "stop", message: { content: "invalid-json" } },
          ],
        });
      }
      return Response.json({
        model: "test/model",
        choices: [{ finish_reason: "stop", message: { content: valid } }],
      });
    },
  });
  const classify = createClassifier({
    mode: "openrouter",
    apiKey: "local-test-key",
    model: "test/model",
    timeoutMs: 100,
    endpoint: provider.url.href,
  });
  try {
    for (const reason of [
      "invalid_model_output",
      "model_http_429",
      "model_timeout",
    ]) {
      await store.ingest({ ...samples[0]!, id: reason, subject: reason });
      const first = (await store.claim(3, config.leaseMs))!;
      expect(first.lastErrorCode).toBeNull();
      await processJob(store, first, classify, config, quiet);
      expect((await store.get(reason))?.lastErrorCode).toBe(reason);
      const retry = (await store.claim(3, config.leaseMs))!;
      expect(retry.lastErrorCode).toBe(reason);
      await processJob(store, retry, classify, config, quiet);
      const requests = sent.filter((entry) => entry.id === reason);
      expect(requests[0]!.messages).toHaveLength(3);
      expect(requests[1]!.messages).toHaveLength(
        reason === "invalid_model_output" ? 4 : 3,
      );
      expect(requests[1]!.messages[1]).toEqual(requests[0]!.messages[1]);
      expect(await store.get(reason)).toMatchObject({
        status: "classified",
        attempts: 2,
        lastErrorCode: null,
        classification: { promptVersion: "ticket-classification-v6" },
      });
    }
  } finally {
    await provider.stop(true);
  }
});

test("a new prompt run clears repair context and preserves its archived prompt version", async () => {
  const { ticket } = await store.ingest(samples[0]!);
  const original = (await store.claim(3, config.leaseMs))!;
  await store.complete(
    original,
    JSON.parse(valid),
    "test/old",
    "ticket-classification-v4",
  );
  await store.requestRun(
    ticket.id,
    crypto.randomUUID(),
    ticket.classificationRunId,
    "a".repeat(64),
  );
  const fresh = (await store.claim(3, config.leaseMs))!;
  expect(fresh).toMatchObject({ attempts: 1, lastErrorCode: null });
  await processJob(
    store,
    fresh,
    createClassifier({ mode: "fake", timeoutMs: 100 }),
    config,
    quiet,
  );
  expect((await store.get(ticket.id))?.classification?.promptVersion).toBe(
    "ticket-classification-v6",
  );
  expect(
    (await store.getRun(ticket.id, ticket.classificationRunId))?.classification
      ?.promptVersion,
  ).toBe("ticket-classification-v4");
});

test("defects in the worker fail the ticket and are logged without ticket content", async () => {
  await store.ingest(samples[0]!);
  const job = (await store.claim(1, config.leaseMs))!;
  const entries: Record<string, unknown>[] = [];
  await processJob(
    store,
    job,
    async () => {
      throw new TypeError(`classification failed for ${samples[0]!.body}`);
    },
    { ...config, maxAttempts: 1 },
    (entry) => entries.push(entry),
  );
  const ticket = (await store.get(job.id))!;
  expect(ticket.status).toBe("failed");
  expect(ticket.classification).toBeNull();
  expect(ticket.failure?.code).toBe("unexpected_error");
  expect(entries[0]).toMatchObject({
    event: "classification_attempt_failed",
    code: "unexpected_error",
    level: "error",
  });
  expect(entries[0]).not.toHaveProperty("error");
  expect(JSON.stringify(entries)).not.toContain(samples[0]!.body);
});

test("an unrelated error with the validation message is recorded as a worker defect", async () => {
  await store.ingest(samples[0]!);
  const job = (await store.claim(1, config.leaseMs))!;
  const events: Record<string, unknown>[] = [];
  await processJob(
    store,
    job,
    async () => {
      throw new Error("invalid_model_output");
    },
    { ...config, maxAttempts: 1 },
    (entry) => events.push(entry),
  );
  expect((await store.get(job.id))?.failure?.code).toBe("unexpected_error");
  expect(events[0]).toMatchObject({ code: "unexpected_error", level: "error" });
});

test("permanent provider errors fail without burning all retries", async () => {
  await store.ingest(samples[0]!);
  const job = (await store.claim(3, 60_000))!;
  await processJob(
    store,
    job,
    async () => {
      throw new ModelError("model_http_401", false);
    },
    config,
    quiet,
  );
  expect((await store.get(job.id))?.status).toBe("failed");
  expect(await store.claim(3, 60_000)).toBeNull();
});

test("graceful shutdown drains in-flight calls and respects concurrency", async () => {
  for (const sample of samples.slice(0, 5)) await store.ingest(sample);
  const stop = new AbortController();
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let active = 0,
    maximum = 0,
    calls = 0;
  const classifier: Classify = async () => {
    active++;
    calls++;
    maximum = Math.max(maximum, active);
    if (active === 2) started.resolve();
    await gate.promise;
    active--;
    return { text: valid, model: "test" };
  };
  const running = runWorker(
    store,
    classifier,
    { ...config, concurrency: 2 },
    stop.signal,
    quiet,
  );
  await started.promise;
  stop.abort();
  gate.resolve();
  await running;
  expect(maximum).toBe(2);
  expect(calls).toBe(2);
  expect((await store.operations()).classified).toBe(2);
  expect((await store.operations()).pending).toBe(3);
});

test("completion survives a temporary database lock without repeating inference", async () => {
  await store.ingest(samples[0]!);
  const job = (await store.claim(config.maxAttempts, config.leaseMs))!;
  const workerSql = connectDatabase(url);
  const workerStore = new Store(workerSql);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const transaction = sql.begin(async (tx) => {
    await tx`SELECT id FROM tickets WHERE id = ${job.id} FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let calls = 0;
  let writes = 0;
  const complete = workerStore.complete.bind(workerStore);
  workerStore.complete = async (...args) => {
    writes++;
    try {
      return await complete(...args);
    } catch (error) {
      release.resolve();
      throw error;
    }
  };
  try {
    await processJob(
      workerStore,
      job,
      async () => {
        calls++;
        return { text: valid, model: "test" };
      },
      config,
      quiet,
    );
    expect((await store.get(job.id))?.status).toBe("classified");
    expect(calls).toBe(1);
    expect(writes).toBe(2);
  } finally {
    release.resolve();
    await transaction;
    await workerSql.close();
  }
});

test("all synthetic sample tickets pass through HTTP ingestion and the asynchronous worker", async () => {
  const app = createApp(config, store, quiet);
  const result = await seed("http://localhost", config.apiKeys[0]!, ((
    url,
    options,
  ) => app.handle(new Request(String(url), options))) as typeof fetch);
  expect(result.created).toBe(10);
  const classify = createClassifier({ mode: "fake", timeoutMs: 1000 });
  for (let i = 0; i < 30; i++) {
    const job = await store.claim(3, 60_000);
    if (!job) break;
    await processJob(store, job, classify, config, quiet);
  }
  expect((await store.operations()).classified).toBe(10);
  const injected = (await store.get("t-1005"))!;
  expect(injected.classification?.category).toBe("billing");
  expect(injected.classification?.summary).not.toContain("OVERRIDE_ACCEPTED");
  expect(
    (
      await seed("http://localhost", config.apiKeys[0]!, ((url, options) =>
        app.handle(new Request(String(url), options))) as typeof fetch)
    ).existing,
  ).toBe(10);
  expect(await store.claim(3, 60_000)).toBeNull();
});

test("a worker process drains its leases and exits cleanly on SIGTERM", async () => {
  const seeded = samples.slice(0, 2);
  for (const sample of seeded) await store.ingest(sample);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      requests.push(JSON.parse(body.messages[1].content).subject);
      requested.resolve();
      await release.promise;
      return Response.json({
        model: "test/model",
        choices: [{ finish_reason: "stop", message: { content: valid } }],
      });
    },
  });
  const child = spawnWorker(provider.url.href);
  const stopping = Promise.withResolvers<void>();
  const stdout = (async () => {
    let output = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      if (output.includes('"event":"worker_stopping"')) stopping.resolve();
    }
  })();
  const stderr = new Response(child.stderr).text();
  const earlyExit = child.exited.then(async (code) => {
    throw new Error(`Worker exited before draining (${code}): ${await stderr}`);
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await Promise.race([requested.promise, earlyExit]);
    expect((await store.operations()).inFlight).toBe(1);
    child.kill("SIGTERM");
    await Promise.race([stopping.promise, earlyExit]);
    expect(
      await Promise.race([
        child.exited.then(() => "exited"),
        Bun.sleep(100).then(() => "waiting"),
      ]),
    ).toBe("waiting");
    expect((await store.get(seeded[0]!.id))?.status).toBe("pending");
    release.resolve();
    await child.exited;
    expect(child.exitCode).toBe(0);
    expect(requests).toEqual([seeded[0]!.subject]);
    expect(await store.get(seeded[0]!.id)).toMatchObject({
      status: "classified",
      attempts: 1,
      classification: {
        model: "test/model",
        summary: "The customer needs an invoice.",
      },
    });
    expect(await store.get(seeded[1]!.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    const [leases] =
      await sql`SELECT count(*)::integer AS held FROM tickets WHERE lease_until IS NOT NULL`;
    expect(leases.held).toBe(0);
  } finally {
    clearTimeout(deadline);
    release.resolve();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await stdout;
    await provider.stop(true);
  }
}, 30_000);

test("a worker process exits nonzero on invalid database credentials with safe SQLSTATE diagnostics", async () => {
  const databaseUrl = new URL(url);
  databaseUrl.password = "PRIVATE-WRONG-DATABASE-PASSWORD";
  const child = spawnWorker("http://127.0.0.1:1", {
    DATABASE_URL: databaseUrl.href,
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    await child.exited;
    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
    const output = await stdout;
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "worker_slot_error",
        code: "28P01",
        errorClass: "PostgresError",
        retryable: false,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "worker_failed", level: "error" }),
    );
    expect(output).not.toContain(databaseUrl.password);
    expect(await stderr).toBe("");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await stdout;
    await stderr;
  }
}, 5_000);

test("competing worker processes recover a SIGKILL lease and publish one outcome", async () => {
  // Distinct test subjects identify requests without sending storage IDs to the model.
  const ticket = { ...samples[0]!, subject: samples[0]!.id };
  await store.ingest(ticket);
  const release = Promise.withResolvers<void>();
  const requests: { id: string; worker: string; at: Date }[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json();
      const worker = new URL(request.url).pathname.slice(1);
      const [row] = await sql`SELECT clock_timestamp() AS at`;
      requests.push({
        id: JSON.parse(body.messages[1].content).subject,
        worker,
        at: row.at,
      });
      await release.promise;
      return Response.json({
        model: `test/${worker}`,
        choices: [{ finish_reason: "stop", message: { content: valid } }],
      });
    },
  });
  const children: ReturnType<typeof spawnWorker>[] = [];
  const outputs: Promise<string>[] = [];
  const start = (worker: string) => {
    const child = spawnWorker(new URL(worker, provider.url).href, {
      MODEL_TIMEOUT_MS: "3000",
      LEASE_MS: "13000",
    });
    children.push(child);
    outputs.push(new Response(child.stdout).text());
    outputs.push(new Response(child.stderr).text());
    return child;
  };
  const until = Date.now() + 23_000;
  const waitFor = async (condition: () => boolean | Promise<boolean>) => {
    while (!(await condition())) {
      if (Date.now() >= until) throw new Error("Worker recovery timed out");
      await Bun.sleep(10);
    }
  };
  const deadline = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
  }, 24_000);
  try {
    const crashed = start("crashed");
    await waitFor(() => requests.length === 1);
    const [lease] =
      await sql`SELECT lease_until, attempt_token FROM tickets WHERE id = ${ticket.id}`;
    expect(await store.get(ticket.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      classification: null,
    });
    crashed.kill("SIGKILL");
    await crashed.exited;
    expect(crashed.signalCode).toBe("SIGKILL");

    // Both replacement processes must claim distinct work while the crashed lease is live.
    for (const id of ["recovery-probe-one", "recovery-probe-two"])
      await store.ingest({ ...ticket, id, subject: id });
    const replacements = [start("one"), start("two")];
    await waitFor(() => requests.length >= 3);
    expect(
      requests
        .slice(1)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["recovery-probe-one", "recovery-probe-two"]);
    expect(new Set(requests.slice(1).map(({ worker }) => worker)).size).toBe(2);
    expect(await store.get(ticket.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      classification: null,
    });
    const [held] =
      await sql`SELECT attempt_token, lease_until > clock_timestamp() AS live FROM tickets WHERE id = ${ticket.id}`;
    expect(held).toMatchObject({
      attempt_token: lease.attempt_token,
      live: true,
    });

    release.resolve();
    await waitFor(async () => (await store.operations()).classified === 3);
    for (const child of replacements) child.kill("SIGTERM");
    await Promise.all(replacements.map((child) => child.exited));
    expect(replacements.map((child) => child.exitCode)).toEqual([0, 0]);
    const recovered = requests.filter(({ id }) => id === ticket.id);
    expect(recovered).toHaveLength(2);
    expect(recovered[1]!.at.getTime()).toBeGreaterThanOrEqual(
      lease.lease_until.getTime(),
    );
    expect(await store.get(ticket.id)).toMatchObject({
      status: "classified",
      attempts: 2,
      classification: { model: `test/${recovered[1]!.worker}` },
    });
    expect((await store.listRuns(ticket.id, { limit: 10 })).items).toHaveLength(
      1,
    );
    const [remaining] =
      await sql`SELECT count(*)::integer AS held FROM tickets WHERE lease_until IS NOT NULL`;
    expect(remaining.held).toBe(0);
    const events = (await Promise.all(outputs))
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      events.filter(
        (entry) =>
          entry.event === "classification_completed" && entry.attempt === 2,
      ),
    ).toEqual([expect.objectContaining({ accepted: true })]);
    expect(
      events.filter((entry) => entry.event === "classification_completed"),
    ).toHaveLength(3);
  } finally {
    clearTimeout(deadline);
    release.resolve();
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    await Promise.all(outputs);
    await provider.stop(true);
  }
}, 30_000);
