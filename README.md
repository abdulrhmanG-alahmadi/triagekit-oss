![TriageKit — reliable LLM workflows](docs/cover.svg)

# TriageKit

**Durable support-ticket classification with a validated LLM boundary.**

[Run the offline demo](#start-offline) · [Architecture](#architecture) · [Design decisions](docs/design.md) · [Operations](docs/operations.md)

## Project story

**Problem.** Classifying a ticket should not tie the API response to a slow or unavailable model provider, and accepted work should survive a restart.

**Approach.** Persist the ticket and its pending work in PostgreSQL, then let a separate worker perform inference. Validate the model response before publication and use leases, bounded retries, and attempt IDs to handle failures.

**Current result.** The repository includes an offline fake-provider demo, real-PostgreSQL integration tests, reclassification history, and recovery tooling. It is a standalone service for one support organization; it does not claim a live-model accuracy benchmark or a hosted production deployment.

## Architecture

```mermaid
flowchart LR
    C[Service client] --> A[Bun / Elysia API]
    A --> D[(PostgreSQL tickets and pending work)]
    D --> W[Worker claims a leased job]
    W --> P[Fake provider or OpenRouter]
    P --> V[Strict output validation]
    V --> D
    A --> R[Ticket status and run history]
```

## Overview

TriageKit classifies support tickets asynchronously with Bun, Elysia and PostgreSQL. The API durably accepts tickets; a separate worker calls OpenRouter and validates its output. Offline startup uses a deterministic fake without credentials or model charges.

Built for one support organization and trusted service clients, it provides idempotent ingestion, durable retries, reclassification history and graceful worker shutdown. PostgreSQL stores both tickets and pending work. See the [design](docs/design.md) for the implementation and its trade-offs.

TriageKit started as an interview take-home that called for a small, clear solution. I kept developing the reliability and operational features beyond that scope, then released this standalone version as an open-source project under the MIT license.

The repository includes tested recovery, backup/restore and retention tooling. It is not a hosted service; production use still requires verification in your deployment environment.

## Start offline

Existing PostgreSQL 17 volumes need the [upgrade procedure](docs/operations.md#postgresql-17-to-18) before starting this version.

With Docker Compose v2 installed, run from the repository:

```sh
cp .env.example .env
docker compose up --build --wait --wait-timeout 120
docker compose exec api bun run seed
docker compose exec api bun run smoke
```

The example environment supplies development credentials and `LLM_PROVIDER=fake`. Database health precedes migrations, then API/worker startup. The API binds to `127.0.0.1:3000`; PostgreSQL has no published port. Seed submits ten synthetic example tickets, including an empty subject and an injection attempt, through the API. Repeating it safely returns existing tickets.

Rotate both development credentials before sharing a deployment. Keep existing database/user settings when reusing a volume; new installations default to `triagekit` for both. Existing deployments must explicitly retain their original `POSTGRES_USER` and `POSTGRES_DB` in `.env`. Sample content can change between releases: seed into a fresh demo database to avoid ID conflicts with older examples. `docker compose down` preserves data; adding `-v` deletes it.

```sh
curl --fail-with-body http://127.0.0.1:3000/health/ready
API_KEY=$(grep '^API_KEYS=' .env | cut -d= -f2 | cut -d, -f1)
curl --fail-with-body -i http://127.0.0.1:3000/api/v1/tickets \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  --data '{"id":"demo-1","subject":"Invoice question","body":"Where can I download my July invoice?"}'
```

## API and lifecycle

Every `/api/v1/*` route requires a bearer credential. `/openapi` and `/openapi/json` document the contract; production requires authentication for both. Health endpoints are public.

| Method and path                                      | Behavior                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /api/v1/tickets`                               | Accept exactly `{id,subject,body}`; durable `201` with `Location`.                   |
| `GET /api/v1/tickets/:id`                            | Read content, status and classification/failure.                                     |
| `GET /api/v1/tickets`                                | Paginate using `category`, `priority`, `status`, `promptVersion`, `cursor`, `limit`. |
| `PUT /api/v1/tickets/:id/classification-runs/:runId` | Reclassify with a fresh UUID and `{previousRunId}`.                                  |
| `GET /api/v1/tickets/:id/classification-runs/:runId` | Read current or archived run.                                                        |
| `GET /api/v1/tickets/:id/classification-runs`        | Paginate run history.                                                                |
| `GET /api/v1/operations`                             | Read queue age, counts and failures.                                                 |
| `GET /health/live`, `GET /health/ready`              | Process liveness and database readiness.                                             |

Poll the ticket after creation: `pending` becomes `classified` or `failed`. Classification includes category, priority, summary, model, prompt version and timestamp. Tickets expose `classificationRunId`, `attempts` and `lastErrorCode`. Normal retry exhaustion preserves the last error in `failure.code`; recovery after an expired final lease uses `attempts_exhausted`, retaining any earlier `lastErrorCode`.

Content is immutable. Identical resubmission returns `200`; the same ID with different content returns `409 ticket_conflict`. Neither queues more work, including concurrent submissions. IDs are URL-safe, at most 128 characters; subjects allow 0–500 characters; bodies require nonblank text within 20,000 characters. Unknown fields are rejected. Categories are `billing`, `technical`, `account`, `other`; priorities are `low`, `medium`, `high`.

Lists return `{items,nextCursor}`, newest insertion first, with default limit 20 and maximum 100. Category/priority filters imply `classified` unless status is explicit. Reuse cursors with identical filters. Pagination is not a snapshot: restart listing to find tickets classified since earlier pages.

Application errors use `application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, `code`, `requestId`.

| Status | Codes                                                                                 |
| ------ | ------------------------------------------------------------------------------------- |
| 400    | `invalid_json`, `invalid_cursor`                                                      |
| 401    | `unauthorized`                                                                        |
| 404    | `not_found`, `ticket_not_found`, `run_not_found`                                      |
| 408    | `request_timeout`                                                                     |
| 409    | `ticket_conflict`, `run_conflict`, `classification_pending`, `classification_changed` |
| 415    | `unsupported_media_type`                                                              |
| 422    | `validation_error`                                                                    |
| 429    | `rate_limited` with `Retry-After`                                                     |
| 500    | `internal_error`                                                                      |
| 503    | `database_unavailable`, `not_ready`                                                   |

JSON reads have a ten-second deadline. Bun enforces the 128 KiB request limit before application handling; its `413` responses lack the application error envelope. Internal errors do not expose ticket text, credentials or SQL.

## Reclassification and recovery

Read the terminal ticket's `classificationRunId`; PUT a new UUID with that value as `previousRunId`. The transaction archives the previous result and schedules a run at attempt zero. Deploy the desired worker configuration first: new runs use that configuration. Retry interrupted requests with the same UUID/body (`200` replay); pending tickets, stale predecessors and conflicting reuse return `409`. Original content remains unchanged; historical results remain readable. Bulk rollout is an explicit operator action.

PostgreSQL stores tickets and queue work atomically, avoiding a second broker. Workers claim with `FOR UPDATE SKIP LOCKED`, releasing the transaction before inference. Attempt UUIDs fence late writes; leases recover abandoned work after restart. Defaults are four concurrent calls per worker, three attempts, a 60-second lease and a 30-second model timeout. Startup requires lease headroom; replicas multiply provider concurrency.

Timeouts, transient provider failures and invalid output receive capped exponential backoff with jitter and bounded `Retry-After`. Permanent provider errors terminate the run. Persistence contention retries once without another inference. SIGTERM stops claims, drains bounded in-flight work and closes connections; fatal database errors exit nonzero. A crash between inference and commit can repeat a paid call: remote inference is at least once.

## Model boundary

For live calls, set `LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` in `.env`, then run:

```sh
docker compose up -d --no-deps --force-recreate worker
```

The example model is `anthropic/claude-sonnet-4.6`. Missing live configuration fails closed. Requests use temperature zero, strict JSON Schema, required parameter support and a provider data-collection restriction. Check provider terms before submitting customer data.

The adapter sends fixed system instructions separately from a JSON user message containing subject/body; storage IDs and service credentials are excluded. Ticket text is sent as supplied. OpenRouter's downstream role normalization is outside this service's control. The model has no tools. A shared validator permits only the three expected fields, valid enums and a nonempty single-line, one-sentence summary up to 500 characters. Sentence detection is heuristic. Invalid output is retried, never published as a classification.

Category follows the issue; priority follows current impact. Questions/resolved explanations are low, ordinary active issues medium, explicit critical impact high. Ticket instructions cannot legitimately override this policy, but schema-valid semantic mistakes and prompt injection remain possible. The fake uses generic keyword results, with deterministic first-attempt faults to exercise retries; it has no canned answers and is not a quality benchmark.

## Tests and evaluation

Install Bun 1.4.0 and use a separate disposable PostgreSQL 18.6 database ending in `_test`; integration tests truncate their data. Permission tests require a throwaway administrator capable of creating roles/databases.

```sh
bun install --frozen-lockfile
TEST_DATABASE_URL='postgres://user:password@127.0.0.1:5432/triagekit_test' bun run check
```

`check` runs formatting, lint, types, unit tests and real-PostgreSQL integration tests, covering duplicate ingestion, fencing, retry exhaustion, reclassification, API bounds and shutdown/restart behavior. Tests use local provider stubs. CI also runs dependency audit, Compose smoke and `bun run verify:production`: a disposable load, outage, restart and full backup/restore rehearsal. See [verification](docs/verification.md).

The regression suite has 19 synthetic cases; a separate heldout fixture has 12. Fixtures and labels are agent-authored and not human-validated. Host evaluation requires Node 22.22+ alongside Bun; pinned Promptfoo downloads on first use.

```sh
EVAL_EXPECT_PROVIDER=fake bun run eval
# With a live worker configured; these calls incur provider charges:
bun run eval
bun run eval:report eval/results.json
EVAL_SET=heldout bun run eval
```

Use a disposable deployment: evaluations create tickets. Each case runs three times with fresh IDs; temperature-zero repeats are correlated. Reports separate contract validity, category/priority matches and lexical summary checks; errors remain in the denominator. Fake semantic failures are expected. Live runs generate `eval/results.json` or `eval/heldout-results.json`; fake results stay under `tmp/promptfoo/`. Generated results are ignored by Git and no live-model benchmark is bundled. Once inspected, heldout cases are no longer unseen evidence. Automated summary checks can miss factual errors or reject valid paraphrases.

## Deployment and next changes

For production, use managed PostgreSQL with automated backups and point-in-time recovery.

[Operations](docs/operations.md) covers production Compose, separate runtime/migration roles, verified database TLS, credential rotation, retention, monitoring, backups and rollback. The [Render deployment recipe](docs/render.md) provides a managed hosting starting point. The tooling does not establish destination readiness by itself.

Before admitting customer traffic, validate representative tickets with support staff, perform the destination restore/load and alert-delivery checks, and choose a retention period. The operator-only `bun run retention` command previews deletions by default and requires `--apply`. Add tenant isolation and finer authorization before serving multiple organizations. Measure queue contention before introducing a separate broker.

## Weaknesses

- Remote inference is at least once: a crash between a provider response and commit repeats a paid call.
- Prompt injection is mitigated by prompt structure and output validation, not prevented; schema-valid semantic mistakes still pass.
- The one-sentence summary check is a Unicode heuristic, so unusual punctuation can be rejected or accepted wrongly.
- Evaluations are synthetic and agent-orchestrated; no support staff has validated labels against real tickets.
- Pagination is not a snapshot, and there is no tenant isolation. Operators must choose and schedule their retention policy.

## Contributing

Bug reports and focused pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks, and [SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## License

[MIT](LICENSE).
