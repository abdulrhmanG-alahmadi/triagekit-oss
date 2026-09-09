import { SQL } from "bun";

export function databaseSslMode(
  env: Record<string, string | undefined>,
): "verify-full" | "disable" | undefined {
  const mode =
    env.DATABASE_TLS ??
    (env.NODE_ENV === "production" ? "verify-full" : undefined);
  if (mode === "private-network") return "disable" as const;
  if (mode === undefined || mode === "verify-full") return mode;
  throw new Error("DATABASE_TLS must be verify-full or private-network");
}

export function connectDatabase(
  url: string,
  max = 10,
  ssl?: "verify-full" | "disable",
) {
  try {
    return new SQL(url, {
      max,
      ssl,
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
