import { trace } from "@opentelemetry/api";
import pino from "pino";

const logger = pino({
  level: "debug",
  mixin() {
    const span = trace.getActiveSpan();
    if (!span) return {};
    const { traceId, spanId, traceFlags } = span.spanContext();
    if (!traceId) return {};
    return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
  },
});

export function initLogger(level: string) {
  logger.level = level;
}

export function getLogger(module: string) {
  return logger.child({ module });
}

export default logger;
