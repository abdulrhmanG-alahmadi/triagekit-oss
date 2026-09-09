import { expect, test } from "bun:test";
import { SQL } from "bun";
import { readConfig } from "../src/config";
import type { Job, Store } from "../src/store";
import { runWorker } from "../src/worker";

const config = readConfig(
  {
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
    POLL_INTERVAL_MS: "10",
    WORKER_CONCURRENCY: "1",
  },
  "worker",
);
const valid = JSON.stringify({
  category: "billing",
  priority: "low",
  summary: "The customer needs an invoice.",
});
const job: Job = {
  id: "t-worker",
  subject: "Invoice",
  body: "Please send an invoice.",
  attempts: 1,
  attemptToken: crypto.randomUUID(),
  lastErrorCode: null,
};

test("permanent database errors stop after one claim and retain only safe diagnostics", async () => {
  for (const errno of ["28P01", "42501", "3D000", "42P01", "22023"]) {
    const stop = new AbortController();
    const deadline = setTimeout(() => stop.abort(), 200);
    let claims = 0;
    const events: Record<string, unknown>[] = [];
    const store = {
      claim: async () => {
        claims++;
        throw new SQL.PostgresError("PRIVATE DATABASE PASSWORD", {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno,
        });
      },
    } as unknown as Store;
    try {
      const outcome = await runWorker(
        store,
        async () => ({ text: valid, model: "test" }),
        config,
        stop.signal,
        (entry) => events.push(entry),
      ).then(
        () => "stopped",
        (error) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(claims).toBe(1);
      expect(events).toEqual([
        expect.objectContaining({
          event: "worker_slot_error",
          code: errno,
          errorClass: "PostgresError",
          retryable: false,
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
      expect(String(outcome)).not.toContain("PRIVATE");
    } finally {
      clearTimeout(deadline);
      stop.abort();
    }
  }
});

test("transient connection and lock failures recover on the next claim", async () => {
  for (const error of [
    new SQL.PostgresError("PRIVATE CONNECTION", {
      code: "ERR_POSTGRES_CONNECTION_REFUSED",
    }),
    new SQL.PostgresError("PRIVATE LOCK", {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "55P03",
    }),
  ]) {
    const stop = new AbortController();
    const deadline = setTimeout(() => stop.abort(), 2_000);
    let claims = 0;
    const events: Record<string, unknown>[] = [];
    const store = {
      claim: async () => {
        if (++claims === 1) throw error;
        stop.abort();
        return null;
      },
    } as unknown as Store;
    try {
      await runWorker(
        store,
        async () => ({ text: valid, model: "test" }),
        config,
        stop.signal,
        (entry) => events.push(entry),
      );
      expect(claims).toBe(2);
      expect(events).toEqual([
        expect.objectContaining({
          event: "worker_slot_error",
          retryable: true,
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
    } finally {
      clearTimeout(deadline);
      stop.abort();
    }
  }
}, 5_000);

test("fatal database failure stops siblings and drains claimed work before rejecting", async () => {
  const stop = new AbortController();
  const deadline = setTimeout(() => stop.abort(), 500);
  const started = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let claims = 0,
    completed = 0,
    settled = false;
  const store = {
    claim: async () => {
      if (++claims === 1) return job;
      await started.promise;
      throw new SQL.PostgresError("PRIVATE DATABASE PASSWORD", {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "28P01",
      });
    },
    complete: async () => {
      completed++;
      return true;
    },
  } as unknown as Store;
  const running = runWorker(
    store,
    async () => {
      started.resolve();
      await release.promise;
      return { text: valid, model: "test" };
    },
    { ...config, concurrency: 2 },
    stop.signal,
    (entry) => {
      if (entry.event === "worker_slot_error") failed.resolve();
    },
  ).then(
    () => {
      settled = true;
      return "stopped";
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await failed.promise;
    await Bun.sleep(10);
    expect(settled).toBe(false);
    release.resolve();
    expect(await running).toBeInstanceOf(Error);
    expect(completed).toBe(1);
    expect(claims).toBe(2);
  } finally {
    clearTimeout(deadline);
    stop.abort();
    release.resolve();
    await running;
  }
});
