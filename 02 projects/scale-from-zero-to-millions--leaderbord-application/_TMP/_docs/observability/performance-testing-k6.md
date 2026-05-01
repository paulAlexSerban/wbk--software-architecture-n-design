# Performance Testing with k6

## Purpose
This runbook defines repeatable performance tests for the leaderboard service using k6.

Goals:
- Detect performance regressions before production
- Quantify sustainable load and failure boundaries
- Measure behavior during sudden traffic spikes
- Validate long-run stability under steady traffic

## What Was Implemented
- k6 test suite: backend/services/leaderboard-ssr-service/performance/k6/main.js
- Test profile guide: backend/services/leaderboard-ssr-service/performance/k6/readme.md
- Docker Compose k6 runner service (profile: perf)
- Prometheus remote-write receiver for k6 metrics
- Grafana Prometheus datasource provisioning
- Grafana dashboard: backend/services/leaderboard-ssr-service/observability/grafana/dashboards/k6-overview.json
- Service scripts:
  - yarn perf:smoke
  - yarn perf:load
  - yarn perf:stress
  - yarn perf:spike
  - yarn perf:soak

## Test Profiles

### smoke
- Short sanity test
- Use on pull requests and before deeper tests
- Catches obvious failures (5xx, broken routes, serialization errors)

### load
- Expected/target steady traffic profile
- Use as the baseline for performance acceptance
- Primary KPI source for release decisions

### stress
- Pushes above expected load
- Identifies the knee point where p95/p99 latency and error rate degrade
- Helps choose safe operating headroom

### spike
- Sudden surge then recovery
- Evaluates resilience to bursty traffic and post-spike stabilization

### soak
- Long-running profile
- Detects memory leaks, GC pressure growth, and throughput drift over time

## Workload Design
The script intentionally uses a read-heavy but realistic mix:
- GET /api/leaderboard
- GET /api/users
- GET /users
- GET /
- Low-frequency write cycle: POST /api/user -> PUT /api/user/:id -> DELETE /api/user/:id

Why writes are included:
- Pure read tests hide write-path contention and data mutation issues.
- Even low write percentages can destabilize p95 under load.

## Metrics and Quality Gates
The suite enforces thresholds on:
- http_req_failed
- http_req_duration (global and endpoint-specific)
- checks
- business_failures (custom metric)
- API/HTML latency trends

Thresholds are intentionally strict enough to catch regressions early, but should be tuned with historical baselines from your environment.

## How to Run
From backend/services/leaderboard-ssr-service:

1. Start application stack
- docker compose up -d --build

2. Execute a profile
- yarn perf:smoke
- yarn perf:load
- yarn perf:stress
- yarn perf:spike
- yarn perf:soak

3. Review output
- Console summary from k6
- JSON report at backend/services/leaderboard-ssr-service/reports/k6-summary.json
- Prometheus metrics visible in Grafana dashboard k6 Performance Overview

## Best Practices for Reliable Numbers
- Warm up before collecting baseline results.
- Run each profile at least 3 times and compare median of p95/p99.
- Keep test environment stable (same CPU/memory limits, no background jobs).
- Record app image hash and config for every run.
- Treat averages as secondary; prioritize p95, p99, and error rate.
- Use the same dataset shape and cardinality when comparing runs.

## Brutally Honest Assessment
Current architecture constraints that will cap performance:
- Single Node.js service instance (no horizontal scaling)
- File-based JSON datastore for reads/writes (not a production-grade storage layer)
- No cache tier for hot leaderboard reads
- No queueing/backpressure strategy for write bursts
- No autoscaling or admission control in front of the service

What this means:
- You can obtain useful comparative numbers and detect regressions now.
- You cannot claim production-scale readiness for millions of users from these tests alone.
- If stress/spike tests fail early, that is expected with this architecture, not a testing defect.

## Minimum Next Steps for Better Numbers
1. Move data path from JSON file to a real database with indexing.
2. Add cache (for leaderboard and user-list hot paths).
3. Add horizontal scaling and load balancing.
4. Add resource limits and capacity tests at the container level.
5. Add automated trend comparison in CI (fail builds on regression).

## Related Docs
- How-to baseline capture: _docs/observability/how-to-capture-performance-baseline.md
- SQLite migration playbook: _docs/observability/sqlite-migration-performance-playbook.md
- Regression runbook: _docs/observability/performance-regression-runbook.md
