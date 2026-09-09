import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { parseRetentionArgs, purgeTickets } from "../src/retention";
import { Store } from "../src/store";
import {
  connectTestDatabase,
  prepareDatabase,
  resetTables,
  testDatabaseUrl,
} from "./helpers";

const sql = connectTestDatabase();
const store = new Store(sql);
const before = "2026-01-01T00:00:00.000Z";
const old = "2025-01-01T00:00:00.000Z";
const input = { subject: "Invoice", body: "Please send my invoice." };
const options = (args: string[] = []) =>
  parseRetentionArgs(["--before", before, ...args]);

beforeAll(() => prepareDatabase(sql));
beforeEach(() => resetTables(sql));
afterAll(() => sql.close());

async function failed(id: string, updatedAt = old) {
  await store.ingest({ ...input, id });
  await sql`UPDATE tickets SET status = 'failed', failure_code = 'model_http_400',
    updated_at = ${updatedAt}::timestamptz WHERE id = ${id}`;
}

async function withHistory(id: string) {
  await failed(id);
  for (let i = 0; i < 2; i++) {
    const current = (await store.get(id))!;
    await store.requestRun(
      id,
      crypto.randomUUID(),
      current.classificationRunId,
      "a".repeat(64),
    );
    await failed(id);
  }
}

test("retention requires an explicit valid UTC cutoff and bounded batch", () => {
  expect(parseRetentionArgs(["--before", "2026-01-01T00:00:00Z"])).toEqual({
    before,
    apply: false,
    batchSize: 100,
  });
  expect(options(["--apply", "--id", "ticket-1", "--batch-size", "2"])).toEqual(
    {
      before,
      apply: true,
      id: "ticket-1",
      batchSize: 2,
    },
  );
  for (const args of [
    [],
    ["--apply"],
    ["--before", "2026-01-01"],
    ["--before", "2026-02-30T00:00:00Z"],
    ["--before", "2026-01-01T00:00:00"],
    ["--before", "2026-01-01T24:00:00Z"],
    ["--before", before, "--batch-size", "0"],
    ["--before", before, "--batch-size", "1001"],
    ["--before", before, "--batch-size", "1.5"],
    ["--before", before, "--batch-size", "1\n"],
    ["--before", before, "--id", ""],
    ["--before", before, "--id", "bad/id"],
    ["--before", before, "--id", "ticket\n"],
    ["--before", before, "--id", "a".repeat(129)],
    ["--before", before, "--befor", old],
    ["--before", before, "--before", old],
    ["--before", before, "--apply=false"],
  ])
    expect(() => parseRetentionArgs(args)).toThrow();
});

test("dry-run leaves tickets and all historical runs unchanged", async () => {
  await withHistory("dry-run");
  const tickets = await sql`SELECT * FROM tickets ORDER BY sequence`;
  const runs = await sql`SELECT * FROM classification_runs ORDER BY sequence`;
  expect(await purgeTickets(sql, options())).toMatchObject({
    apply: false,
    ticketIds: ["dry-run"],
    runCount: 3,
  });
  expect(await sql`SELECT * FROM tickets ORDER BY sequence`).toEqual(tickets);
  expect(
    await sql`SELECT * FROM classification_runs ORDER BY sequence`,
  ).toEqual(runs);
});

test("apply erases only terminal tickets strictly older than the cutoff", async () => {
  await store.ingest({ ...input, id: "classified-old" });
  await store.complete(
    (await store.claim(3, 60_000))!,
    { category: "billing", priority: "low", summary: "An invoice is needed." },
    "test",
    "v1",
  );
  await sql`UPDATE tickets SET updated_at = ${old}::timestamptz WHERE id = 'classified-old'`;
  await failed("failed-old");
  await failed("at-cutoff", before);
  await failed("recent", "2026-02-01T00:00:00Z");
  await store.ingest({ ...input, id: "pending-old" });
  await store.claim(3, 60_000);
  await sql`UPDATE tickets SET created_at = ${old}::timestamptz,
    updated_at = ${old}::timestamptz WHERE id = 'pending-old'`;
  const pending = await store.get("pending-old");
  expect(await purgeTickets(sql, options(["--apply"]))).toMatchObject({
    ticketIds: ["classified-old", "failed-old"],
    runCount: 2,
  });
  expect(await store.get("pending-old")).toEqual(pending);
  expect((await store.list({ limit: 20 })).items.map((t) => t.id)).toEqual([
    "pending-old",
    "recent",
    "at-cutoff",
  ]);
});

test("targeted erasure removes the whole run chain and releases the dedupe ID", async () => {
  await withHistory("erase-me");
  await failed("keep-me");
  expect(
    await purgeTickets(sql, options(["--apply", "--id", "erase-me"])),
  ).toMatchObject({
    ticketIds: ["erase-me"],
    runCount: 3,
  });
  expect(await store.get("erase-me")).toBeNull();
  expect(
    await sql`SELECT id FROM classification_runs WHERE ticket_id = 'erase-me'`,
  ).toHaveLength(0);
  expect(await store.get("keep-me")).not.toBeNull();
  expect(
    (await store.ingest({ ...input, id: "erase-me", body: "New content." }))
      .created,
  ).toBe(true);
  expect(
    await purgeTickets(sql, options(["--apply", "--id", "erase-me"])),
  ).toMatchObject({
    ticketIds: [],
    runCount: 0,
  });
});

test("a ticket deletion failure rolls back its historical run deletion", async () => {
  await withHistory("protected");
  await sql`CREATE TABLE retention_guard (ticket_id varchar(128) REFERENCES tickets(id))`;
  try {
    await sql`INSERT INTO retention_guard VALUES ('protected')`;
    await expect(purgeTickets(sql, options(["--apply"]))).rejects.toMatchObject(
      { errno: "23503" },
    );
    expect(await store.get("protected")).not.toBeNull();
    expect(
      await sql`SELECT id FROM classification_runs WHERE ticket_id = 'protected'`,
    ).toHaveLength(3);
  } finally {
    await sql`DROP TABLE retention_guard`;
  }
});

test("each batch skips locked tickets and never exceeds its requested size", async () => {
  for (const id of ["locked", "one", "two", "three"]) await failed(id);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocking = sql.begin(async (tx) => {
    await tx`SELECT id FROM tickets WHERE id = 'locked' FOR UPDATE`;
    locked.resolve();
    await release.promise;
  });
  try {
    await locked.promise;
    expect(
      await purgeTickets(sql, options(["--apply", "--batch-size", "2"])),
    ).toMatchObject({
      ticketIds: ["one", "two"],
    });
    expect((await store.list({ limit: 20 })).items.map((t) => t.id)).toEqual([
      "three",
      "locked",
    ]);
  } finally {
    release.resolve();
    await blocking;
  }
  expect(
    await purgeTickets(sql, options(["--apply", "--batch-size", "2"])),
  ).toMatchObject({
    ticketIds: ["locked", "three"],
  });
});

test("the CLI validates arguments before connecting and never falls back to DATABASE_URL", async () => {
  const run = async (args: string[], maintenanceUrl = "") => {
    const child = Bun.spawn([process.execPath, "src/retention.ts", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        MAINTENANCE_DATABASE_URL: maintenanceUrl,
        DATABASE_URL: testDatabaseUrl(),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: await child.exited,
      error: await new Response(child.stderr).text(),
    };
  };
  const missing = await run(["--before", before, "--apply"]);
  expect(missing.code).toBe(1);
  expect(missing.error).toContain("MAINTENANCE_DATABASE_URL");
  const malformed = await run(
    ["--before", "yesterday", "--apply"],
    "postgres://secret:secret@127.0.0.1:1/unreachable",
  );
  expect(malformed.code).toBe(1);
  expect(malformed.error).toContain("--before");
  expect(malformed.error).not.toContain("secret");
});
