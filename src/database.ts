import { SQL } from "bun";

export function connectDatabase(url: string, max = 10) {
  try {
    return new SQL(url, {
      max,
      connectionTimeout: 5,
      idleTimeout: 30,
      maxLifetime: 300,
      connection: {
        statement_timeout: 5_000,
        lock_timeout: 2_000,
        idle_in_transaction_session_timeout: 10_000,
      },
    });
  } catch {
    throw new Error("Invalid database connection configuration");
  }
}
