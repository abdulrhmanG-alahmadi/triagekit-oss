import tickets from "../samples/tickets.json";
import { apiClient } from "../src/client";

export async function seed(
  baseUrl: string,
  apiKey: string,
  request: typeof fetch = fetch,
) {
  const api = apiClient(baseUrl, apiKey, request);
  let created = 0;
  for (const ticket of tickets) {
    const response = await api.tickets.post(ticket);
    if (response.status !== 200 && response.status !== 201) {
      throw new Error(`Seed stopped at ${ticket.id}: HTTP ${response.status}`);
    }
    if (response.status === 201) created++;
  }
  return { created, existing: tickets.length - created };
}

if (import.meta.main) {
  try {
    const result = await seed(
      process.env.API_BASE_URL || "http://127.0.0.1:3000",
      process.env.API_KEY || process.env.API_KEYS?.split(",")[0]?.trim() || "",
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Seed failed");
    process.exitCode = 1;
  }
}
