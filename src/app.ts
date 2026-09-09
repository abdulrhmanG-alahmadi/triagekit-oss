import { Elysia, t, type DocumentDecoration } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { serverTiming } from "@elysiajs/server-timing";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  ClassificationSchema,
  RunSchema,
  TicketInputSchema,
  TicketSchema,
  TicketStatusSchema,
} from "./domain";
import { apiKeyPattern, type Config } from "./config";
import { HttpError, ProblemSchema, problemFor, readJsonBody } from "./http";
import type { Store } from "./store";
import { createLogger, type Log } from "./log";

const maxBodyBytes = 128 * 1024;
const RunParams = t.Object({
  id: TicketInputSchema.properties.id,
  runId: t.String({ format: "uuid" }),
});
const PageQuery = {
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
  cursor: t.Optional(t.String({ maxLength: 512 })),
};
const errors = {
  400: ProblemSchema,
  401: ProblemSchema,
  404: ProblemSchema,
  408: ProblemSchema,
  409: ProblemSchema,
  413: ProblemSchema,
  415: ProblemSchema,
  422: ProblemSchema,
  429: ProblemSchema,
  500: ProblemSchema,
  503: ProblemSchema,
};

export function createApp(
  config: Config,
  store: Store,
  logger: Log = createLogger("triagekit-api"),
  tracer: Tracer = trace.getTracer("triagekit-api"),
) {
  const keys = config.apiKeys.map((key) =>
    createHash("sha256").update(key).digest(),
  );
  // Docs are readable without a credential outside production so the API explains itself.
  const isPublic = (method: string, path: string) =>
    method === "GET" &&
    (path === "/health/live" ||
      path === "/health/ready" ||
      (!config.production &&
        (path === "/openapi" || path === "/openapi/json")));
  return new Elysia({ normalize: false })
    .use(serverTiming({ enabled: !config.production }))
    .macro({ problemResponses: { response: errors } })
    .decorate({
      requestId: "",
      requestStartedAt: 0,
      credentialFingerprint: "",
      requestSpan: undefined as Span | undefined,
    })
    .onRequest(async (context) => {
      const { request, set } = context;
      context.requestId = crypto.randomUUID();
      context.requestStartedAt = performance.now();
      context.requestSpan = tracer.startSpan(
        "HTTP request",
        { kind: SpanKind.SERVER },
        ROOT_CONTEXT,
      );
      set.headers["x-request-id"] = context.requestId;
      set.headers["x-content-type-options"] = "nosniff";
      set.headers["cache-control"] = "no-store";
      if (isPublic(request.method, new URL(request.url).pathname)) return;
      const token = /^Bearer (.+)$/i.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      const hash =
        token && apiKeyPattern.test(token)
          ? createHash("sha256").update(token).digest()
          : null;
      if (!hash || !keys.some((key) => timingSafeEqual(key, hash))) {
        set.headers["www-authenticate"] = "Bearer";
        throw new HttpError(
          401,
          "unauthorized",
          "A valid bearer credential is required.",
        );
      }
      context.credentialFingerprint = hash.toString("hex");
      let allowed: boolean;
      try {
        allowed = await store.allowRequest(
          context.credentialFingerprint,
          config.rateLimitPerMinute,
        );
      } catch {
        throw new HttpError(
          503,
          "database_unavailable",
          "The service is temporarily unavailable.",
        );
      }
      if (!allowed) {
        set.headers["retry-after"] = String(
          60 - (Math.floor(Date.now() / 1000) % 60),
        );
        throw new HttpError(
          429,
          "rate_limited",
          "Request rate exceeded; retry after the indicated delay.",
        );
      }
    })
    .resolve(({ credentialFingerprint }) => ({
      principal: credentialFingerprint,
    }))
    .onParse(({ request }) => readJsonBody(request))
    .onError(({ error, code, request, set, requestId, requestSpan }) => {
      const problem = problemFor(error, code);
      if (problem.status >= 500)
        logger({
          event: "request_failed",
          level: "error",
          code: problem.code,
          requestId,
        });
      set.status = problem.status;
      requestSpan?.setAttribute("error.type", problem.code);
      return new Response(
        JSON.stringify({
          type: "about:blank",
          ...problem,
          instance: new URL(request.url).pathname,
          requestId,
        }),
        {
          status: problem.status,
          headers: { "content-type": "application/problem+json" },
        },
      );
    })
    .onAfterResponse(
      ({ request, route, set, requestId, requestStartedAt, requestSpan }) => {
        requestSpan?.updateName(`${request.method} ${route || "unmatched"}`);
        requestSpan?.setAttributes({
          "http.request.method": request.method,
          "http.route": route || "unmatched",
          "http.response.status_code": Number(set.status ?? 200),
          "request.id": requestId,
        });
        if (Number(set.status ?? 200) >= 500)
          requestSpan?.setStatus({ code: SpanStatusCode.ERROR });
        requestSpan?.end();
        logger({
          event: "http_request",
          requestId,
          method: request.method,
          route: route || "unmatched",
          status: set.status ?? 200,
          durationMs: Math.round(performance.now() - requestStartedAt),
        });
      },
    )
    .onAfterHandle(({ path, response }) => {
      if (path !== "/openapi/json") return;
      // ponytail: plugin 1.4.16 overrides detail.responses; remove when it supports response media types.
      const { paths } = response as {
        paths: Record<string, Record<string, DocumentDecoration>>;
      };
      for (const routes of Object.values(paths))
        for (const operation of Object.values(routes)) {
          const responses = operation.responses;
          if (!responses) continue;
          for (const [status, result] of Object.entries(responses)) {
            if (status === "413") {
              responses[status] = {
                description:
                  "Bun rejects bodies over 128 KiB before the application runs; no problem document or request ID is returned.",
              };
            } else if (
              Number(status) >= 400 &&
              "content" in result &&
              result.content?.["application/json"]
            ) {
              result.content = {
                "application/problem+json": result.content["application/json"],
              };
            }
          }
        }
    })
    .use(
      openapi({
        documentation: {
          info: {
            title: "TriageKit API",
            version: "1.0.0",
            description:
              "Durable asynchronous ticket classification for one support organization.",
          },
          components: {
            securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
          },
          security: [{ bearerAuth: [] }],
        },
      }),
    )
    .get("/health/live", () => ({ status: "ok" }), {
      detail: { security: [], tags: ["Operations"] },
    })
    .get(
      "/health/ready",
      async () => {
        try {
          if (await store.ready()) return { status: "ready" };
        } catch {
          /* Return a safe readiness failure. */
        }
        throw new HttpError(
          503,
          "not_ready",
          "The database or schema is not ready.",
        );
      },
      {
        detail: { security: [], tags: ["Operations"] },
        response: { 200: t.Object({ status: t.String() }), 503: ProblemSchema },
      },
    )
    .post(
      "/api/v1/tickets",
      async ({ body, set }) => {
        const result = await store.ingest(body);
        set.status = result.created ? 201 : 200;
        set.headers.location = `/api/v1/tickets/${result.ticket.id}`;
        return result.ticket;
      },
      {
        parse: "json",
        body: TicketInputSchema,
        problemResponses: true,
        response: { 200: TicketSchema, 201: TicketSchema },
        detail: {
          tags: ["Tickets"],
          summary: "Ingest a ticket",
          description:
            "Creates a durable pending ticket. Identical retries return the existing ticket; changed content for the same ID returns 409. No classification runs in this request.",
        },
      },
    )
    .get(
      "/api/v1/tickets",
      ({ query }) => store.list({ ...query, limit: query.limit ?? 20 }),
      {
        query: t.Object(
          {
            ...PageQuery,
            status: t.Optional(TicketStatusSchema),
            category: t.Optional(ClassificationSchema.properties.category),
            priority: t.Optional(ClassificationSchema.properties.priority),
            promptVersion: t.Optional(
              t.String({
                maxLength: 128,
                pattern: TicketInputSchema.properties.subject.pattern,
              }),
            ),
          },
          { additionalProperties: false },
        ),
        problemResponses: true,
        response: {
          200: t.Object({
            items: t.Array(TicketSchema),
            nextCursor: t.Nullable(t.String()),
          }),
        },
        detail: {
          tags: ["Tickets"],
          summary: "List tickets",
          description:
            "Newest first. Pass nextCursor as cursor with the same filters. Category and priority imply status=classified unless status is given; promptVersion selects the prompt that produced the classification.",
        },
      },
    )
    .get(
      "/api/v1/tickets/:id",
      async ({ params }) => {
        const ticket = await store.get(params.id);
        if (!ticket)
          throw new HttpError(
            404,
            "ticket_not_found",
            "The requested ticket was not found.",
          );
        return ticket;
      },
      {
        params: t.Object({ id: TicketInputSchema.properties.id }),
        problemResponses: true,
        response: { 200: TicketSchema },
        detail: { tags: ["Tickets"], summary: "Get a ticket" },
      },
    )
    .put(
      "/api/v1/tickets/:id/classification-runs/:runId",
      async ({ params, body, principal, set }) => {
        const result = await store.requestRun(
          params.id,
          params.runId,
          body.previousRunId,
          principal,
        );
        set.status = result.created ? 201 : 200;
        set.headers.location = `/api/v1/tickets/${params.id}/classification-runs/${result.run.id}`;
        return result.run;
      },
      {
        params: RunParams,
        parse: "json",
        body: t.Object(
          { previousRunId: t.String({ format: "uuid" }) },
          { additionalProperties: false },
        ),
        problemResponses: true,
        response: { 200: RunSchema, 201: RunSchema },
        detail: {
          tags: ["Classification runs"],
          summary: "Reclassify a terminal ticket",
          description:
            "Choose a new client-generated UUID and pass the ticket's current classificationRunId as previousRunId. Creates durable pending work using the worker's current model and prompt. An identical retry returns the same run, including after completion. Pending or stale transitions return 409; original outcomes remain readable.",
        },
      },
    )
    .get(
      "/api/v1/tickets/:id/classification-runs/:runId",
      async ({ params }) => {
        const run = await store.getRun(params.id, params.runId);
        if (!run)
          throw new HttpError(
            404,
            "run_not_found",
            "The requested classification run was not found.",
          );
        return run;
      },
      {
        params: RunParams,
        problemResponses: true,
        response: { 200: RunSchema },
        detail: {
          tags: ["Classification runs"],
          summary: "Get a classification run",
        },
      },
    )
    .get(
      "/api/v1/tickets/:id/classification-runs",
      async ({ params, query }) => {
        if (!(await store.get(params.id)))
          throw new HttpError(
            404,
            "ticket_not_found",
            "The requested ticket was not found.",
          );
        return store.listRuns(params.id, {
          ...query,
          limit: query.limit ?? 20,
        });
      },
      {
        params: t.Object({ id: TicketInputSchema.properties.id }),
        query: t.Object(PageQuery, { additionalProperties: false }),
        problemResponses: true,
        response: {
          200: t.Object({
            items: t.Array(RunSchema),
            nextCursor: t.Nullable(t.String()),
          }),
        },
        detail: {
          tags: ["Classification runs"],
          summary: "List classification history",
          description:
            "Newest run first, including the current run. Cursors are bound to this ticket. Archived outcomes retain model, prompt version, attempt count and failure details.",
        },
      },
    )
    .get("/api/v1/operations", () => store.operations(), {
      problemResponses: true,
      response: {
        200: t.Object({
          pending: t.Integer(),
          classified: t.Integer(),
          failed: t.Integer(),
          inFlight: t.Integer(),
          oldestPendingSeconds: t.Number(),
        }),
      },
      detail: { tags: ["Operations"], summary: "Read queue counts and age" },
    });
}

export { maxBodyBytes };
