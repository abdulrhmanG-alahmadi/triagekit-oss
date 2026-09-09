import { SQL } from "bun";
import { t, ValidationError } from "elysia";
import { StoreError, type StoreErrorCode } from "./store";

export const ProblemSchema = t.Object({
  type: t.String(),
  title: t.String(),
  status: t.Integer(),
  detail: t.String(),
  instance: t.String(),
  code: t.String(),
  requestId: t.String(),
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function readJsonBody(request: Request, timeoutMs = 10_000) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Use Content-Type: application/json.",
    );
  const timeout = new AbortController();
  const deadline = setTimeout(
    () =>
      timeout.abort(
        new HttpError(408, "request_timeout", "Request body read timed out."),
      ),
    timeoutMs,
  );
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    // Bun bounds size; pipeTo cancels and unlocks the reader on timeout or disconnect.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    await request.body?.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          text += decoder.decode(chunk, { stream: true });
        },
      }),
      { signal },
    );
    return JSON.parse(text + decoder.decode());
  } catch {
    if (signal.reason instanceof HttpError) throw signal.reason;
    throw new HttpError(
      400,
      "invalid_json",
      "Request body must be valid UTF-8 JSON.",
    );
  } finally {
    clearTimeout(deadline);
  }
}

const titles: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

// `satisfies` keeps a new StoreErrorCode from reaching the wire without a status.
const storeProblems = {
  ticket_conflict: {
    status: 409,
    detail: "This ticket ID already exists with different content.",
  },
  ticket_not_found: {
    status: 404,
    detail: "The requested ticket was not found.",
  },
  run_conflict: {
    status: 409,
    detail:
      "This run ID already exists with a different ticket or previous run.",
  },
  classification_pending: {
    status: 409,
    detail: "The current classification is still pending.",
  },
  classification_changed: {
    status: 409,
    detail:
      "The current classification run has changed; read the ticket before retrying.",
  },
  invalid_cursor: {
    status: 400,
    detail: "The cursor is invalid or does not match the filters.",
  },
} satisfies Record<StoreErrorCode, { status: number; detail: string }>;

const problem = (status: number, code: string, detail: string) => ({
  status,
  title: titles[status] ?? "Error",
  code,
  detail,
});

export function problemFor(thrown: unknown, elysiaCode?: string | number) {
  // Elysia rethrows hook failures wrapped, so the original status survives as the cause.
  const error =
    thrown instanceof Error && thrown.cause instanceof HttpError
      ? thrown.cause
      : thrown;
  if (error instanceof HttpError)
    return problem(error.status, error.code, error.message);
  if (error instanceof StoreError)
    return problem(
      storeProblems[error.code].status,
      error.code,
      storeProblems[error.code].detail,
    );
  if (
    elysiaCode === "VALIDATION" &&
    !(error instanceof ValidationError && error.type === "response")
  )
    return problem(
      422,
      "validation_error",
      "The request does not match the documented schema.",
    );
  if (elysiaCode === "PARSE")
    return problem(400, "invalid_json", "Request body must be valid JSON.");
  if (elysiaCode === "NOT_FOUND")
    return problem(404, "not_found", "The requested resource was not found.");
  if (error instanceof SQL.PostgresError)
    return problem(
      503,
      "database_unavailable",
      "The service is temporarily unavailable.",
    );
  return problem(500, "internal_error", "An unexpected error occurred.");
}
