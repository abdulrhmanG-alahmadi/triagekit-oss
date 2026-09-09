import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";
import { connectDatabase } from "../src/database";
import { Store } from "../src/store";
import { processJob } from "../src/worker";
import samples from "../samples/tickets.json";
import {
  connectTestDatabase,
  prepareDatabase,
  testDatabaseUrl,
} from "./helpers";

test("documented runtime grants support the lifecycle and deny deletion and DDL", async () => {
  // Use the disposable bootstrap administrator, as in CI, to provision separate logins.
  const admin = connectTestDatabase(1);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const database = `permissions_${suffix}_test`;
  const migrator = `migrator_${suffix}`;
  const runtime = `runtime_${suffix}`;
  const password = crypto.randomUUID();
  const loginUrl = (role: string) => {
    const url = new URL(testDatabaseUrl());
    url.pathname = database;
    url.username = role;
    url.password = password;
    return url.href;
  };
  let ownerSql: SQL | undefined;
  let runtimeSql: SQL | undefined;
  try {
    // Identifiers and this temporary password contain only generated letters, digits, underscores and hyphens.
    for (const role of [migrator, runtime])
      await admin.unsafe(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
    await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${migrator}"`);
    await admin.unsafe(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
    await admin.unsafe(
      `GRANT CONNECT ON DATABASE "${database}" TO "${migrator}", "${runtime}"`,
    );
    ownerSql = connectDatabase(loginUrl(migrator), 1);
    await ownerSql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    await ownerSql.unsafe(`GRANT USAGE ON SCHEMA public TO "${runtime}"`);
    await prepareDatabase(ownerSql);
    await ownerSql.unsafe(
      `GRANT SELECT, INSERT, UPDATE ON public.tickets, public.rate_limits, public.classification_runs TO "${runtime}"`,
    );
    await ownerSql.unsafe(
      `GRANT SELECT ON public.schema_migrations TO "${runtime}"`,
    );
    await ownerSql.unsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtime}"`,
    );

    runtimeSql = connectDatabase(loginUrl(runtime));
    const [identity] =
      await runtimeSql`SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user`;
    expect(identity).toMatchObject({
      name: runtime,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const store = new Store(runtimeSql);
    const config = readConfig({
      DATABASE_URL: loginUrl(runtime),
      API_KEYS: "permission-test-key-".repeat(4),
    });
    const app = createApp(config, store, () => {});
    const request = (path: string, method = "GET", body?: unknown) =>
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiKeys[0]}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await app.handle(request("/health/ready"))).status).toBe(200);
    const ticket = samples[0]!;
    const created = await app.handle(
      request("/api/v1/tickets", "POST", ticket),
    );
    expect(created.status).toBe(201);
    const initial = await created.json();
    const classify = async () => ({
      model: "test/permissions",
      text: JSON.stringify({
        category: "billing",
        priority: "low",
        summary: "The customer needs an invoice.",
      }),
    });
    await processJob(
      store,
      (await store.claim(3, 60_000))!,
      classify,
      config,
      () => {},
    );
    const classified = await app.handle(
      request(`/api/v1/tickets/${ticket.id}`),
    );
    expect(classified.status).toBe(200);
    expect(await classified.json()).toMatchObject({
      status: "classified",
      attempts: 1,
    });
    const runId = crypto.randomUUID();
    const rerun = await app.handle(
      request(
        `/api/v1/tickets/${ticket.id}/classification-runs/${runId}`,
        "PUT",
        { previousRunId: initial.classificationRunId },
      ),
    );
    expect(rerun.status).toBe(201);
    await processJob(
      store,
      (await store.claim(3, 60_000))!,
      classify,
      config,
      () => {},
    );
    const history = await app.handle(
      request(`/api/v1/tickets/${ticket.id}/classification-runs`),
    );
    expect(history.status).toBe(200);
    expect((await history.json()).items).toEqual([
      expect.objectContaining({
        id: runId,
        status: "classified",
        previousRunId: initial.classificationRunId,
      }),
      expect.objectContaining({
        id: initial.classificationRunId,
        status: "classified",
      }),
    ]);
    expect((await app.handle(request("/api/v1/operations"))).status).toBe(200);

    // Hold the existing window across a minute boundary so the rejection is deterministic.
    await runtimeSql`UPDATE rate_limits SET window_start = clock_timestamp() + interval '1 minute'`;
    const limited = createApp(
      { ...config, rateLimitPerMinute: 1 },
      store,
      () => {},
    );
    const rejected = await limited.handle(request("/api/v1/tickets"));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ code: "rate_limited" });
    await expect(
      runtimeSql`DELETE FROM tickets WHERE id = ${ticket.id}`.execute(),
    ).rejects.toMatchObject({ errno: "42501" });
    await expect(
      runtimeSql`CREATE SCHEMA runtime_forbidden`.execute(),
    ).rejects.toMatchObject({ errno: "42501" });
    await expect(
      runtimeSql`CREATE TABLE public.runtime_forbidden (id integer)`.execute(),
    ).rejects.toMatchObject({ errno: "42501" });
    expect((await store.get(ticket.id))?.status).toBe("classified");
  } finally {
    await runtimeSql?.close();
    await ownerSql?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.unsafe(`DROP ROLE IF EXISTS "${runtime}", "${migrator}"`);
    await admin.close();
  }
}, 30_000);
