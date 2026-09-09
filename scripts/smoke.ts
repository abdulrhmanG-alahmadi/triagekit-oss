import assert from "node:assert/strict";
import { seed } from "./seed";
import tickets from "../samples/tickets.json";
import { apiClient } from "../src/client";

const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:3000";
const apiKey =
  process.env.API_KEY || process.env.API_KEYS?.split(",")[0]?.trim() || "";
try {
  await seed(baseUrl, apiKey);
  assert.deepEqual(await seed(baseUrl, apiKey), {
    created: 0,
    existing: tickets.length,
  });
  const deadline = AbortSignal.timeout(60_000);
  const api = apiClient(baseUrl, apiKey, fetch, deadline);
  for (const sample of tickets) {
    while (true) {
      deadline.throwIfAborted();
      const response = await api.tickets({ id: sample.id }).get();
      assert.equal(response.status, 200);
      assert.ifError(response.error);
      const ticket = response.data;
      assert(ticket);
      for (const field of ["id", "subject", "body"] as const)
        assert.equal(ticket[field], sample[field]);
      assert.notEqual(ticket.status, "failed");
      if (ticket.status === "classified") {
        assert(ticket.classification);
        assert.equal(
          ticket.classification.model,
          "fake-v1",
          "Smoke checks require the offline fake provider",
        );
        break;
      }
      assert.equal(ticket.status, "pending");
      await Bun.sleep(250);
    }
  }
  const sample = tickets[0];
  assert(sample);
  const ticket = api.tickets({ id: sample.id });
  const original = (await ticket.get()).data;
  assert(original);
  const runId = crypto.randomUUID();
  const runPath = `/api/v1/tickets/${sample.id}/classification-runs/${runId}`;
  const runClient = ticket["classification-runs"]({ runId });
  const body = { previousRunId: original.classificationRunId };
  const created = await runClient.put(body);
  assert.equal(created.status, 201);
  assert.equal(created.response.headers.get("location"), runPath);
  assert.equal((await runClient.put(body)).status, 200);
  while (true) {
    const response = await runClient.get();
    assert.equal(response.status, 200);
    assert.ifError(response.error);
    const run = response.data;
    assert(run);
    assert.notEqual(run.status, "failed");
    if (run.status === "classified") break;
    assert.equal(run.status, "pending");
    await Bun.sleep(250);
  }
  const archived = await ticket["classification-runs"]({
    runId: original.classificationRunId,
  }).get();
  assert.equal(archived.status, 200);
  assert(archived.data);
  assert.deepEqual(archived.data.classification, original.classification);
  assert.equal((await runClient.put(body)).status, 200);
  console.log(
    "Smoke passed: ten synthetic tickets classified, duplicate ingestion deduplicated, reclassification completed once and previous outcome preserved.",
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "smoke_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
