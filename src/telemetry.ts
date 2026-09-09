import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
  type SpanOptions,
  type Tracer,
} from "@opentelemetry/api";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { setImmediate as nextTurn } from "node:timers/promises";

export function createTelemetry(service: string, endpoint?: string) {
  const provider = endpoint
    ? new TracerProvider({
        resource: resourceFromAttributes({ "service.name": service }),
        spanProcessors: [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({
              url: endpoint,
              timeoutMillis: 5_000,
            }),
            exportTimeoutMillis: 5_000,
          }),
        ],
      })
    : undefined;
  return {
    tracer: provider?.getTracer(service) ?? trace.getTracer(service),
    shutdown: async () => {
      // Callers drain work first; Elysia defers synchronous afterResponse hooks past app.stop().
      await nextTurn();
      await provider?.shutdown();
    },
  };
}

// Explicit attributes only: never record raw exceptions, HTTP bodies, headers or URLs.
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  options: SpanOptions,
  operation: (span: Span) => Promise<T>,
  parent?: Span,
): Promise<T> {
  const span = tracer.startSpan(
    name,
    options,
    parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT,
  );
  try {
    return await operation(span);
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
