import { Counter, Rate, Trend } from "k6/metrics";

const businessFailures = new Rate("business_failures");
const endpointCoverage = new Rate("endpoint_coverage");
const apiLatencyMs = new Trend("api_latency_ms", true);
const htmlLatencyMs = new Trend("html_latency_ms", true);
const writeOpsTotal = new Counter("write_ops_total");

function recordLatency(path, response, type) {
  const duration = response.timings.duration;
  if (type === "api") {
    apiLatencyMs.add(duration, { endpoint: path });
  } else {
    htmlLatencyMs.add(duration, { endpoint: path });
  }
}

function markCoverage(endpoint, ok) {
  endpointCoverage.add(ok ? 1 : 0, { endpoint });
}

export {
  apiLatencyMs,
  businessFailures,
  endpointCoverage,
  htmlLatencyMs,
  markCoverage,
  recordLatency,
  writeOpsTotal,
};