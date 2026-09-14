/**
 * backend/telemetry.ts
 *
 * Optional OpenTelemetry setup module.
 *
 * Reads config.OTLP_ENDPOINT — if set, initialises an OTLP trace/metric
 * exporter and instruments `withRetry` calls with trace spans.
 *
 * Called once from backend/index.ts at startup.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { trace, Tracer, Span, SpanStatusCode } from '@opentelemetry/api';
import { config } from './config';
import { createLogger } from './utils/logger';

const log = createLogger('telemetry');

const tracer: Tracer = trace.getTracer('stellar-agent-kit');
let sdk: NodeSDK | null = null;

/**
 * Initialise the OpenTelemetry SDK with OTLP HTTP exporters if
 * config.OTLP_ENDPOINT is defined.  Idempotent — subsequent calls
 * are no-ops.
 */
export function initTelemetry(): void {
  const otlpEndpoint: string | undefined = (config as unknown as Record<string, unknown>)
    .OTLP_ENDPOINT as string | undefined;
  if (!otlpEndpoint) {
    log.info('OTLP_ENDPOINT not configured, skipping OpenTelemetry initialisation');
    return;
  }

  if (sdk) {
    log.warn('initTelemetry called but SDK is already running');
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    }),
    exportIntervalMillis: 10_000,
  });

  sdk = new NodeSDK({
    traceExporter,
    metricReaders: [metricReader],
    serviceName: 'stellar-agent-kit',
  });

  sdk.start();
  log.info({ endpoint: otlpEndpoint }, 'OpenTelemetry initialised');
}

/**
 * Return the active tracer (no-op tracer when telemetry is disabled).
 */
export function getTracer(): Tracer {
  return tracer;
}

/**
 * Create a trace span wrapping an async operation.
 *
 * @param name      - The span name (e.g. "withRetry")
 * @param fn        - The async function to instrument
 * @param attrs     - Optional key-value attributes to set on the span
 * @returns         - The return value of `fn`
 */
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  attrs: Record<string, string | number | boolean> = {}
): Promise<T> {
  const span: Span = tracer.startSpan(name);
  try {
    for (const [key, value] of Object.entries(attrs)) {
      span.setAttribute(key, value);
    }
    const result = await fn();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Gracefully shut down telemetry, flushing pending spans.
 * Safe to call even when telemetry was never initialised.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    log.info('OpenTelemetry shut down');
  }
}
