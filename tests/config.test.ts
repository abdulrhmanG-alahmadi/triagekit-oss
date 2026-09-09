import { expect, test } from "bun:test";
import { readConfig } from "../src/config";

const env = {
  DATABASE_URL: "postgres://user:password@localhost/triagekit",
  API_KEYS: "a".repeat(32),
};

test("configuration fails closed and bounds worker resources", () => {
  expect(() => readConfig({})).toThrow();
  expect(() => readConfig({ ...env, API_KEYS: "short" })).toThrow();
  expect(() => readConfig({ ...env, WORKER_CONCURRENCY: "0" })).toThrow();
  expect(() => readConfig({ ...env, LEASE_MS: "1000" })).toThrow();
  // The lease must outlast the model call plus the persistence timeouts that follow it.
  expect(() =>
    readConfig({ ...env, MODEL_TIMEOUT_MS: "30000", LEASE_MS: "39999" }),
  ).toThrow("LEASE_MS");
  expect(
    readConfig({ ...env, MODEL_TIMEOUT_MS: "30000", LEASE_MS: "40000" })
      .leaseMs,
  ).toBe(40_000);
  expect(() =>
    readConfig({ ...env, NODE_ENV: "production", LLM_PROVIDER: "fake" }),
  ).toThrow();
  expect(() => readConfig({ ...env, LLM_PROVIDER: "openrouter" })).toThrow();
  expect(readConfig(env).concurrency).toBe(4);
  expect(readConfig(env).provider).toBe("fake");
  expect(
    readConfig({
      ...env,
      NODE_ENV: "production",
      OPENROUTER_API_KEY: "key",
      OPENROUTER_MODEL: "vendor/model",
    }).provider,
  ).toBe("openrouter");
});

test("processes require only their own credentials and URL errors do not leak secrets", () => {
  expect(
    readConfig({ ...env, LLM_PROVIDER: "openrouter" }, "api").apiKeys,
  ).toHaveLength(1);
  expect(
    readConfig(
      { DATABASE_URL: env.DATABASE_URL, LLM_PROVIDER: "fake" },
      "worker",
    ).apiKeys,
  ).toEqual([]);
  try {
    readConfig({
      ...env,
      DATABASE_URL: "postgres://user:private-password@host:invalid/db",
    });
  } catch (error) {
    expect(String(error)).not.toContain("private-password");
  }
});

test("API credentials must be serializable RFC 6750 bearer tokens", () => {
  for (const key of [
    "🔑".repeat(32),
    `${"a".repeat(32)}\x7f`,
    `${"a".repeat(32)}:`,
    `${"a".repeat(32)}=b`,
    "=".repeat(32),
  ]) {
    expect(() => readConfig({ ...env, API_KEYS: key })).toThrow("API_KEYS");
  }
  const key = `${"A".repeat(32)}-._~+/==`;
  expect(readConfig({ ...env, API_KEYS: key }).apiKeys).toEqual([key]);
  expect(
    new Headers({ authorization: `Bearer ${key}` }).get("authorization"),
  ).toBe(`Bearer ${key}`);
});

test("tracing is opt-in and collector URL errors do not disclose credentials", () => {
  expect(readConfig(env).telemetryEndpoint).toBeUndefined();
  expect(
    readConfig({ ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "" })
      .telemetryEndpoint,
  ).toBeUndefined();
  const endpoint = "http://127.0.0.1:4318/v1/traces";
  expect(
    readConfig({ ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint })
      .telemetryEndpoint,
  ).toBe(endpoint);
  for (const endpoint of [
    "file:///tmp/traces",
    "https://user:private-collector-key@collector.test/v1/traces",
    "https://collector.test/v1/traces#fragment",
    "invalid",
  ]) {
    expect(() =>
      readConfig({ ...env, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint }),
    ).toThrow(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP(S) URL without credentials or a fragment",
    );
  }
});
