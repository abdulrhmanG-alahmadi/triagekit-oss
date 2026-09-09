# Verification

Install dependencies with `bun install --frozen-lockfile`. Tests use no paid model calls; provider HTTP tests use local mock servers. Integration tests require a **disposable PostgreSQL database whose name ends in `_test`** and truncate its tables. Use a disposable bootstrap administrator because the permissions test creates and removes a separate database and login roles.

```sh
docker run -d --rm --name triagekit-test \
  -e POSTGRES_USER=triagekit_test -e POSTGRES_PASSWORD=t \
  -e POSTGRES_DB=triagekit_test -p 127.0.0.1:5432:5432 postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2
```

Wait until `docker exec triagekit-test pg_isready -U triagekit_test` succeeds, then run:

```sh
TEST_DATABASE_URL='postgres://triagekit_test:t@127.0.0.1:5432/triagekit_test' bun run check
bun audit
docker rm -f triagekit-test
```

`check` runs formatting, lint, TypeScript validation, unit/native HTTP tests and real PostgreSQL integration tests. `bun audit` checks dependency advisories separately. Use the command output for the current test count and result.

Coverage includes:

- Strict input/model-output contracts, transport limits, authentication and private errors; ticket text stays outside system messages and the model receives no tools.
- Atomic ingestion, concurrent duplicate IDs, immutable content, filters and cursor binding.
- Exclusive claims, bounded retries, expired-lease recovery and stale-result rejection, including row-lock waits.
- Real worker SIGTERM draining and competing-process recovery after SIGKILL; API shutdown has narrower in-process coverage.
- Idempotent reclassification/history, migration upgrades and restricted database permissions.
- Evaluation completeness, model identity, fixture fingerprints and failure accounting; fake results cannot establish live-model quality.

With the offline Compose stack running, exercise the API and worker together:

```sh
docker compose exec api bun run smoke
```

Smoke loads all ten synthetic example tickets, verifies duplicate seeding creates no work, waits for terminal classifications, checks retained input, and exercises reclassification replay and history. CI runs the checks, dependency audit, Compose startup and smoke.

After a live evaluation, rescore its generated archive without further model calls:

```sh
bun run eval:report eval/results.json
```

No live-model result archive is bundled. Unit tests exercise reporting with explicitly synthetic offline responses. Live evaluation uses fresh tickets and costs provider tokens; see the README.

Tests do not establish universal prompt-injection resistance, representative support accuracy, destination readiness or recovery objectives. Load testing, backup restoration, TLS, alert delivery and real-workload capacity require separate operational verification; see [operations](operations.md).
