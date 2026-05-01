# Playbook: SQLite Migration Performance Validation

## Objective
Validate whether moving from JSON-file persistence to SQLite improves overall system behavior under realistic load.

## Success Criteria
A migration is performance-positive only if most of the following hold:
- p95 and p99 request latency improve or remain flat
- error rates (http_req_failed, business_failures) do not regress
- throughput does not regress under the same test profiles
- write-path latency (POST/PUT/DELETE) does not regress materially

## Scope
Measured endpoints align to architecture document:
- GET /
- GET /users
- GET /users/:id
- GET /api/leaderboard
- GET /api/users
- GET /api/users/:id
- POST /api/user
- PUT /api/user/:id
- DELETE /api/user/:id

## Procedure
1. Baseline current JSON persistence
- yarn perf:baseline:before-sqlite

2. Implement SQLite persistence
- preserve endpoint contracts and response shapes
- avoid unrelated performance-affecting changes during migration

3. Capture post-migration baseline
- yarn perf:baseline:after-sqlite

4. Compare
- yarn perf:compare

5. Review comparison report
- reports/performance-comparisons/compare-*.md

6. Validate trend in Grafana
- Use k6 Performance Overview dashboard
- Filter run_tag to before-sqlite and after-sqlite captures
- Confirm tail-latency and error behavior align with comparison report

## Decision Gates
Promote migration if:
- p95 and p99 improve for load profile OR stay within 2% while write-path reliability improves
- no profile shows meaningful (>2%) regression in failure metrics

Hold migration if:
- p99 regresses and error rate regresses together
- throughput improves but business failures increase
- only averages improve while tail latency worsens materially

## Brutal Truth Checklist
- Did you run before/after on equivalent hardware conditions?
- Did you keep profile mix and thresholds unchanged?
- Did you verify both read and write endpoint behavior?
- Are you claiming success on p95/p99 and errors, not only avg?

If any answer is no, your comparison is weak evidence.
