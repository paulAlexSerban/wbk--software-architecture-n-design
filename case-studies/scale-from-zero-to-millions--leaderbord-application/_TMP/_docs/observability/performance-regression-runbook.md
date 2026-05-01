# Runbook: Performance Regression Investigation

## Trigger Conditions
Use this runbook when any of the following occurs:
- perf baseline compare marks key metrics as regressed
- p95/p99 worsens unexpectedly
- error rates increase after persistence or dependency changes

## Fast Triage
1. Confirm reproducibility
- rerun the same profile at least 2 more times
- verify trend consistency, not single-run noise

2. Confirm environment parity
- same machine or equivalent resources
- same Docker limits
- no extra background load

3. Confirm test parity
- same profile set
- same k6 script version
- same endpoint mix

## Focus Areas for SQLite Migration
- Read path changes in list and detail queries
- Write transaction overhead and lock contention
- Statement preparation and connection management
- Missing indexes for lookup-heavy endpoints

## Practical Investigation Steps
1. Compare profile-specific quick summaries
- reports/performance-baselines/<run>/profiles/<profile>/quick-summary.json

2. Inspect full raw k6 summaries
- reports/performance-baselines/<run>/profiles/<profile>/k6-summary.json

3. Correlate with observability dashboards
- Traces Overview
- Metrics Overview
- Client-Server Overview
- MVC Overview

4. Isolate regression class
- throughput-only
- latency-tail-only
- error-rate-only
- mixed

## Recovery Actions
- Add/adjust SQLite indexes for hot filters and joins
- Optimize transaction boundaries for write endpoints
- Reduce synchronous serialization in hot paths
- Re-run smoke + load after each targeted fix

## Exit Criteria
Close the incident only when:
- regression is no longer reproducible
- before/after comparison confirms recovery
- a written note exists with root cause and fix
