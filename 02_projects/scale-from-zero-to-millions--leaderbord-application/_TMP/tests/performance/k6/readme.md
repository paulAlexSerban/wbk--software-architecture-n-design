# k6 Performance Test Suite

This suite provides repeatable smoke/load/stress/spike/soak tests for the leaderboard service.

## File Layout
- `main.js`: entrypoint, setup flow, summary output, and top-level traffic orchestration
- `config.js`: profile-specific scenario options and shared environment tags
- `metrics.js`: custom k6 metric registration and helpers for coverage and latency
- `requests.js`: individual endpoint checks such as health, HTML, JSON, and log probe calls
- `workflows.js`: higher-level tested flows such as full endpoint sweep and create-update-delete user lifecycle
- `helpers.js`: small shared utilities used by the test suite

## Test Profiles
- smoke: short sanity test, catches obvious breakage quickly
- load: expected sustained traffic profile
- stress: pushes beyond expected capacity to identify degradation boundaries
- spike: abrupt traffic surge and recovery behavior
- soak: long-running stability and leak detection

## Traffic Mix
Each iteration uses a read-heavy mix:
- GET /api/leaderboard
- GET /api/users
- GET /users
- GET /
- Write cycle (create -> update -> delete user)

The write cycle is intentionally low frequency but always included to expose locking/contention and write-path regressions.

## Running
Use package scripts from the service root, for example:
- yarn perf:smoke
- yarn perf:load
- yarn perf:stress
- yarn perf:spike
- yarn perf:soak

Baseline capture and comparison:
- yarn perf:baseline:before-sqlite
- yarn perf:baseline:after-sqlite
- yarn perf:compare

These commands run k6 in Docker so local k6 installation is not required.

## Output
- Structured console summary
- JSON summary at reports/k6-summary.json (inside repository)
- Baseline snapshots in reports/performance-baselines/<timestamp>-<label>
- Comparison reports in reports/performance-comparisons/
- Time-series metrics in Prometheus for Grafana dashboarding

Prometheus/Grafana tags emitted by k6:
- run_tag
- storage_layer
- baseline_label
- test_profile

## Practical Advice
- Run smoke in CI on each PR.
- Run load/stress before releases.
- Run soak on release candidates or after major dependency upgrades.
- Compare p95/p99 and error rates over time; avoid relying on average latency alone.
