# Managed deployment on Render

This is a small, single-organization deployment recipe: one Docker API, one Docker worker and managed PostgreSQL in the same region. No resources are provisioned by this repository. Pick the region and data-handling requirements before creating resources; deployment still needs the acceptance checks below.

As of September 9, 2026, a starting budget is approximately **$34/month plus database storage, bandwidth and inference**: $7 each for the API and worker (`0.5c-512mb`), $19 for PostgreSQL (`0.5c-1g`), and a $1 minimum for the monitor cron job. Check [current pricing](https://render.com/pricing) and [cron billing](https://render.com/docs/cronjobs). This sizing is a starting point, not a measured capacity guarantee or a high-availability configuration.

## Prepare PostgreSQL

Create a paid PostgreSQL 18 instance with database `triagekit` and owner `triagekit_owner`. Choose the same region for all services, enable the provider's backups/PITR, and restrict external access to the operator's IP while provisioning. Follow [Render's connection instructions](https://render.com/docs/postgresql-creating-connecting).

Use the owner only for administration, migrations and maintenance. Connect with `psql` and create the restricted application identity:

```sql
CREATE ROLE triagekit_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password triagekit_runtime
REVOKE ALL ON DATABASE triagekit FROM PUBLIC;
GRANT CONNECT ON DATABASE triagekit TO triagekit_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO triagekit_runtime;
```

From the reviewed release checkout, inject the owner's external connection URL as `DATABASE_URL` in a temporary operator environment, then run `NODE_ENV=production bun run migrate`. The default verifies the external endpoint's TLS certificate and hostname. Apply the [runtime grants](operations.md#database-roles) after migration. Keep the owner credential out of API and worker settings. Roles created with SQL are [not managed by Render's credential rotation feature](https://render.com/docs/postgresql-credentials); rotate the runtime role explicitly.

For the API/worker, use the internal connection hostname with the runtime username/password and `DATABASE_TLS=private-network`. This deliberately uses plaintext within Render's private network; use an endpoint supporting `verify-full` instead if encrypted database transport is required. Disable external database access after provisioning, reopening only the required operator IP for controlled maintenance. Do not publish the database port.

## Create the services

Connect this repository and select the same reviewed commit for both services. Build with the root `Dockerfile`, one instance each, no persistent application disk. Disable automatic deploys so schema changes can follow the coordinated [migration procedure](operations.md#deployment-and-migrations). Set the API/worker shutdown delay to 150 seconds (`maxShutdownDelaySeconds` in the [service configuration](https://render.com/docs/blueprint-spec#maxshutdowndelayseconds)).

| Setting              | Web service                   | Background worker                                         |
| -------------------- | ----------------------------- | --------------------------------------------------------- |
| Docker command       | `bun src/server.ts`           | `bun src/worker.ts`                                       |
| `NODE_ENV`           | `production`                  | `production`                                              |
| `DATABASE_URL`       | Runtime internal URL          | Runtime internal URL                                      |
| `DATABASE_TLS`       | `private-network`             | `private-network`                                         |
| `LLM_PROVIDER`       | `openrouter`                  | `openrouter`                                              |
| `API_KEYS`           | Fresh 32–256 character secret | Omit                                                      |
| `OPENROUTER_API_KEY` | Omit                          | Dedicated key with a provider spending limit              |
| `OPENROUTER_MODEL`   | Omit                          | `anthropic/claude-sonnet-4.6` or an evaluated replacement |
| `HOST` / `PORT`      | `0.0.0.0` / `10000`           | Omit                                                      |
| Health check         | `/health/ready`               | Process supervision plus queue monitor                    |

Generate API credentials with `openssl rand -hex 32` and enter them in the secret settings. Keep the default worker concurrency of four initially. Replicas multiply concurrency and provider spend. Enable HTTPS through Render's managed endpoint; verify unauthenticated ticket requests fail. For untrusted public traffic, configure an edge rate limit in addition to application authentication and request-size enforcement.

Create a Docker cron service from the same commit, command `bun run monitor`, schedule `*/5 * * * *`. Give it only `API_BASE_URL=https://<your-api-host>`, `API_KEY`, `MAX_PENDING_SECONDS=300` and `MAX_FAILED_TICKETS=0`. The monitor does not require database or model credentials. Configure [failure notifications](https://render.com/docs/notifications) to an operator who can respond. Choose a retention cutoff/schedule separately; erasure is never enabled automatically.

## Acceptance before customer traffic

1. Verify HTTPS, `/health/ready`, authenticated create/read, duplicate replay and reclassification using synthetic inputs. Confirm the actual worker model and runtime database role, and check memory/CPU/connection headroom.
2. Pause the worker in a staging deployment, enqueue a synthetic ticket and wait for the queue-age alert. Confirm the notification reaches the operator, restart the worker and verify recovery. Trigger a staging terminal failure and confirm that alert too.
3. Restore a managed backup into an isolated database, reapply restricted-role grants, compare ticket/history data and run a lifecycle check. Measure recovery time and recoverable data age; record these as the initial RTO/RPO only after measuring them.
4. Run a bounded workload representative of the expected arrival rate and provider latency. Check queue age, API latency, retries, memory and inference cost. The local rehearsal's fast synthetic provider is not a capacity estimate for this host.
5. Have support staff review representative classifications and adversarial inputs, set the model spending limit, and approve the retention period. Keep human review for consequential routing decisions.

Record the commit, model, measurements and notification/restore results in the operator's deployment log. Retain the previous image and backup for rollback. Scale only after measuring the bottleneck; a stricter availability target requires a database HA plan and redundant services.
