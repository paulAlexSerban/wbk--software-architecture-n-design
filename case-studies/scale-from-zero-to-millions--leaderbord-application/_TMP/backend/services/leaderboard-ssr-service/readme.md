# Leaderboard SSR Service

This service is responsible for rendering the leaderboard page on the server side. It fetches the necessary data from the database and renders the HTML using a template engine.

## Run Locally
```bash
yarn install
yarn start
```

The service starts on `http://localhost:3000`.

## Run With Docker
```bash
docker compose up --build
```

This starts the app plus the observability stack.

## Observability Stack (Docker)

Services started by `docker compose up --build`:
- Leaderboard app: `http://localhost:3000`
- Grafana: `http://localhost:3001` (admin/admin)
- OpenTelemetry Collector OTLP endpoints: `localhost:4317` (gRPC), `localhost:4318` (HTTP)
- ClickHouse: `localhost:8123` (HTTP), `localhost:9000` (native)

Default ClickHouse credentials used by the stack:
- Database: `otel`
- Username: `otel`
- Password: `otel`

You can override them with environment variables before running compose:
- `CLICKHOUSE_DATABASE`
- `CLICKHOUSE_USERNAME`
- `CLICKHOUSE_PASSWORD`

What is wired:
- Node.js app emits OpenTelemetry traces using auto-instrumentation.
- Node.js app emits OpenTelemetry metrics using OTLP HTTP.
- Node.js app writes Pino JSON logs to `/var/log/app/app.log` inside the container.
- OTel Collector receives traces and exports them to ClickHouse (`otel.otel_traces`).
- OTel Collector receives metrics via OTLP and exports them to ClickHouse.
- OTel Collector ingests app logs from the shared log volume (`filelog` receiver) and exports them to ClickHouse.
- Grafana is provisioned with the ClickHouse datasource plugin and a prebuilt `Traces Overview` dashboard.

Grafana provisioning files:
- `observability/grafana/provisioning/datasources/clickhouse.yaml`
- `observability/grafana/provisioning/dashboards/dashboards.yaml`
- `observability/grafana/dashboards/traces-overview.json`

Collector config:
- `observability/otel/collector-config.yaml`

If you already had an old ClickHouse volume with different credentials, recreate the observability volumes once so the new defaults apply:
```bash
docker compose down -v
docker compose up --build
```
