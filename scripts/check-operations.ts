import { apiClient } from "../src/client";

export async function checkOperations(
  baseUrl: string,
  apiKey: string,
  limits = { maxPendingSeconds: 300, maxFailedTickets: 0 },
  fetcher: typeof fetch = fetch,
) {
  if (
    !Number.isFinite(limits.maxPendingSeconds) ||
    limits.maxPendingSeconds <= 0 ||
    !Number.isInteger(limits.maxFailedTickets) ||
    limits.maxFailedTickets < 0
  )
    throw new Error(
      "Operation thresholds must be a positive age and a nonnegative failure count",
    );
  const { data, status, error } = await apiClient(
    baseUrl,
    apiKey,
    fetcher,
  ).operations.get();
  if (error || status !== 200 || !data)
    throw new Error(`Operations check failed: HTTP ${status}`);
  if (
    ![data.pending, data.failed, data.oldestPendingSeconds].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    )
  )
    throw new Error("Operations returned invalid queue metrics");
  const alerts = [];
  if (data.pending > 0 && data.oldestPendingSeconds > limits.maxPendingSeconds)
    alerts.push("queue_stalled");
  if (data.failed > limits.maxFailedTickets) alerts.push("failed_tickets");
  return { ...data, alerts };
}

if (import.meta.main) {
  try {
    const result = await checkOperations(
      process.env.API_BASE_URL || "http://127.0.0.1:3000",
      process.env.API_KEY || process.env.API_KEYS?.split(",")[0]?.trim() || "",
      {
        maxPendingSeconds: Number(process.env.MAX_PENDING_SECONDS || 300),
        maxFailedTickets: Number(process.env.MAX_FAILED_TICKETS || 0),
      },
    );
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        service: "triagekit-monitor",
        level: result.alerts.length ? "error" : "info",
        event: "operations_check",
        ...result,
      }),
    );
    process.exitCode = result.alerts.length ? 1 : 0;
  } catch {
    console.error(
      JSON.stringify({
        time: new Date().toISOString(),
        service: "triagekit-monitor",
        level: "error",
        event: "operations_check_failed",
      }),
    );
    process.exitCode = 1;
  }
}
