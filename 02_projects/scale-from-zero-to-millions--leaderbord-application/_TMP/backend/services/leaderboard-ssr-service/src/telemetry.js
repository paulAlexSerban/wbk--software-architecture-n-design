const { NodeSDK } = require("@opentelemetry/sdk-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const logger = require("./logger");

const serviceName = process.env.OTEL_SERVICE_NAME || "leaderboard-ssr-service";
const traceEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
  "http://localhost:4318/v1/traces";
const metricsEndpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
  "http://localhost:4318/v1/metrics";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]:
      process.env.NODE_ENV || "development",
  }),
  traceExporter: new OTLPTraceExporter({
    url: traceEndpoint,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint,
    }),
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS) || 10000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": {
        enabled: false,
      },
    }),
  ],
});

let started = false;

async function startTelemetry() {
  if (started) return;
  await sdk.start();
  started = true;
  logger.info(
    { traceEndpoint, metricsEndpoint, serviceName },
    "OpenTelemetry initialized"
  );
}

async function shutdownTelemetry() {
  if (!started) return;
  await sdk.shutdown();
  started = false;
  logger.info("OpenTelemetry shutdown complete");
}

module.exports = {
  startTelemetry,
  shutdownTelemetry,
};
