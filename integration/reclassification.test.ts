import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { Store } from "../src/store";
import { migrate } from "../src/migrate";
import {
  connectTestDatabase,
  prepareDatabase,
  resetTables,
  testDatabaseUrl,
} from "./helpers";

const sql = connectTestDatabase();
const store = new Store(sql);
const input = {
  id: "rerun-ticket",
  subject: "Invoice",
  body: "Where is my invoice?",
};
const outcome = {
  category: "billing",
  priority: "low",
  summary: "The customer asks where to download an invoice.",
} as const;
const actor = "a".repeat(64);
beforeAll(() => prepareDatabase(sql));
beforeEach(() => resetTables(sql));
afterAll(() => sql.close());

test("migration upgrades existing tickets and preserves their classification", async () => {
  await sql`CREATE SCHEMA classification_upgrade_test`;
  const legacy = new SQL(testDatabaseUrl(), {
    max: 1,
    connection: { search_path: "classification_upgrade_test" },
  });
  try {
    await legacy.unsafe(
      await Bun.file(
        new URL("../migrations/001_tickets.sql", import.meta.url),
      ).text(),
    );
    await legacy`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await legacy`INSERT INTO schema_migrations (name) VALUES ('001_tickets.sql')`;
    await legacy`INSERT INTO tickets (id, subject, body, status, category, priority, summary, model, prompt_version, classified_at, attempts)
      VALUES ('legacy', '', 'Original content', 'classified', 'billing', 'low', 'An invoice is requested.', 'old-model', 'old-prompt', now(), 2)`;
    await migrate(legacy);
    await migrate(legacy);
    const upgraded = new Store(legacy);
    expect(await upgraded.ready()).toBe(true);
    const ticket = (await upgraded.get("legacy"))!;
    expect(ticket.body).toBe("Original content");
    const run = (await upgraded.getRun("legacy", ticket.classificationRunId))!;
    expect(run.classification?.promptVersion).toBe("old-prompt");
    expect(run.attempts).toBe(2);
    await upgraded.requestRun("legacy", crypto.randomUUID(), run.id, actor);
    expect((await upgraded.getRun("legacy", run.id))?.classification).toEqual(
      run.classification,
    );
  } finally {
    await legacy.close();
    await sql`DROP SCHEMA classification_upgrade_test CASCADE`;
  }
});

test("failed and old-prompt tickets can be reclassified without losing history or ingestion idempotency", async () => {
  const original = (await store.ingest(input)).ticket;
  const first = (await store.claim(1, 60_000))!;
  await store.fail(first, "model_http_400", false, 1, 0);
  const id = crypto.randomUUID();
  const rerun = await store.requestRun(
    input.id,
    id,
    original.classificationRunId,
    actor,
  );
  expect(rerun.created).toBe(true);
  expect(rerun.run.status).toBe("pending");
  expect(rerun.run.attempts).toBe(0);
  expect(
    (await store.getRun(input.id, original.classificationRunId))?.failure?.code,
  ).toBe("model_http_400");
  expect((await store.ingest(input)).ticket.classificationRunId).toBe(id);
  const second = (await store.claim(3, 60_000))!;
  expect(second.attempts).toBe(1);
  expect(await store.complete(first, outcome, "old-model", "v1")).toBe(false);
  expect(await store.complete(second, outcome, "new-model", "v2")).toBe(true);
  const nextId = crypto.randomUUID();
  await store.requestRun(input.id, nextId, id, actor);
  const replay = await store.requestRun(
    input.id,
    id,
    original.classificationRunId,
    actor,
  );
  expect(replay.created).toBe(false);
  expect(replay.run.classification?.promptVersion).toBe("v2");
  expect((await store.get(input.id))?.classificationRunId).toBe(nextId);
  const page = await store.listRuns(input.id, { limit: 2 });
  expect(page.items.map((run) => run.id)).toEqual([nextId, id]);
  const final = await store.listRuns(input.id, {
    limit: 2,
    cursor: page.nextCursor!,
  });
  expect(final.items.map((run) => run.id)).toEqual([
    original.classificationRunId,
  ]);
  await expect(
    store.listRuns("other-ticket", { limit: 2, cursor: page.nextCursor! }),
  ).rejects.toThrow("invalid_cursor");
});

test("concurrent retries create one run and stale or pending requests cannot schedule extra work", async () => {
  const original = (await store.ingest(input)).ticket;
  await expect(
    store.requestRun(
      input.id,
      crypto.randomUUID(),
      original.classificationRunId,
      actor,
    ),
  ).rejects.toThrow("classification_pending");
  const job = (await store.claim(3, 60_000))!;
  await store.complete(job, outcome, "old-model", "old-prompt");
  const id = crypto.randomUUID();
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      store.requestRun(input.id, id, original.classificationRunId, actor),
    ),
  );
  expect(results.filter((result) => result.created)).toHaveLength(1);
  await expect(
    store.requestRun(input.id, id, crypto.randomUUID(), actor),
  ).rejects.toThrow("run_conflict");
  const current = (await store.claim(3, 60_000))!;
  await expect(
    store.requestRun(input.id, crypto.randomUUID(), id, actor),
  ).rejects.toThrow("classification_pending");
  await store.complete(current, outcome, "new-model", "new-prompt");
  await expect(
    store.requestRun(
      input.id,
      crypto.randomUUID(),
      original.classificationRunId,
      actor,
    ),
  ).rejects.toThrow("classification_changed");
  expect(await store.claim(3, 60_000)).toBeNull();
  expect((await store.listRuns(input.id, { limit: 20 })).items).toHaveLength(2);
  expect(await store.getRun("another-ticket", id)).toBeNull();
});

test("a run UUID racing across tickets has one owner and the losing transaction rolls back", async () => {
  const tickets = await Promise.all(
    ["one", "two"].map(async (id) => {
      const ticket = (await store.ingest({ ...input, id })).ticket;
      return ticket;
    }),
  );
  for (let i = 0; i < 2; i++)
    await store.complete(
      (await store.claim(3, 60_000))!,
      outcome,
      "model",
      "v1",
    );
  const runId = crypto.randomUUID();
  const results = await Promise.allSettled(
    tickets.map((ticket) =>
      store.requestRun(ticket.id, runId, ticket.classificationRunId, actor),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const loserIndex = results.findIndex(
    (result) => result.status === "rejected",
  );
  expect((results[loserIndex] as PromiseRejectedResult).reason.message).toBe(
    "run_conflict",
  );
  const loser = tickets[loserIndex]!;
  expect((await store.get(loser.id))?.status).toBe("classified");
  expect((await store.listRuns(loser.id, { limit: 20 })).items).toHaveLength(1);
});
