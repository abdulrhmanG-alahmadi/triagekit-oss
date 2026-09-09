import { SQL } from "bun";
import { parseArgs } from "node:util";
import { connectDatabase, databaseSslMode } from "./database";

const usage = `Usage: bun src/retention.ts --before YYYY-MM-DDTHH:mm:ss[.sss]Z [--id TICKET_ID] [--batch-size 1..1000] [--apply]
Requires MAINTENANCE_DATABASE_URL; never uses DATABASE_URL.
Dry-run by default. One batch (default 100) of unlocked classified/failed tickets with updated_at strictly before the UTC cutoff.
Apply permanently removes ticket content, all run history and deduplication. Erased ticket/run IDs can be reused. Pending work is never erased.`;

export function parseRetentionArgs(args: string[]) {
  const { values, tokens } = parseArgs({
    args,
    options: {
      before: { type: "string" },
      id: { type: "string" },
      "batch-size": { type: "string", default: "100" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error(`Duplicate --${token.name}`);
    seen.add(token.name);
  }
  const before = values.before;
  const date = new Date(before ?? "");
  if (
    !before ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(before) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().replace(".000Z", "Z") !== before.replace(".000Z", "Z")
  )
    throw new Error(
      "--before requires a valid UTC ISO timestamp (seconds or milliseconds, ending in Z)",
    );
  const batchSize = Number(values["batch-size"]);
  if (!/^[1-9]\d*$/.test(values["batch-size"]) || batchSize > 1000)
    throw new Error("--batch-size must be an integer from 1 to 1000");
  if (
    values.id !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.id)
  )
    throw new Error("--id must be a valid ticket ID");
  return {
    before: date.toISOString(),
    apply: values.apply,
    batchSize,
    ...(values.id === undefined ? {} : { id: values.id }),
  };
}

export async function purgeTickets(
  sql: SQL,
  options: ReturnType<typeof parseRetentionArgs>,
) {
  return sql.begin(async (tx) => {
    const tickets: { id: string }[] = await tx`SELECT id FROM tickets
      WHERE status IN ('classified', 'failed') AND updated_at < ${options.before}::timestamptz
        AND (${options.id ?? null}::text IS NULL OR id = ${options.id ?? null})
      ORDER BY sequence LIMIT ${options.batchSize} FOR UPDATE SKIP LOCKED`;
    const ticketIds = tickets.map((ticket) => ticket.id);
    const ids = sql.array(ticketIds, "TEXT");
    const [history] =
      await tx`SELECT count(*)::integer AS count FROM classification_runs
      WHERE ticket_id = ANY(${ids})`;
    if (options.apply && ticketIds.length) {
      // Delete the whole chain in one statement; the current-run FK is deferred until commit.
      await tx`SET CONSTRAINTS tickets_current_run DEFERRED`;
      await tx`DELETE FROM classification_runs WHERE ticket_id = ANY(${ids})`;
      await tx`DELETE FROM tickets WHERE id = ANY(${ids})`;
    }
    return { ...options, ticketIds, runCount: history.count as number };
  });
}

if (import.meta.main) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    let sql: SQL | undefined;
    let validated = false;
    try {
      const options = parseRetentionArgs(process.argv.slice(2));
      const url = process.env.MAINTENANCE_DATABASE_URL;
      if (!url) throw new Error("MAINTENANCE_DATABASE_URL is required");
      const ssl = databaseSslMode(process.env);
      validated = true;
      sql = connectDatabase(url, 1, ssl);
      console.log(JSON.stringify(await purgeTickets(sql, options)));
    } catch (error) {
      console.error(
        validated
          ? `Retention failed: ${error instanceof SQL.PostgresError ? error.errno : "database_error"}`
          : `${error instanceof Error ? error.message : "Invalid retention arguments"}\n${usage}`,
      );
      process.exitCode = 1;
    } finally {
      await sql?.close();
    }
  }
}
