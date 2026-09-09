# Contributing to TriageKit

Keep changes focused. For a bug report, include reproduction steps, expected behavior and your Bun/PostgreSQL versions. Use synthetic tickets and remove credentials from logs. For a substantial change, open an issue to discuss the approach first.

Follow the [README](README.md#start-offline) to run the offline service. For development, install Bun 1.4.0, run `bun install --frozen-lockfile`, and start a disposable PostgreSQL 18.6 database as described in [verification](docs/verification.md). Then run:

```sh
bun run format
TEST_DATABASE_URL='postgres://triagekit_test:t@127.0.0.1:5432/triagekit_test' bun run check
```

Integration tests erase their test data. Use a database ending in `_test`, never a database you need to keep. The normal test suite makes no paid model calls.

Pull requests should explain the problem, the change and the checks performed. Add a regression test for behavior changes, update affected documentation, and preserve migration compatibility. Do not commit `.env`, database dumps, customer tickets or generated evaluation results. Synthetic examples must be original or carry a compatible license.
