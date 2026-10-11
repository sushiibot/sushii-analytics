import { type Attributes, type Tracer, SpanStatusCode } from "@opentelemetry/api";

/**
 * Returns a `withSpan` helper bound to the given tracer.
 *
 * Call once per module, then use the returned function to wrap operations
 * in a span with automatic error recording and status setting.
 *
 *   const tracer = trace.getTracer("sushii-analytics/module-name");
 *   const withSpan = createSpanHelper(tracer);
 *
 *   return withSpan("thing.action", { guildId }, async () => { ... });
 *
 * trace.getTracer() is cheap — it returns a proxy to the global provider and
 * is safe to call before setupOtel() runs.
 */
export function createSpanHelper(tracer: Tracer) {
  return async function withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: () => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan(name, async (span) => {
      span.setAttributes(attributes);
      try {
        return await fn();
      } catch (err) {
        span.recordException(err instanceof Error ? err : String(err));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
