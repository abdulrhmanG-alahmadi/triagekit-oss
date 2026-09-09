# Operations

The production Compose override is a single-host example using an external PostgreSQL database. It does not provision a cloud environment or establish high availability. Run the API and worker separately from the same immutable image, with migrations as a one-shot job. Use private managed PostgreSQL with encrypted storage, automated backups and point-in-time recovery. Destination TLS, secrets, provider compatibility, restore procedures, alerts and capacity still require verification; this repository does not claim a deployed production service.

## Database roles

Provision separate identities using an administrative connection. Use strong passwords from a secret manager; `\password` prompts avoid putting them in SQL history. For a new dedicated database:

```sql
CREATE ROLE triagekit_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE triagekit_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password triagekit_migrator
\password triagekit_runtime
CREATE DATABASE triagekit OWNER triagekit_migrator;
\connect triagekit
REVOKE ALL ON DATABASE triagekit FROM PUBLIC;
GRANT CONNECT ON DATABASE triagekit TO triagekit_migrator, triagekit_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO triagekit_runtime;
```

Run migrations as `triagekit_migrator`, then apply the runtime grants as that owner:

```sql
GRANT SELECT, INSERT, UPDATE ON public.tickets, public.rate_limits, public.classification_runs TO triagekit_runtime;
GRANT SELECT ON public.schema_migrations TO triagekit_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO triagekit_runtime;
```

Set `DATABASE_URL` to the runtime role and `MIGRATION_DATABASE_URL` to the migration owner against the same database, using TLS with server certificate verification. The local Compose database account is a development bootstrap superuser and must not be used by production application processes. Runtime access deliberately excludes DELETE and DDL.

## Deployment and migrations

Supply `API_KEYS` only to the API, and `OPENROUTER_API_KEY` plus an explicit `OPENROUTER_MODEL` only to the worker through the deployment secret store. The migrator needs only its database URL. Compose enforces these process scopes. A shared host `.env` is for development; use separate process environments in production. URL-encode credentials embedded in connection URLs and keep secrets out of images.

The override requires Docker Compose 2.24.4 or newer for `!reset`. Production mode disables the local database by default, forces OpenRouter and fails closed when required secrets are missing. Keep `POSTGRES_PASSWORD` set: the base Compose file interpolates it before skipping the local database.

**Migration 002 requires a drain:** it backfills tickets and adds the current-run foreign key. Older binaries cannot create the required run records. Stop and drain existing API/worker instances before migration, apply runtime grants after new tables exist, then start the new image:

```sh
docker compose -f compose.yaml -f compose.production.yaml stop api worker
docker compose -f compose.yaml -f compose.production.yaml run --build --rm migrate
# Apply the runtime grants above.
docker compose -f compose.yaml -f compose.production.yaml up --build --wait --wait-timeout 120 api worker
```

Keep a tested pre-migration backup. Rolling back to binaries that predate classification runs requires a coordinated database restore. Future zero-downtime migrations need an expand/contract rollout. Deploy immutable images after CI and vulnerability scanning.

## PostgreSQL 17 to 18

The PostgreSQL 18 image stores data under `/var/lib/postgresql/18/docker`; Compose mounts the named volume at `/var/lib/postgresql`, following the [official image layout](https://hub.docker.com/_/postgres). Existing PostgreSQL 17 data requires [dump/restore or pg_upgrade](https://www.postgresql.org/docs/18/upgrading.html); changing the image tag does not convert it.

For the local demo, stop writers and export the running PostgreSQL 17 database **before switching to this checkout**:

```sh
docker compose stop api worker
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > triagekit-pg17.dump
```

After updating the checkout, keep the same `.env` and start a separate Compose project with a fresh PostgreSQL 18 volume. Restore before starting migrations or application processes:

```sh
docker compose --project-name triagekit-pg18 up -d --wait db
docker compose --project-name triagekit-pg18 exec -T db sh -c 'pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < triagekit-pg17.dump
docker compose --project-name triagekit-pg18 up --build --wait --wait-timeout 120
docker compose --project-name triagekit-pg18 exec -T api bun run smoke
```

Compare ticket and classification-run counts before admitting traffic. Keep the old PostgreSQL 17 volume and dump until validation completes; reverting after new writes requires reconciling those writes. Continue managing the replacement stack with its explicit project name. For managed production databases, use the provider's major-upgrade procedure and the separate role/grant setup above.

## Network and credentials

A TLS reverse proxy must forward to the loopback API port, enforce the 128 KiB body limit and rate-limit unauthenticated traffic. Do not expose PostgreSQL or plain HTTP directly to the internet. Keep production OpenAPI endpoints authenticated. Application containers run as the unprivileged Bun user with read-only filesystems, writable temporary memory, no Linux capabilities and privilege escalation disabled.

Rotate API credentials by deploying `API_KEYS=old,new`, switching clients, then deploying only the new key. Each key authorizes the same organization and has its own rate limit. This is service authentication: user identity, role-based authorization and tenant isolation are absent. Add tenant-scoped storage and authorization before serving separate organizations. The fixed-window limiter permits boundary bursts; apply a stricter edge policy if needed.

## Monitoring and recovery

Monitor readiness, queue age, terminal failures, provider errors/latency and database capacity. JSON logs contain timestamps, levels, service names and request/attempt context without ticket bodies, raw exceptions or model output. Container logs are bounded locally; forward them to the operations platform.

Run `bun run monitor` externally with the API credential. It emits JSON and exits nonzero for unreachable or invalid API responses, pending work older than `MAX_PENDING_SECONDS` (default 300), or terminal failures exceeding `MAX_FAILED_TICKETS` (default 0). Set workload-appropriate thresholds and connect that status to alert delivery.

The worker has no container healthcheck. Fatal errors exit and `restart: unless-stopped` restarts it; stuck workers with queued work appear as rising queue age. An empty queue cannot establish worker liveness. Scale within provider concurrency, request and budget limits, and configure spending limits before sending real tickets. Inference remains at least once: a crash after a provider response but before persistence can repeat a paid call.

## Backup and restore

Back up the local demonstration database with:

```sh
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > triagekit.dump
```

For production, use managed backups, encrypt and restrict dumps, and agree retention with the support organization. Regularly restore into an isolated database owned by `triagekit_migrator`, supplying connection credentials securely:

```sh
pg_restore --no-owner --no-acl --username=triagekit_migrator --dbname='<restore-database>' triagekit.dump
```

Restoring as the migration owner preserves ownership for future migrations. Since `--no-acl` omits grants, reapply database/schema access and runtime grants above, substituting the restore database name, before reconnecting application processes. Check ticket counts and a full create/classify/read lifecycle. A written runbook is not a performed restore or a measured recovery objective.
