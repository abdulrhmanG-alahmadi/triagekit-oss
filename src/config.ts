export const apiKeyPattern = /^(?=.{32,256}$)[A-Za-z0-9._~+/-]+=*$/;

export function readConfig(
  env: Record<string, string | undefined> = process.env,
  role: "api" | "worker" | "all" = "all",
) {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
      throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const databaseUrl = env.DATABASE_URL ?? "";
  try {
    const parsed = new URL(databaseUrl);
    if (
      !/^postgres(ql)?:$/.test(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error();
  } catch {
    throw new Error(
      "DATABASE_URL must be a valid PostgreSQL URL with a database name",
    );
  }
  const apiKeys =
    role === "worker"
      ? []
      : (env.API_KEYS ?? "").split(",").map((key) => key.trim());
  if (apiKeys.some((key) => !apiKeyPattern.test(key)))
    throw new Error(
      "API_KEYS must contain RFC 6750 bearer tokens of 32–256 ASCII characters",
    );
  const production = env.NODE_ENV === "production";
  const telemetryEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || undefined;
  if (telemetryEndpoint) {
    try {
      const parsed = new URL(telemetryEndpoint);
      if (
        !/^https?:$/.test(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP(S) URL without credentials or a fragment",
      );
    }
  }
  const provider = env.LLM_PROVIDER ?? (production ? "openrouter" : "fake");
  if (provider !== "fake" && provider !== "openrouter")
    throw new Error("Invalid LLM_PROVIDER");
  if (production && provider === "fake")
    throw new Error("Fake classifications are disabled in production");
  if (
    role !== "api" &&
    provider === "openrouter" &&
    (!env.OPENROUTER_API_KEY?.trim() || !env.OPENROUTER_MODEL?.trim())
  )
    throw new Error(
      "OpenRouter requires OPENROUTER_API_KEY and OPENROUTER_MODEL",
    );
  const modelTimeoutMs = integer("MODEL_TIMEOUT_MS", 30_000, 100, 120_000);
  const leaseMs = integer("LEASE_MS", 60_000, 10_100, 300_000);
  // Persistence after the model call runs with lock_timeout 2s and statement_timeout 5s.
  if (leaseMs < modelTimeoutMs + 10_000)
    throw new Error("LEASE_MS must exceed MODEL_TIMEOUT_MS by at least 10000");
  return {
    databaseUrl,
    apiKeys,
    production,
    telemetryEndpoint,
    provider: provider as "fake" | "openrouter",
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
    modelTimeoutMs,
    leaseMs,
    concurrency: integer("WORKER_CONCURRENCY", 4, 1, 32),
    maxAttempts: integer("MAX_ATTEMPTS", 3, 1, 10),
    pollIntervalMs: integer("POLL_INTERVAL_MS", 500, 10, 30_000),
    retryBaseMs: integer("RETRY_BASE_MS", 1_000, 0, 60_000),
    rateLimitPerMinute: integer("RATE_LIMIT_PER_MINUTE", 300, 1, 100_000),
    port: integer("PORT", 3000, 1, 65535),
    host: env.HOST ?? "0.0.0.0",
  };
}

export type Config = ReturnType<typeof readConfig>;
