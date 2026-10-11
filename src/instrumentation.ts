import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  detectResourcesSync,
  envDetector,
  Resource,
} from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// Standard OTel env vars (read via envDetector below):
//   OTEL_EXPORTER_OTLP_ENDPOINT     — HTTP collector (default: http://localhost:4318)
//   OTEL_EXPORTER_OTLP_HEADERS      — auth headers (key=value,key2=value2)
//   OTEL_SERVICE_NAME               — service name
//   OTEL_RESOURCE_ATTRIBUTES        — e.g. deployment.environment=production
//   OTEL_TRACES_SAMPLER / _ARG      — sampling (default: parentbased_always_on)
//
// Custom env vars (read manually below):
//   GIT_HASH                        — mapped to service.version
//   OTEL_METRIC_EXPORT_INTERVAL     — metric flush interval in ms (default 60000)
//                                     (PeriodicExportingMetricReader doesn't read this automatically)

export interface OtelSDK {
  tracerProvider: BasicTracerProvider;
  meterProvider: MeterProvider;
  shutdown: () => Promise<void>;
}

export function setupOtel(): OtelSDK {
  // BasicTracerProvider doesn't auto-read OTEL_* env vars — use envDetector explicitly.
  // envDetector reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
  const resource = detectResourcesSync({ detectors: [envDetector] }).merge(
    new Resource({
      [ATTR_SERVICE_VERSION]: process.env.GIT_HASH ?? "unknown",
    }),
  );

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------
  const traceExporter = new OTLPTraceExporter();
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  // AsyncLocalStorage is supported by Bun — use it for context propagation so
  // that startActiveSpan correctly tracks parent-child span relationships.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  // diagnostics_channel-based — no module patching, works in Bun.
  // Captures all undici HTTP requests, including those made by discord.js.
  registerInstrumentations({
    instrumentations: [new UndiciInstrumentation()],
  });

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  const metricExporter = new OTLPMetricExporter();
  const parsed = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? "", 10);
  const exportIntervalMillis = Number.isNaN(parsed) ? 60_000 : parsed;

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const shutdown = async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  };

  return { tracerProvider, meterProvider, shutdown };
}
