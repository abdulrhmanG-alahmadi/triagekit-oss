import { setTimeout } from "node:timers/promises";

// Evaluate the deployed ingestion/worker/validation path, so evals cannot drift into a second classifier.
export default class TicketApi {
  id() {
    return "triagekit-ticket-api";
  }

  async callApi(_prompt, context) {
    const apiKey =
      process.env.API_KEY || process.env.API_KEYS?.split(",")[0]?.trim();
    if (!apiKey)
      return { error: "Set API_KEY or API_KEYS for the evaluation API" };
    const expected = process.env.EVAL_EXPECT_PROVIDER || "openrouter";
    if (!["fake", "openrouter"].includes(expected))
      return { error: "EVAL_EXPECT_PROVIDER must be fake or openrouter" };
    const expectedModel =
      expected === "fake" ? "fake-v1" : process.env.OPENROUTER_MODEL;
    if (!expectedModel?.trim())
      return {
        error: "Set OPENROUTER_MODEL to the exact model being evaluated",
      };
    const id = `eval-${crypto.randomUUID()}`;
    const input = {
      id,
      subject: context.vars.subject,
      body: context.vars.body,
    };
    const signal = AbortSignal.timeout(180_000);
    try {
      const baseUrl = new URL(
        process.env.API_BASE_URL || "http://127.0.0.1:3000",
      );
      if (
        !["http:", "https:"].includes(baseUrl.protocol) ||
        baseUrl.username ||
        baseUrl.password ||
        baseUrl.href.includes("?") ||
        baseUrl.href.includes("#")
      )
        return {
          error:
            "API_BASE_URL must be an HTTP(S) URL without credentials, query or hash",
        };
      baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/`;
      const request = (path, options = {}) =>
        fetch(new URL(path, baseUrl), {
          ...options,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
      const created = await request("api/v1/tickets", {
        method: "POST",
        body: JSON.stringify(input),
      });
      await created.body?.cancel();
      if (created.status !== 201)
        return { error: `Ingestion returned HTTP ${created.status}` };
      while (true) {
        const response = await request(`api/v1/tickets/${id}`);
        if (!response.ok) {
          await response.body?.cancel();
          return { error: `Polling returned HTTP ${response.status}` };
        }
        const ticket = await response.json();
        if (
          ["id", "subject", "body"].some((key) => ticket?.[key] !== input[key])
        )
          return { error: "Evaluation API returned a different ticket" };
        if (!["pending", "classified", "failed"].includes(ticket.status))
          return { error: "Evaluation API returned an invalid ticket state" };
        if (ticket.status === "failed")
          return {
            error: `Classification failed: ${ticket.failure?.code}`,
            metadata: {
              ticketId: id,
              attempts: ticket.attempts,
              lastErrorCode: ticket.lastErrorCode,
            },
          };
        if (ticket.status === "classified") {
          const { model, promptVersion, classifiedAt, ...classification } =
            ticket.classification;
          if (model !== expectedModel)
            return {
              error:
                "Classification model does not match the exact expected model",
            };
          if (
            typeof promptVersion !== "string" ||
            !promptVersion.trim() ||
            typeof classifiedAt !== "string" ||
            !Number.isFinite(Date.parse(classifiedAt)) ||
            new Date(classifiedAt).toISOString() !== classifiedAt
          )
            return { error: "Classification provenance is invalid" };
          return {
            output: classification,
            metadata: {
              model,
              promptVersion,
              classifiedAt,
              ticketId: id,
              attempts: ticket.attempts,
              lastErrorCode: ticket.lastErrorCode,
            },
          };
        }
        await setTimeout(1_000, undefined, { signal });
      }
    } catch {
      return {
        error: signal.aborted
          ? "Evaluation deadline exceeded (180 seconds)"
          : "Evaluation API request failed",
        metadata: { ticketId: id },
      };
    }
  }
}
