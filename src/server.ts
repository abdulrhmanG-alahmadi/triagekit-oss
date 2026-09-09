import { connectDatabase } from "./database";
import { createApp, maxBodyBytes } from "./app";
import { readConfig } from "./config";
import { Store } from "./store";
import { createLogger } from "./log";
import { createTelemetry } from "./telemetry";

const config = readConfig(process.env, "api");
const log = createLogger("triagekit-api");
const telemetry = createTelemetry("triagekit-api", config.telemetryEndpoint);
const sql = connectDatabase(config.databaseUrl);
const app = createApp(config, new Store(sql), log, telemetry.tracer).listen({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: maxBodyBytes,
  idleTimeout: 30,
});
log({ event: "api_started", port: config.port });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log({ event: "api_stopping" });
  const deadline = setTimeout(() => process.exit(1), 15_000);
  deadline.unref();
  try {
    await app.stop();
  } catch {
    log({ event: "api_shutdown_failed", level: "error" });
    process.exitCode = 1;
  } finally {
    const results = await Promise.allSettled([
      sql.close({ timeout: 5 }),
      telemetry.shutdown(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      log({ event: "api_shutdown_failed", level: "error" });
      process.exitCode = 1;
    }
    clearTimeout(deadline);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
