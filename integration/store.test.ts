import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { LATEST_MIGRATION, Store } from "../src/store";
import { connectDatabase } from "../src/database";
import {
  connectTestDatabase,
  prepareDatabase,
  resetTables,
  testDatabaseUrl,
} from "./helpers";

const sql = connectTestDatabase();
const store = new Store(sql);
const ticket = { id: "t-1", subject: "Invoice", body: "I need an invoice." };
const classification = {
  category: "billing",
  priority: "low",
  summary: "The customer needs an invoice.",
} as const;

beforeAll(() => prepareDatabase(sql));
beforeEach(() => resetTables(sql));
afterAll(() => sql.close());

test("concurrent duplicate ingestion creates one durable job and rejects changed content", async () => {
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () => store.ingest(ticket)),
  );
  expect(outcomes.filter((x) => x.created)).toHaveLength(1);
  expect((await store.list({ limit: 20 })).items).toHaveLength(1);
  await expect(
    store.ingest({ ...ticket, body: "Different content" }),
  ).rejects.toThrow("ticket_conflict");
  const claimed = await store.claim(3, 60_000);
  expect(claimed?.attempts).toBe(1);
  expect(await store.claim(3, 60_000)).toBeNull();
  await store.complete(claimed!, classification, "test-model", "v1");
  const duplicate = await store.ingest(ticket);
  expect(duplicate.ticket.status).toBe("classified");
  expect(await store.claim(3, 60_000)).toBeNull();
});

test("expired work is reclaimed and late results are fenced", async () => {
  await store.ingest(ticket);
  const first = (await store.claim(3, 60_000))!;
  await sql`UPDATE tickets SET lease_until = now() - interval '1 second', available_at = now() - interval '1 second' WHERE id = ${ticket.id}`;
  const second = (await store.claim(3, 60_000))!;
  expect(second.attempts).toBe(2);
  expect(await store.complete(first, classification, "old", "v1")).toBe(false);
  expect(await store.complete(second, classification, "new", "v1")).toBe(true);
  expect((await store.get(ticket.id))?.classification?.model).toBe("new");
});

for (const operation of ["complete", "fail"] as const) {
  test(`${operation} rejects a lease that expires while waiting for a row lock`, async () => {
    await store.ingest(ticket);
    const job = (await store.claim(3, 1_000))!;
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blockerPid: number;
    const transaction = sql.begin(async (tx) => {
      await tx`SELECT id FROM tickets WHERE id = ${job.id} FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      blockerPid = backend.pid;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const writing =
      operation === "complete"
        ? store.complete(job, classification, "test", "v1")
        : store.fail(job, "model_http_400", false, 3, 0);
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${blockerPid!} = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        blocked = row.blocked;
        if (blocked) break;
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      const [lease] =
        await sql`SELECT lease_until > clock_timestamp() AS valid FROM tickets WHERE id = ${job.id}`;
      expect(lease.valid).toBe(true);
      await sql`SELECT pg_sleep(GREATEST(0, extract(epoch FROM lease_until - clock_timestamp())) + 0.01)
        FROM tickets WHERE id = ${job.id}`;
      release.resolve();
      expect(await writing).toBe(false);
      expect((await store.get(job.id))?.status).toBe("pending");
    } finally {
      release.resolve();
      await transaction;
      await writing;
    }
  });
}

test("an expired final attempt becomes failed but still reports why it failed", async () => {
  await store.ingest(ticket);
  await store.fail(
    (await store.claim(2, 60_000))!,
    "model_http_500",
    true,
    2,
    0,
  );
  await store.claim(2, 60_000);
  await sql`UPDATE tickets SET lease_until = now() - interval '1 second'`;
  expect(await store.claim(2, 60_000)).toBeNull();
  const exhausted = (await store.get(ticket.id))!;
  expect(exhausted.status).toBe("failed");
  expect(exhausted.failure?.code).toBe("attempts_exhausted");
  expect(exhausted.lastErrorCode).toBe("model_http_500");
});

test("retry scheduling preserves attempts and terminates exhausted jobs", async () => {
  await store.ingest(ticket);
  const first = (await store.claim(2, 60_000))!;
  await store.fail(first, "invalid_model_output", true, 2, 10_000);
  const retrying = (await store.get(ticket.id))!;
  expect(retrying.status).toBe("pending");
  expect(retrying.attempts).toBe(1);
  expect(retrying.lastErrorCode).toBe("invalid_model_output");
  expect(await store.claim(2, 60_000)).toBeNull();
  await sql`UPDATE tickets SET available_at = now()`;
  const last = (await store.claim(2, 60_000))!;
  await store.fail(last, "invalid_model_output", true, 2, 0);
  expect((await store.get(ticket.id))?.failure?.code).toBe(
    "invalid_model_output",
  );
  expect(await store.claim(2, 60_000)).toBeNull();
});

test("cursor pagination is stable and binds filters", async () => {
  for (let i = 0; i < 5; i++) {
    await store.ingest({ ...ticket, id: `t-${i}` });
    const job = (await store.claim(3, 60_000))!;
    await store.complete(job, classification, "fake", "v1");
  }
  const first = await store.list({ limit: 2, category: "billing" });
  const second = await store.list({
    limit: 2,
    category: "billing",
    cursor: first.nextCursor!,
  });
  expect(first.items.map((t) => t.id)).toEqual(["t-4", "t-3"]);
  expect(second.items.map((t) => t.id)).toEqual(["t-2", "t-1"]);
  await expect(
    store.list({ limit: 2, category: "account", cursor: first.nextCursor! }),
  ).rejects.toThrow("invalid_cursor");
  expect((await store.list({ limit: 20, priority: "high" })).items).toEqual([]);
});

test("database constraints reject invalid classifications even outside the API", async () => {
  await store.ingest(ticket);
  await expect(
    sql`UPDATE tickets SET status = 'classified', category = 'fraud', priority = 'high', summary = 'Invalid.', model = 'fake', prompt_version = 'v1', classified_at = clock_timestamp()`.execute(),
  ).rejects.toMatchObject({
    errno: "23514",
    constraint: "tickets_category_check",
  });
  expect((await store.get(ticket.id))?.status).toBe("pending");
});

test("rate limits apply atomically across concurrent requests", async () => {
  const allowed = await Promise.all(
    Array.from({ length: 12 }, () => store.allowRequest("key-hash", 3)),
  );
  expect(allowed.filter(Boolean)).toHaveLength(3);
});

test("delayed rate-limit requests cannot reset a newer window", async () => {
  await sql`INSERT INTO rate_limits VALUES ('key-hash', date_trunc('minute', now()) + interval '1 minute', 3)`;
  expect(await store.allowRequest("key-hash", 3)).toBe(false);
});

test("runtime connections bound database statement and lock waits", async () => {
  const runtime = connectDatabase(testDatabaseUrl(), 1);
  try {
    const [statement] = await runtime`SHOW statement_timeout`;
    const [lock] = await runtime`SHOW lock_timeout`;
    expect(statement.statement_timeout).toBe("5s");
    expect(lock.lock_timeout).toBe("2s");
  } finally {
    await runtime.close();
  }
});

test("list filters select by classification, status and prompt version", async () => {
  const seeded = [
    ["billing-high", "billing", "high"],
    ["billing-low", "billing", "low"],
    ["technical-high", "technical", "high"],
    ["technical-low", "technical", "low"],
  ] as const;
  for (const [id, category, priority] of seeded) {
    await store.ingest({ ...ticket, id });
    await store.complete(
      (await store.claim(3, 60_000))!,
      { category, priority, summary: "The customer needs help." },
      "fake",
      "v1",
    );
  }
  await sql`UPDATE tickets SET prompt_version = 'v2' WHERE id IN ('billing-low', 'technical-low')`;
  await store.ingest({ ...ticket, id: "failed-one" });
  await store.fail(
    (await store.claim(1, 60_000))!,
    "model_http_400",
    false,
    1,
    0,
  );
  await store.ingest({ ...ticket, id: "pending-one" });
  const ids = async (options: Parameters<Store["list"]>[0]) =>
    (await store.list(options)).items.map((item) => item.id).sort();

  expect(await ids({ limit: 20, category: "billing" })).toEqual([
    "billing-high",
    "billing-low",
  ]);
  expect(await ids({ limit: 20, priority: "high" })).toEqual([
    "billing-high",
    "technical-high",
  ]);
  expect(
    await ids({ limit: 20, category: "technical", priority: "low" }),
  ).toEqual(["technical-low"]);
  expect(await ids({ limit: 20, status: "failed" })).toEqual(["failed-one"]);
  expect(await ids({ limit: 20, status: "pending" })).toEqual(["pending-one"]);
  expect(await ids({ limit: 20, promptVersion: "v2" })).toEqual([
    "billing-low",
    "technical-low",
  ]);
  expect(
    await ids({ limit: 20, status: "classified", promptVersion: "v1" }),
  ).toEqual(["billing-high", "technical-high"]);

  const page = await store.list({ limit: 1, category: "billing" });
  expect(page.nextCursor).not.toBeNull();
  await expect(
    store.list({ limit: 1, category: "billing", cursor: page.nextCursor! }),
  ).resolves.toBeDefined();
  for (const other of [
    { limit: 1, category: "technical" },
    { limit: 1, category: "billing", priority: "high" },
    { limit: 1, category: "billing", promptVersion: "v1" },
    { limit: 1, status: "classified", category: "billing" },
  ] as const)
    await expect(
      store.list({ ...other, cursor: page.nextCursor! }),
    ).rejects.toThrow("invalid_cursor");
});

test("readiness tracks the newest migration on disk", async () => {
  const files = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  expect(files.at(-1)).toBe(LATEST_MIGRATION);
  expect(await store.ready()).toBe(true);
});
