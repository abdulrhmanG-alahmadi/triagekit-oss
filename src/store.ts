import { SQL } from "bun";
import assert from "node:assert/strict";
import type {
  Category,
  Classification,
  Priority,
  RunSchema,
  TicketInput,
  TicketSchema,
  TicketStatusSchema,
} from "./domain";

export type StoreErrorCode =
  | "ticket_conflict"
  | "ticket_not_found"
  | "run_conflict"
  | "classification_pending"
  | "classification_changed"
  | "invalid_cursor";
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode) {
    super(code);
    this.name = "StoreError";
  }
}

export type Ticket = typeof TicketSchema.static;
export type ClassificationRun = typeof RunSchema.static;
type TicketStatus = typeof TicketStatusSchema.static;
type Outcome = Pick<
  Ticket,
  "status" | "classification" | "failure" | "attempts"
>;
export type Job = TicketInput & {
  attempts: number;
  attemptToken: string;
  lastErrorCode: string | null;
};
type ClassificationRow = {
  category: Category;
  priority: Priority;
  summary: string;
  model: string;
  prompt_version: string;
  classified_at: Date;
};
type Row = TicketInput & {
  sequence: bigint;
  classification_run_id: string;
  created_at: Date;
  updated_at: Date;
  last_error_code: string | null;
  attempts: number;
  attempt_token: string | null;
} & ( // Mirrors the database's classification_consistency and failure_consistency constraints.
    | ({ status: "classified"; failure_code: null } & ClassificationRow)
    | ((
        | { status: "pending"; failure_code: null }
        | { status: "failed"; failure_code: string }
      ) & {
        [Key in keyof ClassificationRow]: null;
      })
  );
type RunRow = Row & {
  run_id: string;
  run_sequence: bigint;
  previous_run_id: string | null;
  requested_at: Date;
  requested_by: string | null;
  snapshot: Outcome | null;
};
type ListOptions = {
  limit: number;
  status?: TicketStatus;
  category?: Category;
  priority?: Priority;
  promptVersion?: string;
  cursor?: string;
  ticketId?: string;
};

// Bump when adding a migration; readiness fails until the newest schema is applied.
export const LATEST_MIGRATION = "002_classification_runs.sql";

function ticketFromRow(row: Row): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    status: row.status,
    classificationRunId: row.classification_run_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    classification:
      row.status === "classified"
        ? {
            category: row.category,
            priority: row.priority,
            summary: row.summary,
            model: row.model,
            promptVersion: row.prompt_version,
            classifiedAt: row.classified_at.toISOString(),
          }
        : null,
    failure: row.status === "failed" ? { code: row.failure_code } : null,
  };
}

function cursorSequence(options: ListOptions): string | null {
  if (!options.cursor) return null;
  try {
    if (options.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(options.cursor))
      throw new Error();
    const cursor = JSON.parse(
      Buffer.from(options.cursor, "base64url").toString(),
    );
    if (
      cursor.v !== 1 ||
      typeof cursor.sequence !== "string" ||
      !/^[1-9]\d{0,18}$/.test(cursor.sequence) ||
      BigInt(cursor.sequence) > 9223372036854775807n ||
      cursor.status !== (options.status ?? null) ||
      cursor.category !== (options.category ?? null) ||
      cursor.priority !== (options.priority ?? null) ||
      cursor.promptVersion !== (options.promptVersion ?? null) ||
      (cursor.ticketId ?? null) !== (options.ticketId ?? null)
    )
      throw new Error();
    return cursor.sequence;
  } catch {
    throw new StoreError("invalid_cursor");
  }
}

function pageCursor(sequence: bigint, options: ListOptions): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      sequence: String(sequence),
      status: options.status ?? null,
      category: options.category ?? null,
      priority: options.priority ?? null,
      promptVersion: options.promptVersion ?? null,
      ticketId: options.ticketId ?? null,
    }),
  ).toString("base64url");
}

function outcomeFromRow(row: Row): Outcome {
  const { status, classification, failure, attempts } = ticketFromRow(row);
  return { status, classification, failure, attempts };
}

function runFromRow(row: RunRow): ClassificationRun {
  return {
    id: row.run_id,
    ticketId: row.id,
    previousRunId: row.previous_run_id,
    requestedAt: row.requested_at.toISOString(),
    requestedBy: row.requested_by,
    ...(row.snapshot ?? outcomeFromRow(row)),
  };
}

export class Store {
  constructor(readonly sql: SQL) {}

  async ingest(
    input: TicketInput,
  ): Promise<{ created: boolean; ticket: Ticket }> {
    // The row is the queue entry, so a successful insert cannot lose its job.
    const rows: Row[] = await this.sql`WITH inserted AS (
      INSERT INTO tickets (id, subject, body)
      VALUES (${input.id}, ${input.subject}, ${input.body}) ON CONFLICT (id) DO NOTHING RETURNING *
    ), initial_run AS (
      INSERT INTO classification_runs (id, ticket_id, requested_at)
      SELECT classification_run_id, id, created_at FROM inserted
    ) SELECT * FROM inserted`;
    if (rows[0]) return { created: true, ticket: ticketFromRow(rows[0]) };
    const existing = await this.get(input.id);
    if (
      !existing ||
      existing.subject !== input.subject ||
      existing.body !== input.body
    )
      throw new StoreError("ticket_conflict");
    return { created: false, ticket: existing };
  }

  async get(id: string): Promise<Ticket | null> {
    const rows: Row[] = await this.sql`SELECT * FROM tickets WHERE id = ${id}`;
    return rows[0] ? ticketFromRow(rows[0]) : null;
  }

  async list(
    options: ListOptions,
  ): Promise<{ items: Ticket[]; nextCursor: string | null }> {
    const sequence = cursorSequence(options);
    // Category and priority describe a classification, so they imply that status.
    const status =
      options.status ??
      (options.category || options.priority ? "classified" : null);
    const rows: Row[] = await this.sql`SELECT * FROM tickets
      WHERE (${status}::text IS NULL OR status = ${status})
        AND (${options.category ?? null}::text IS NULL OR category = ${options.category ?? null})
        AND (${options.priority ?? null}::text IS NULL OR priority = ${options.priority ?? null})
        AND (${options.promptVersion ?? null}::text IS NULL OR prompt_version = ${options.promptVersion ?? null})
        AND (${sequence}::bigint IS NULL OR sequence < ${sequence}::bigint)
      ORDER BY sequence DESC LIMIT ${options.limit + 1}`;
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map(ticketFromRow),
      nextCursor:
        rows.length > options.limit && last
          ? pageCursor(last.sequence, options)
          : null,
    };
  }

  async getRun(
    ticketId: string,
    runId: string,
  ): Promise<ClassificationRun | null> {
    const rows: RunRow[] = await this
      .sql`SELECT t.*, r.id AS run_id, r.sequence AS run_sequence,
      r.previous_run_id, r.requested_at, r.requested_by, r.snapshot
      FROM classification_runs r JOIN tickets t ON t.id = r.ticket_id
      WHERE r.ticket_id = ${ticketId} AND r.id = ${runId}::uuid`;
    return rows[0] ? runFromRow(rows[0]) : null;
  }

  async listRuns(
    ticketId: string,
    options: Pick<ListOptions, "limit" | "cursor">,
  ) {
    const scoped = { ...options, ticketId };
    const sequence = cursorSequence(scoped);
    const rows: RunRow[] = await this
      .sql`SELECT t.*, r.id AS run_id, r.sequence AS run_sequence,
      r.previous_run_id, r.requested_at, r.requested_by, r.snapshot
      FROM classification_runs r JOIN tickets t ON t.id = r.ticket_id
      WHERE r.ticket_id = ${ticketId} AND (${sequence}::bigint IS NULL OR r.sequence < ${sequence}::bigint)
      ORDER BY r.sequence DESC LIMIT ${options.limit + 1}`;
    const page = rows.slice(0, options.limit);
    const last = page.at(-1);
    return {
      items: page.map(runFromRow),
      nextCursor:
        rows.length > options.limit && last
          ? pageCursor(last.run_sequence, scoped)
          : null,
    };
  }

  async requestRun(
    ticketId: string,
    runId: string,
    previousRunId: string,
    principal: string,
  ): Promise<{ created: boolean; run: ClassificationRun }> {
    let created: boolean;
    try {
      created = await this.sql.begin(async (tx) => {
        // Serialize transitions per ticket; model calls never hold this lock.
        const [ticket]: Row[] =
          await tx`SELECT * FROM tickets WHERE id = ${ticketId} FOR UPDATE`;
        if (!ticket) throw new StoreError("ticket_not_found");
        const [existing] =
          await tx`SELECT ticket_id, previous_run_id FROM classification_runs WHERE id = ${runId}::uuid`;
        if (existing) {
          if (
            existing.ticket_id !== ticketId ||
            existing.previous_run_id !== previousRunId.toLowerCase()
          )
            throw new StoreError("run_conflict");
          return false;
        }
        if (ticket.status === "pending")
          throw new StoreError("classification_pending");
        if (ticket.classification_run_id !== previousRunId.toLowerCase())
          throw new StoreError("classification_changed");
        await tx`UPDATE classification_runs SET snapshot = ${outcomeFromRow(ticket)}::jsonb
          WHERE id = ${ticket.classification_run_id}::uuid`;
        await tx`INSERT INTO classification_runs (id, ticket_id, previous_run_id, requested_by)
          VALUES (${runId}::uuid, ${ticketId}, ${previousRunId}::uuid, ${principal})`;
        await tx`UPDATE tickets SET classification_run_id = ${runId}::uuid, status = 'pending', attempts = 0,
          category = NULL, priority = NULL, summary = NULL, model = NULL, prompt_version = NULL,
          classified_at = NULL, failure_code = NULL, last_error_code = NULL, attempt_token = NULL,
          lease_until = NULL, available_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE id = ${ticketId}`;
        return true;
      });
    } catch (error) {
      // A run UUID racing across different tickets must still have one owner.
      if (error instanceof SQL.PostgresError && error.errno === "23505")
        throw new StoreError("run_conflict");
      throw error;
    }
    const run = await this.getRun(ticketId, runId);
    assert(run, "Classification run must exist after scheduling");
    return { created, run };
  }

  async claim(maxAttempts: number, leaseMs: number): Promise<Job | null> {
    return this.sql.begin(async (tx) => {
      // Also terminalize a crash during the final attempt; it must not stay pending forever.
      await tx`WITH exhausted AS (
        SELECT id FROM tickets WHERE status = 'pending' AND attempts >= ${maxAttempts}
          AND (lease_until IS NULL OR lease_until <= statement_timestamp())
        LIMIT 100 FOR UPDATE SKIP LOCKED
      ) UPDATE tickets SET status = 'failed', failure_code = 'attempts_exhausted',
        attempt_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
        FROM exhausted WHERE tickets.id = exhausted.id`;
      const attemptToken = crypto.randomUUID();
      const rows: Row[] = await tx`WITH candidate AS (
        SELECT id FROM tickets WHERE status = 'pending' AND attempts < ${maxAttempts}
          AND available_at <= statement_timestamp() AND (lease_until IS NULL OR lease_until <= statement_timestamp())
        ORDER BY available_at, sequence FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE tickets SET attempts = attempts + 1, attempt_token = ${attemptToken}::uuid,
        lease_until = statement_timestamp() + ${leaseMs} * interval '1 millisecond',
        available_at = statement_timestamp() + ${leaseMs} * interval '1 millisecond', updated_at = clock_timestamp()
        FROM candidate WHERE tickets.id = candidate.id RETURNING tickets.*`;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            subject: row.subject,
            body: row.body,
            attempts: row.attempts,
            attemptToken,
            lastErrorCode: row.last_error_code,
          }
        : null;
    });
  }

  async complete(
    job: Job,
    result: Classification,
    model: string,
    promptVersion: string,
  ): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      // Check expiry after acquiring the lock, including time spent waiting for it.
      await tx`SELECT id FROM tickets WHERE id = ${job.id} FOR UPDATE`;
      const rows =
        await tx`UPDATE tickets SET status = 'classified', category = ${result.category},
        priority = ${result.priority}, summary = ${result.summary}, model = ${model}, prompt_version = ${promptVersion},
        classified_at = clock_timestamp(), updated_at = clock_timestamp(), attempt_token = NULL, lease_until = NULL,
        last_error_code = NULL WHERE id = ${job.id} AND status = 'pending' AND attempt_token = ${job.attemptToken}::uuid
        AND lease_until > clock_timestamp() RETURNING id`;
      return rows.length === 1;
    });
  }

  async fail(
    job: Job,
    code: string,
    retryable: boolean,
    maxAttempts: number,
    delayMs: number,
  ): Promise<boolean> {
    const terminal = !retryable || job.attempts >= maxAttempts;
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM tickets WHERE id = ${job.id} FOR UPDATE`;
      const rows =
        await tx`UPDATE tickets SET status = ${terminal ? "failed" : "pending"},
        failure_code = ${terminal ? code : null}, last_error_code = ${code},
        available_at = clock_timestamp() + ${delayMs} * interval '1 millisecond', updated_at = clock_timestamp(),
        attempt_token = NULL, lease_until = NULL
        WHERE id = ${job.id} AND status = 'pending' AND attempt_token = ${job.attemptToken}::uuid
        AND lease_until > clock_timestamp() RETURNING id`;
      return rows.length === 1;
    });
  }

  async allowRequest(principal: string, limit: number): Promise<boolean> {
    const rows = await this
      .sql`INSERT INTO rate_limits (principal, window_start, requests)
      VALUES (${principal}, date_trunc('minute', clock_timestamp()), 1)
      ON CONFLICT (principal) DO UPDATE SET
        requests = CASE WHEN rate_limits.window_start < EXCLUDED.window_start THEN 1 ELSE rate_limits.requests + 1 END,
        window_start = GREATEST(rate_limits.window_start, EXCLUDED.window_start)
      WHERE rate_limits.window_start < EXCLUDED.window_start OR rate_limits.requests < ${limit}
      RETURNING requests`;
    return rows.length === 1;
  }

  async ready(): Promise<boolean> {
    const rows = await this
      .sql`SELECT name FROM schema_migrations WHERE name = ${LATEST_MIGRATION}`;
    return rows.length === 1;
  }

  async operations() {
    const [row] = await this.sql`SELECT
      count(*) FILTER (WHERE status = 'pending')::integer AS pending,
      count(*) FILTER (WHERE status = 'classified')::integer AS classified,
      count(*) FILTER (WHERE status = 'failed')::integer AS failed,
      count(*) FILTER (WHERE lease_until > clock_timestamp())::integer AS in_flight,
      coalesce(extract(epoch FROM clock_timestamp() - min(r.requested_at) FILTER (WHERE status = 'pending')), 0)::double precision AS oldest_pending_seconds
      FROM tickets t JOIN classification_runs r ON r.id = t.classification_run_id`;
    return {
      pending: row.pending,
      classified: row.classified,
      failed: row.failed,
      inFlight: row.in_flight,
      oldestPendingSeconds: row.oldest_pending_seconds,
    };
  }
}
