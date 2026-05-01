# Observability Document: Leaderboard SSR Service

## Overview
This document describes the observability layer for the Leaderboard SSR service, including the telemetry stack, data flow, dashboard intent, and setup workflow.

The implementation provides end-to-end visibility across:
- Request lifecycle and route performance
- Error rates and status-code quality
- Structured logs for operational debugging
- MVC architecture behavior (Controller, View, Model, DB)

## Observability Stack

### Components
- Application: Node.js + Express + Handlebars SSR service
- Logging: Pino + pino-http (JSON logs)
- Instrumentation: OpenTelemetry SDK for traces and metrics
- Collector: OpenTelemetry Collector Contrib
- Storage: ClickHouse (OTel tables)
- Visualization: Grafana + ClickHouse datasource plugin

### Runtime Endpoints (Docker Compose)
- App: http://localhost:3000
- Grafana: http://localhost:3001
- OTel Collector gRPC OTLP: localhost:4317
- OTel Collector HTTP OTLP: localhost:4318
- ClickHouse HTTP: localhost:8123
- ClickHouse Native: localhost:9000

### Core Configuration Files
- App compose and services: backend/services/leaderboard-ssr-service/docker-compose.yml
- Collector pipelines: backend/services/leaderboard-ssr-service/observability/otel/collector-config.yaml
- Grafana datasource: backend/services/leaderboard-ssr-service/observability/grafana/provisioning/datasources/clickhouse.yaml
- Grafana dashboard provisioning: backend/services/leaderboard-ssr-service/observability/grafana/provisioning/dashboards/dashboards.yaml

## Telemetry Model: What Is Traced and How

### Traces
The service emits traces for HTTP requests and architecture-specific execution.

HTTP/request trace behavior:
- Request spans are created per request.
- Span names are normalized to route patterns when available.
- Status code and request attributes are attached.
- Server errors are marked with span error status.

MVC trace behavior:
- Controller spans: one per controller action invocation
- View spans: one per Handlebars render
- Model spans: one per model operation
- DB spans: one per data access operation

Primary MVC attributes used for analysis:
- mvc.layer
- mvc.controller
- mvc.action
- mvc.transport
- mvc.view
- mvc.model
- mvc.operation
- db.operation

### Metrics
The service emits both standard HTTP metrics and custom MVC metrics.

Custom MVC metrics include:
- mvc.controller.invocations
- mvc.view.render.count
- mvc.view.render.duration
- mvc.model.operation.count
- mvc.model.operation.duration
- mvc.db.operation.count
- mvc.db.operation.duration

### Logs
- Application logs are emitted as JSON.
- Logs are written to a shared volume in Docker.
- Collector ingests file logs and OTLP logs, then exports to ClickHouse.

## Data Flow
1. The app emits traces and metrics via OTLP to the OTel Collector.
2. The app writes JSON logs to the app log volume.
3. The OTel Collector receives OTLP telemetry and file logs.
4. The OTel Collector exports traces, logs, and metrics to ClickHouse.
5. Grafana queries ClickHouse through the provisioned ClickHouse datasource.
6. Dashboards visualize service health, latency, errors, and architecture-layer behavior.

## ClickHouse OTel Tables in Use
- otel.otel_traces
- otel.otel_traces_trace_id_ts
- otel.otel_traces_trace_id_ts_mv
- otel.otel_logs
- otel.otel_metrics_sum
- otel.otel_metrics_gauge
- otel.otel_metrics_histogram
- otel.otel_metrics_exponential_histogram
- otel.otel_metrics_summary

## Dashboards and Their Purpose

### Traces Overview
File: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/traces-overview.json

Purpose:
- Trace-level golden signals for span volume, failures, and latency.

What it shows:
- Total spans, error spans, error rate
- Average span duration
- Throughput and duration trends
- Top operations and slow spans

How it traces:
- Queries span records from otel.otel_traces.
- Uses status and span duration fields to detect failures and hotspots.

### Logs Overview
File: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/logs-overview.json

Purpose:
- Operational logging overview for debugging and incident triage.

What it shows:
- Log rate over time
- Severity distribution
- Recent logs table
- Error/warn trends and top error messages

How it traces:
- Queries otel.otel_logs.
- Uses severity and message fields for error concentration analysis.

### Metrics Overview
File: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/metrics-overview.json

Purpose:
- Service-level KPI dashboard for request volume, errors, route mix, and latency.

What it shows:
- Total requests
- Error rate and 4xx/5xx trends
- Request throughput and request rate
- HTTP method and status code distributions
- Top routes by request count
- Response-time trends

How it traces:
- Uses OTel metric tables for request and status aggregations.
- Uses trace-derived latency for reliable response-time panels.

### Client-Server Overview
File: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/client-server-overview.json

Purpose:
- Architecture-focused health view for HTTP client-server behavior.

What it shows:
- Throughput, p95 latency, 5xx error rate, availability
- Status class distribution
- Method mix and endpoint volume
- Top 4xx paths and unmapped route share
- Visibility checks for additional OTel metric/trace helper tables

How it traces:
- Combines otel.otel_traces with metrics tables.
- Includes visibility panels for otel_metrics_sum/gauge/exponential_histogram/summary and trace lookup tables.

### MVC Overview
File: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/mvc-overview.json

Purpose:
- Architecture dashboard specific to the MVC presentational pattern.

What it shows:
- Controller, View, Model, DB span volume
- Per-minute controller activity
- Layer latency trend by mvc.layer
- Layer share
- Top controller actions (calls, avg, p95, errors)
- View render performance
- Model/DB hotspots
- Presence of custom mvc.* metrics

How it traces:
- Relies on custom span attributes attached by MVC instrumentation.
- Uses otel.otel_traces for latency and operation breakdown.
- Uses otel.otel_metrics_histogram to validate custom MVC metric streams.

## Setup Overview

### Prerequisites
- Docker Desktop running
- Ports 3000, 3001, 4317, 4318, 8123, 9000 available

### Start the Full Stack
From backend/services/leaderboard-ssr-service:
- docker compose up --build

### Access
- App: http://localhost:3000
- Grafana: http://localhost:3001 (admin/admin)

### Reinitialize (If Credentials/Schema Drift Exists)
- docker compose down -v
- docker compose up --build

## Verification Checklist
- App responds on / and /api routes.
- Grafana datasource ClickHouse is healthy.
- Observability folder dashboards are visible under Grafana folder Observability.
- Traces appear in trace dashboards after traffic is generated.
- Logs appear in Logs Overview.
- Metrics populate Metrics Overview and Client-Server Overview.
- MVC spans and mvc.* metrics populate MVC Overview after using HTML and API routes.

## Operational Notes
- Current dashboard design intentionally favors trace-derived latency where cumulative metric temporality can produce misleading latency math.
- No additional Grafana plugin is required beyond grafana-clickhouse-datasource.
- No additional OTel tables are required for current observability scope.

## Related Runbook
- k6 performance testing guide: _docs/observability/performance-testing-k6.md
