import { treaty } from "@elysiajs/eden";
import type { createApp } from "./app";
import { apiKeyPattern } from "./config";

export function apiClient(
  baseUrl: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("API_BASE_URL must use HTTP or HTTPS without credentials");
  if (url.href.includes("?") || url.href.includes("#"))
    throw new Error("API_BASE_URL must not contain a query or fragment");
  if (!apiKeyPattern.test(apiKey))
    throw new Error("Set API_KEY or API_KEYS to a configured API credential");
  return treaty<ReturnType<typeof createApp>>(url.href.replace(/\/+$/, ""), {
    fetcher,
    parseDate: false,
    headers: { authorization: `Bearer ${apiKey}` },
    fetch: { redirect: "error" },
    onRequest: () => ({
      signal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]),
    }),
  }).api.v1;
}
