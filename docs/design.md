# TriageKit design

TriageKit uses Bun, Elysia, PostgreSQL and OpenRouter with configurable models. It serves one support organization through bearer-authenticated service clients. Docker Compose provides the local environment. Ticket UIs and email connectors can integrate through the HTTP API.

## Contract

- `POST /api/v1/tickets`: persist `{id, subject, body}` and return `201` with `Location`. Classification happens in a separate worker. A repeated identical ticket returns `200`; conflicting content for an existing ID returns `409`. Neither changes the existing ticket or schedules work.
- `GET /api/v1/tickets/:id`: return a ticket or `404`.
- `GET /api/v1/tickets`: category/priority filters and bounded cursor pagination (default 20, maximum 100). Sort by insertion sequence descending. Filters are eventually consistent as pending tickets become classified.
- Public status is `pending`, `classified`, or `failed`. Errors use RFC 9457 Problem Details and a server-generated request ID. OpenAPI documents authentication and response schemas.
- Subject may be empty (sample t-1008). IDs are URL-safe strings up to 128 characters, subject up to 500, body 1–20,000 characters. Unknown properties are rejected. Total HTTP body is limited to 128 KiB.

## Durability

The ticket row is also the durable job: accepting work and queueing it are one transaction. PostgreSQL uniqueness protects concurrent duplicate submissions. Workers claim one eligible row per available slot with `FOR UPDATE SKIP LOCKED`, increment attempts, and assign an attempt UUID plus an expiring lease. No database transaction spans the model call.

All completions and reschedules require the current attempt UUID and an unexpired lease. Crashed work is reclaimed; an expired final attempt becomes failed. Default concurrency is four per worker, three total attempts, 30-second model timeout, and a 60-second lease. Transient failures and invalid output retry with capped exponential backoff and jitter; permanent provider failures terminate. Shutdown stops claiming, drains bounded in-flight requests, then closes connections.

Duplicate ingestion never reclassifies. Crash recovery is at-least-once external inference with fenced result publication; exactly-once model execution cannot be guaranteed after an ambiguous network failure.

## Model boundary

OpenRouter uses native `fetch`, strict JSON Schema response format, and `provider.require_parameters`. Model ID is configuration. Live mode requires a key/model and never falls back to a fake. Fake mode runs offline and can produce deterministic invalid/transient responses for tests. Both modes return text to the same strict application validator before persistence.

Ticket text is untrusted user-role data. The system prompt defines classification, ignores embedded instructions, and grants no tools. Only allowed enums and a nonempty single-line summary up to 500 characters and one sentence (Unicode sentence segmentation) can be published. This bounds structural output; it cannot prove semantic accuracy or prevent all prompt injection. No model text, ticket content, credentials, or provider error bodies are logged.

## Operations and security

Every ticket endpoint requires a configured bearer credential; the OpenAPI document is public outside production. Multiple credentials allow rotation; comparison uses fixed-length cryptographic hashes. A PostgreSQL-backed per-credential fixed-window limiter bounds authorized API traffic across replicas. Invalid credentials are rejected before database work. Secrets are scoped to each process: service keys in the API, OpenRouter credentials in the worker, and a separate database owner for production migrations. Runtime database statements time out after five seconds and lock waits after two seconds. Bun's transport enforces the 128 KiB body limit before the application runs. An edge proxy supplies TLS and unauthenticated flood protection; database ports remain private in Compose.

Versioned migrations run as an explicit deployment step. Application containers run unprivileged, expose health/readiness, log JSON, and shut down gracefully. Authenticated operational stats expose queue age/counts and failure counts. CI runs strict TypeScript checks, unit/model boundary tests, and integration tests against real PostgreSQL. The README covers setup and limitations; the operations guide covers deployment and backup/restore.

## Verification

Prove concurrent idempotency, collision handling, strict API/model validation, auth, pagination/filtering, claim exclusion, stale-worker fencing, retry exhaustion, last-attempt crash recovery, graceful draining, database constraints, and the full sample-ticket lifecycle against PostgreSQL. OpenRouter is tested with an HTTP test server, without paid API calls.

## Reclassification and evaluation refinement

TriageKit exposes client-addressed classification runs using PUT with the observed previousRunId. Each terminal-to-pending transition locks its ticket, archives the prior outcome and resets the durable job atomically. Persisted UUIDs deduplicate retries; stale transitions and active runs return 409. Run history is paginated and retains model/prompt provenance and service credential fingerprints. Ingestion still never reclassifies duplicates. Migration 002 backfills existing records and requires a coordinated drain before upgrading older binaries.

Promptfoo reports output contracts, exact category/priority agreement and summary quality separately. Graceful completion retries transient PostgreSQL contention once without invoking the model again; hard-crash external inference remains at least once.
