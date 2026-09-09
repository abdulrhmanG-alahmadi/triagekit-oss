import { SQL } from "bun";
import { databaseSslMode } from "./database";
import { readdir } from "node:fs/promises";
import { createLogger } from "./log";

export async function migrate(sql: SQL) {
  const directory = new URL("../migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(81735194)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of files) {
      const applied =
        await tx`SELECT name FROM schema_migrations WHERE name = ${name}`;
      if (applied.length) continue;
      await tx.unsafe(await Bun.file(new URL(name, directory)).text());
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    }
  });
}

if (import.meta.main) {
  const log = createLogger("triagekit-migrate");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  let sql: SQL | undefined;
  try {
    sql = new SQL(process.env.DATABASE_URL, {
      max: 1,
      connectionTimeout: 5,
      ssl: databaseSslMode(process.env),
    });
    await migrate(sql);
    log({ event: "migrations_complete" });
  } catch (error) {
    log({
      event: "migration_failed",
      level: "error",
      code:
        error instanceof SQL.PostgresError ? error.errno : "unexpected_error",
    });
    process.exitCode = 1;
  } finally {
    await sql?.close();
  }
}
