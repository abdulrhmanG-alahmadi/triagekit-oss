import { SQL } from "bun";
import { migrate } from "../src/migrate";

// Every integration file shares one disposable database; Bun runs files serially.
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test"))
    throw new Error(
      "TEST_DATABASE_URL must name a dedicated database ending in _test",
    );
  return url;
}

export function connectTestDatabase(max = 8): SQL {
  return new SQL(testDatabaseUrl(), { max });
}

export async function prepareDatabase(sql: SQL) {
  await migrate(sql);
}

export async function resetTables(sql: SQL) {
  await sql`TRUNCATE classification_runs, tickets, rate_limits RESTART IDENTITY CASCADE`;
}
