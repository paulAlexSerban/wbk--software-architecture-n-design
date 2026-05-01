# How-To: Capture Performance Baseline Before and After SQLite

## Goal
Create trustworthy before/after performance evidence so SQLite impact can be measured instead of guessed.

## Preconditions
- Docker is running
- Service stack starts cleanly
- No heavy background workloads on your machine
- You run both baseline captures under similar environment conditions

## Step 1: Start stack
From backend/services/leaderboard-ssr-service:

- docker compose up -d --build

## Step 2: Capture pre-SQLite baseline (JSON storage)
- yarn perf:baseline:before-sqlite

This creates a timestamped folder in:
- backend/services/leaderboard-ssr-service/reports/performance-baselines/

Artifacts include:
- metadata.json
- summary.json
- summary.md
- profiles/<profile>/k6-summary.json

## Step 3: Migrate persistence to SQLite
- Implement SQLite persistence layer
- Keep test profiles unchanged
- Keep host/resource conditions as close as possible to Step 2

## Step 4: Capture post-SQLite baseline
- yarn perf:baseline:after-sqlite

## Step 5: Generate comparison report
- yarn perf:compare

The report is written to:
- backend/services/leaderboard-ssr-service/reports/performance-comparisons/

## Step 6: Inspect in Grafana (k6 dashboard)
- Open Grafana at http://localhost:3001
- Open dashboard: k6 Performance Overview
- Filter by run_tag and test_profile
- Compare before-sqlite and after-sqlite runs visually for p95/p99, failure rate, request rate

## Optional: Include soak in baseline run
- yarn perf:baseline:with-soak

## What to watch
Priority metrics:
- http_req_duration_p95_ms
- http_req_duration_p99_ms
- http_req_failed_rate
- business_failures_rate
- http_reqs_rate

Interpretation rule:
- Lower latency/error is better
- Higher throughput/check success is better

## Common mistakes
- Comparing runs from different hardware conditions
- Changing test profiles between before/after
- Declaring success based only on average latency
- Ignoring error-rate regressions while celebrating throughput gains
