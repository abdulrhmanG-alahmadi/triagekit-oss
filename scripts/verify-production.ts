import assert from "node:assert/strict";
import { createApp, maxBodyBytes } from "../src/app";
import { apiClient } from "../src/client";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/database";
import { Store } from "../src/store";
import { prepareDatabase } from "../integration/helpers";
import { checkOperations } from "./check-operations";

// Fixed, bounded synthetic workload. Never accepts a database URL or container name.
const tickets = Array.from({ length: 200 }, (_, index) => ({
  id: `rehearsal-${index}`,
  subject: `Synthetic invoice ${index}`,
  body: `Please send invoice ${index}. مرحبًا 🧾`,
}));
const requestConcurrency = 16;
const workerConcurrency = 4;
const providerLatencyMs = 25;
const container = `triagekit-rehearsal-${crypto.randomUUID()}`;
const password = crypto.randomUUID();
const database = "rehearsal_test";
const restoredDatabase = "restored_test";
const key = crypto.randomUUID();
const stop = new AbortController();
const interrupt = () => stop.abort(new Error("Rehearsal interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const deadline = setTimeout(
  () => stop.abort(new Error("Rehearsal exceeded 180 seconds")),
  180_000,
);

async function docker(args: string[], cleanup = false) {
  const child = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
    signal: cleanup ? undefined : stop.signal,
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `docker ${args[0]} failed: ${error.trim()}`);
  return output.trim();
}

function spawnWorker(databaseUrl: string, providerUrl: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      `${import.meta.dir}/../integration/fixtures/local-provider.ts`,
      `${import.meta.dir}/../src/worker.ts`,
    ],
    {
      env: {
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        DATABASE_TLS: "private-network",
        LLM_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "local-rehearsal-key",
        OPENROUTER_MODEL: "synthetic/rehearsal",
        TEST_PROVIDER_URL: providerUrl,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
        POLL_INTERVAL_MS: "10",
        RETRY_BASE_MS: "1000",
        WORKER_CONCURRENCY: String(workerConcurrency),
        MAX_ATTEMPTS: "3",
        MODEL_TIMEOUT_MS: "1000",
        LEASE_MS: "11000",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  return { child, error: new Response(child.stderr).text() };
}

async function stopWorker(worker: ReturnType<typeof spawnWorker>) {
  assert.equal(worker.child.exitCode, null, "Worker exited unexpectedly");
  worker.child.kill("SIGTERM");
  const deadline = setTimeout(() => worker.child.kill("SIGKILL"), 10_000);
  try {
    assert.equal(await worker.child.exited, 0, await worker.error);
  } finally {
    clearTimeout(deadline);
  }
}

// Compare PostgreSQL's complete JSON, preserving timestamps at database precision.
async function snapshot(sql: ReturnType<typeof connectDatabase>) {
  const [row] = await sql`SELECT jsonb_build_object(
    'tickets', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tickets t),
    'classificationRuns', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM classification_runs r),
    'migrations', (SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM schema_migrations m),
    'rateLimits', (SELECT jsonb_agg(to_jsonb(l) ORDER BY principal) FROM rate_limits l)
  )::text AS contents`;
  return row.contents as string;
}

async function main() {
  const started = performance.now();
  let created = false;
  let sql: ReturnType<typeof connectDatabase> | undefined;
  let restored: ReturnType<typeof connectDatabase> | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  const workers: ReturnType<typeof spawnWorker>[] = [];
  let activeWorker: ReturnType<typeof spawnWorker> | undefined;
  async function until(condition: () => Promise<boolean>) {
    const expires = performance.now() + 30_000;
    while (!(await condition())) {
      stop.signal.throwIfAborted();
      assert(performance.now() < expires, "Rehearsal condition timed out");
      assert(
        !activeWorker || activeWorker.child.exitCode === null,
        "Worker exited before queue drained",
      );
      await Bun.sleep(20);
    }
  }
  try {
    const compose = await Bun.file(
      new URL("../compose.yaml", import.meta.url),
    ).text();
    const image = /image: (postgres:\S+)/.exec(compose)?.[1];
    assert(image, "Missing pinned PostgreSQL image in compose.yaml");
    // The random name is owned by this invocation, including cleanup on a failed start.
    created = true;
    await docker([
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--tmpfs",
      "/var/lib/postgresql:rw,size=512m",
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${database}`,
      image,
    ]);
    const port = (await docker(["port", container, "5432/tcp"]))
      .split(":")
      .at(-1);
    assert(port && /^\d+$/.test(port), "Invalid disposable PostgreSQL port");
    const databaseUrl = `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;
    await until(async () => {
      try {
        await docker([
          "exec",
          container,
          "pg_isready",
          "-U",
          "postgres",
          "-d",
          database,
        ]);
        return true;
      } catch {
        return false;
      }
    });
    sql = connectDatabase(databaseUrl);
    await prepareDatabase(sql);
    const store = new Store(sql);
    const config = readConfig(
      {
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        DATABASE_TLS: "private-network",
        API_KEYS: key,
        RATE_LIMIT_PER_MINUTE: "100000",
      },
      "api",
    );
    app = createApp(config, store, () => {}).listen({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: maxBodyBytes,
    });
    assert(app.server);
    const baseUrl = app.server.url.href;
    const client = apiClient(baseUrl, key, fetch, stop.signal);
    const latencies: number[] = [];
    let inserted = 0,
      duplicates = 0;
    const ingestionStarted = performance.now();
    // Adjacent duplicate submissions race within each bounded batch.
    for (
      let offset = 0;
      offset < tickets.length * 2;
      offset += requestConcurrency
    ) {
      await Promise.all(
        Array.from({ length: requestConcurrency }, async (_, slot) => {
          const ticket = tickets[Math.floor((offset + slot) / 2)];
          if (!ticket) return;
          const before = performance.now();
          const result = await client.tickets.post(ticket);
          latencies.push(performance.now() - before);
          assert(
            [200, 201].includes(result.status),
            `Ingestion HTTP ${result.status}`,
          );
          assert.equal(result.data?.id, ticket.id);
          if (result.status === 201) inserted++;
          else duplicates++;
        }),
      );
    }
    const ingestionMs = performance.now() - ingestionStarted;
    assert.equal(inserted, tickets.length);
    assert.equal(duplicates, tickets.length);
    const monitoring = () =>
      checkOperations(baseUrl, key, {
        maxPendingSeconds: 0.1,
        maxFailedTickets: 0,
      });
    await until(async () =>
      (await monitoring()).alerts.includes("queue_stalled"),
    );
    assert.equal((await monitoring()).pending, tickets.length);

    let outage = true,
      generation = 1,
      providerCalls = 0,
      transientFailures = 0;
    const affectedSubjects = new Set<string>();
    let inFlight = 0,
      peakInFlight = 0;
    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        providerCalls++;
        try {
          const { messages } = await request.json();
          const { subject } = JSON.parse(messages[1].content);
          await Bun.sleep(providerLatencyMs);
          if (outage) {
            transientFailures++;
            affectedSubjects.add(subject);
            return new Response("", { status: 503 });
          }
          if (generation === 1 && subject === tickets.at(-1)?.subject)
            return new Response("", { status: 400 });
          return Response.json({
            model: `synthetic/rehearsal-${generation}`,
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    category: "billing",
                    priority: "low",
                    summary: "The customer requests an invoice.",
                  }),
                },
              },
            ],
          });
        } finally {
          inFlight--;
        }
      },
    });
    activeWorker = spawnWorker(databaseUrl, provider.url.href);
    workers.push(activeWorker);
    await until(async () => {
      assert(sql);
      const [row] =
        await sql`SELECT count(*)::integer AS failures FROM tickets WHERE last_error_code = 'model_http_503'`;
      return row.failures >= workerConcurrency;
    });
    await stopWorker(activeWorker);
    activeWorker = undefined;
    assert.equal((await store.operations()).inFlight, 0);
    assert.equal((await store.operations()).pending, tickets.length);
    assert(transientFailures >= workerConcurrency);
    outage = false;
    const drainStarted = performance.now();
    activeWorker = spawnWorker(databaseUrl, provider.url.href);
    workers.push(activeWorker);
    await until(async () => (await store.operations()).pending === 0);
    const drainMs = performance.now() - drainStarted;
    const [recovery] =
      await sql`SELECT count(*)::integer AS recovered FROM tickets WHERE attempts > 1 AND status = 'classified'`;
    assert.equal(recovery.recovered, affectedSubjects.size);
    assert.equal((await store.operations()).classified, tickets.length - 1);
    assert.deepEqual((await monitoring()).alerts, ["failed_tickets"]);

    generation = 2;
    for (const input of tickets.slice(-5)) {
      const ticket = await store.get(input.id);
      assert(ticket);
      const result = await client
        .tickets({ id: ticket.id })
        ["classification-runs"]({ runId: crypto.randomUUID() })
        .put({ previousRunId: ticket.classificationRunId });
      assert.equal(result.status, 201);
    }
    await until(
      async () => (await store.operations()).classified === tickets.length,
    );
    await stopWorker(activeWorker);
    activeWorker = undefined;
    assert.deepEqual((await monitoring()).alerts, []);
    assert(peakInFlight > 1 && peakInFlight <= workerConcurrency);
    const [history] =
      await sql`SELECT count(*)::integer AS runs, count(snapshot)::integer AS archived FROM classification_runs`;
    assert.equal(history.runs, tickets.length + 5);
    assert.equal(history.archived, 5);
    const stored = await sql`SELECT id, subject, body FROM tickets ORDER BY id`;
    assert.deepEqual(
      [...stored],
      [...tickets].sort((a, b) => a.id.localeCompare(b.id)),
    );
    await app.stop(true);
    app = undefined;
    const original = await snapshot(sql);
    const restoreStarted = performance.now();
    await docker([
      "exec",
      container,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      database,
      "-Fc",
      "-f",
      "/tmp/rehearsal.dump",
    ]);
    await docker([
      "exec",
      container,
      "createdb",
      "-U",
      "postgres",
      restoredDatabase,
    ]);
    await docker([
      "exec",
      container,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "-U",
      "postgres",
      "-d",
      restoredDatabase,
      "/tmp/rehearsal.dump",
    ]);
    restored = connectDatabase(
      databaseUrl.replace(`/${database}`, `/${restoredDatabase}`),
    );
    assert.equal(
      await snapshot(restored),
      original,
      "Restored complete history differs",
    );
    assert.equal(await new Store(restored).ready(), true);
    const restoreMs = performance.now() - restoreStarted;
    latencies.sort((a, b) => a - b);
    return {
      scope:
        "local Docker PostgreSQL; synthetic provider; not a cloud SLA or live-model benchmark",
      tickets: tickets.length,
      requests: latencies.length,
      duplicates,
      requestConcurrency,
      workerConcurrency,
      providerLatencyMs,
      ingestionMs: Math.round(ingestionMs),
      requestsPerSecond: Math.round((latencies.length * 1000) / ingestionMs),
      ingestionP95Ms: Math.round(
        latencies[Math.ceil(latencies.length * 0.95) - 1] ?? 0,
      ),
      drainMs: Math.round(drainMs),
      terminalTicketsPerSecond: Math.round((tickets.length * 1000) / drainMs),
      providerCalls,
      peakInFlight,
      transientFailures,
      transientlyAffectedTickets: affectedSubjects.size,
      recoveredTickets: recovery.recovered,
      workerRestarts: 1,
      stalledQueueDetected: true,
      failureAlertDetected: true,
      restoreMs: Math.round(restoreMs),
      preservedTickets: tickets.length,
      preservedRuns: history.runs,
      archivedRuns: history.archived,
      completeHistoryEqual: true,
      lostTickets: 0,
      totalMs: Math.round(performance.now() - started),
    };
  } finally {
    for (const { child } of workers)
      if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(workers.map(({ child }) => child.exited));
    const cleanup = await Promise.allSettled([
      app?.stop(true),
      provider?.stop(true),
      sql?.close({ timeout: 5 }),
      restored?.close({ timeout: 5 }),
      ...(created
        ? [docker(["rm", "--force", "--volumes", container], true)]
        : []),
    ]);
    assert(
      cleanup.every((result) => result.status === "fulfilled"),
      `Rehearsal cleanup failed; inspect ${container}`,
    );
  }
}

try {
  console.log(JSON.stringify(await main(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Rehearsal failed");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
