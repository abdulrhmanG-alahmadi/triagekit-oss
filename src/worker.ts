import { connectDatabase } from "./database";
import { SQL } from "bun";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";
import {
  createClassifier,
  ModelError,
  PROMPT_VERSION,
  type Classify,
} from "./classifier";
import {
  InvalidClassificationError,
  parseClassification,
  type Classification,
} from "./domain";
import { readConfig, type Config } from "./config";
import { Store, type Job } from "./store";
import { createLogger, type Log } from "./log";
import { createTelemetry, inSpan } from "./telemetry";

const log = createLogger("triagekit-worker");

async function pause(ms: number, signal: AbortSignal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export async function processJob(
  store: Store,
  job: Job,
  classify: Classify,
  config: Config,
  logger: Log = log,
  tracer: Tracer = trace.getTracer("triagekit-worker"),
) {
  return inSpan(
    tracer,
    "classification.process",
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "classification.attempt": job.attempts,
        "classification.provider": config.provider,
        "classification.prompt_version": PROMPT_VERSION,
      },
    },
    async (span) => {
      const started = performance.now();
      let result: Classification, model: string;
      try {
        ({ result, model } = await inSpan(
          tracer,
          "classification.inference",
          {},
          async () => {
            const response = await classify(
              { id: job.id, subject: job.subject, body: job.body },
              AbortSignal.timeout(config.modelTimeoutMs),
              job.attempts,
              job.lastErrorCode,
            );
            return {
              result: parseClassification(response.text),
              model: response.model,
            };
          },
          span,
        ));
      } catch (error) {
        const unexpected =
          !(error instanceof ModelError) &&
          !(error instanceof InvalidClassificationError);
        const failure =
          error instanceof ModelError
            ? error
            : new ModelError(
                unexpected ? "unexpected_error" : "invalid_model_output",
                true,
              );
        const backoff = Math.min(
          60_000,
          config.retryBaseMs * 2 ** (job.attempts - 1) * (0.5 + Math.random()),
        );
        const delayMs = Math.round(
          Math.max(backoff, Math.min(60_000, failure.retryAfterMs ?? 0)),
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.setAttribute("error.type", failure.code);
        const accepted = await inSpan(
          tracer,
          "classification.persist_failure",
          {},
          () =>
            store.fail(
              job,
              failure.code,
              failure.retryable,
              config.maxAttempts,
              delayMs,
            ),
          span,
        );
        logger({
          event: "classification_attempt_failed",
          level: unexpected ? "error" : "warn",
          attempt: job.attempts,
          code: failure.code,
          accepted,
          durationMs: Math.round(performance.now() - started),
        });
        return;
      }
      // Retry contention once with the existing result; persistent failures retain the lease for recovery.
      const complete = () =>
        inSpan(
          tracer,
          "classification.persist_result",
          {},
          () => store.complete(job, result, model, PROMPT_VERSION),
          span,
        );
      const accepted = await complete().catch((error: unknown) => {
        if (
          !(error instanceof SQL.PostgresError) ||
          !["55P03", "40P01", "40001"].includes(error.errno ?? "")
        )
          throw error;
        return complete();
      });
      logger({
        event: "classification_completed",
        attempt: job.attempts,
        accepted,
        durationMs: Math.round(performance.now() - started),
      });
    },
  );
}

export async function runWorker(
  store: Store,
  classify: Classify,
  config: Config,
  stop: AbortSignal,
  logger: Log = log,
  tracer: Tracer = trace.getTracer("triagekit-worker"),
) {
  const failed = new AbortController();
  const stopping = AbortSignal.any([stop, failed.signal]);
  const slot = async () => {
    while (!stopping.aborted) {
      try {
        const job = await store.claim(config.maxAttempts, config.leaseMs);
        if (job) await processJob(store, job, classify, config, logger, tracer);
        else await pause(config.pollIntervalMs, stopping);
      } catch (error) {
        const postgres = error instanceof SQL.PostgresError;
        const sqlstate =
          postgres && /^[0-9A-Z]{5}$/.test(error.errno ?? "")
            ? error.errno
            : undefined;
        const driverCode =
          postgres && /^ERR_POSTGRES_[A-Z_]{1,64}$/.test(error.code)
            ? error.code
            : undefined;
        const retryable = sqlstate
          ? /^(08|40|53)/.test(sqlstate) ||
            ["55P03", "57014", "57P01", "57P02", "57P03"].includes(sqlstate)
          : [
              "ERR_POSTGRES_CONNECTION_CLOSED",
              "ERR_POSTGRES_CONNECTION_FAILED",
              "ERR_POSTGRES_CONNECTION_REFUSED",
              "ERR_POSTGRES_CONNECTION_TIMEOUT",
              "ERR_POSTGRES_IDLE_TIMEOUT",
              "ERR_POSTGRES_LIFETIME_TIMEOUT",
              "ERR_POSTGRES_QUERY_CANCELLED",
            ].includes(driverCode ?? "");
        logger({
          event: "worker_slot_error",
          level: "error",
          code: sqlstate ?? driverCode ?? "unexpected_error",
          errorClass: postgres
            ? "PostgresError"
            : error instanceof Error
              ? "Error"
              : "UnknownError",
          retryable,
        });
        if (!retryable) {
          failed.abort();
          throw new Error("worker_fatal_error");
        }
        await pause(Math.max(config.pollIntervalMs, 1_000), stopping);
      }
    }
  };
  // Wait for every claimed job before surfacing a fatal slot error to shutdown.
  const results = await Promise.allSettled(
    Array.from({ length: config.concurrency }, slot),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

if (import.meta.main) {
  const config = readConfig(process.env, "worker");
  const telemetry = createTelemetry(
    "triagekit-worker",
    config.telemetryEndpoint,
  );
  const sql = connectDatabase(
    config.databaseUrl,
    config.concurrency + 2,
    config.databaseSsl,
  );
  const store = new Store(sql);
  const classify = createClassifier({
    mode: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.modelTimeoutMs,
  });
  const stop = new AbortController();
  let deadline: Timer | undefined;
  const shutdown = () => {
    if (stop.signal.aborted) return;
    log({ event: "worker_stopping" });
    stop.abort();
    deadline = setTimeout(
      () => process.exit(1),
      config.modelTimeoutMs + 20_000,
    );
    deadline.unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log({
    event: "worker_started",
    concurrency: config.concurrency,
    provider: config.provider,
  });
  try {
    await runWorker(
      store,
      classify,
      config,
      stop.signal,
      log,
      telemetry.tracer,
    );
  } catch {
    log({ event: "worker_failed", level: "error" });
    process.exitCode = 1;
  } finally {
    const results = await Promise.allSettled([
      sql.close({ timeout: 5 }),
      telemetry.shutdown(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      log({ event: "worker_shutdown_failed", level: "error" });
      process.exitCode = 1;
    }
    if (deadline) clearTimeout(deadline);
  }
}
