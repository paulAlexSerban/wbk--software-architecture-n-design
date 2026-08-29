# Batch Enrichment Pipeline: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A batch enrichment job that reads a CSV, calls an external HTTP API once per row, and writes the result to Postgres — **fast enough that the wall-clock is dominated by the API's actual capacity, not by our own serial waste**, and **safe enough that a six-hour (or 5.5-hour) run can fail at hour four without throwing away four hours of work**.

This is not a platform. It is a **throughput-and-correctness problem under an external bottleneck**. The design exists to stop pretending concurrency is a strategy when the API is the ceiling, and to refuse to ship "faster" that quietly drops, duplicates, or reprocesses rows.

## Business Context
- **Current job**: a script reads ~200,000 CSV rows, issues one HTTP request per row, writes each result to Postgres. It takes about six hours. That number is the entire problem statement.
- **Consumer**: whoever needs the enriched table — typically a downstream report, a product feature, or an ops workflow that cannot start until the table is complete. They do not care about worker pools. They care that the run finishes, that the row count matches, and that they are not asked to "just re-run it" after a mid-job crash.
- **Operator**: a small engineering team that owns the script, the API credential, and the Postgres instance. They will be the ones who get paged when the job is still running at 3 a.m., or when a retry storm 429s the vendor.
- **External API owner**: a third party. They are not going to rewrite their API this week. They may later disclose a hard limit of 10 requests per second. That disclosure does not change the pipeline's shape; it changes the honest conversation about how fast "faster" can be.
- **Organizational reality**: "make it faster" will be asked before anyone has measured where the six hours went. The architecture treats measurement as Phase 0, not as optional hygiene after a rewrite.

## The Math (the actual requirement)

This is the constraint that every other document in this project exists to respect. It is not a performance target. It is a diagnosis.

| Quantity | Value | What it means |
| --- | --- | --- |
| Rows | 200,000 | One HTTP call each, by the current contract |
| Observed wall-clock | ~6 hours = 21,600 s | The only measured number we currently have |
| Time per row (average) | 21,600 / 200,000 ≈ **108 ms** | One cheap round-trip's worth of time, spent serially |
| Observed throughput | 200,000 / 21,600 ≈ **9.26 req/s** | Already close to a common documented API cap |
| Hard floor at 10 req/s | 200,000 / 10 = 20,000 s ≈ **5 h 33 m** | No amount of concurrency beats this if the contract is 1 call/row |
| Best-case win at 10 req/s | 6 h → 5 h 33 m, **~7% faster** | The rate limit does not "kill the optimization"; it reveals there was never a 10× win available |

`200,000 rows × ~108 ms, nothing overlapped` is the signature of a **fully serial, blocking HTTP round-trip per row**. CSV parsing of 200,000 rows is milliseconds-to-seconds, not hours. A well-tuned Postgres insert of a single row is sub-millisecond to a few milliseconds on a local or same-region instance. Neither of those, even done badly, produces a 108 ms/row average by themselves.

Three load-bearing unknowns sit on top of that arithmetic and must be resolved in Phase 0, not guessed:

1. **Where the 108 ms actually is.** The hypothesis is HTTP wait. It could also be a new TCP/TLS handshake per call (which *is* HTTP wait, just a worse kind), or a per-row `COMMIT` that is slower than expected because the database is remote or under lock contention. The ranking in [Trade-offs](./05_tradeoffs_and_honest_assessment.md) is a prior, not a fact. Phase 0 exists to turn it into a fact.
2. **Whether the API already throttles, silently or with 429s.** A job averaging 9.26 req/s for six hours might already be brushing an unpublished limit, or it might have headroom. Bursting to 100 concurrent requests without measuring this is how you turn a slow job into a banned credential.
3. **Whether the write is actually 1:1 with success.** If the current script retries without idempotency, "200,000 rows in, 200,000 rows out" may already be a lie on a re-run. Faster is worthless if the table cannot be trusted.

**The conclusion, which is not optional:** stop treating this as "a slow script that needs threads." Treat it as a **rate-limited enrichment pipeline** whose wall-clock is owned by the API, whose waste is owned by us (serial calls, new connections, per-row commits, no resume), and whose correctness is owned by idempotent writes plus checkpoints. The 10 req/s disclosure, when it comes, is a configuration of that pipeline, not a redesign.

## Two worlds, one pipeline

The same system is designed for two capacity regimes. They are not two architectures.

| Regime | Ceiling | Honest wall-clock for 200k × 1 call/row | What "faster" means |
| --- | --- | --- | --- |
| Unconstrained (no documented cap, unknown real cap) | Unknown — must be discovered by measurement, not assumed | Could be minutes if the API and our client are both healthy; could still be hours if the API is slow or silently throttled | Overlap wait time, reuse connections, batch writes, find the *actual* ceiling before celebrating |
| Hard 10 req/s | 10 successful-or-attempted requests per second, including retries | **5 h 33 m** plus retry overhead, plus our incidental waste | Sustain ≤10/s without 429 storms; shave our waste; make the run resumable so 5.5 hours is not a single fragile shot |

The unconstrained world is the one in which concurrency has a large payoff *if* the API actually answers faster than it is currently being asked. The 10 req/s world is the one in which concurrency's job is **pacing**, not speed. Stakeholders who heard "we will parallelize it" need to hear the second table before Phase 2 starts, not after a rewrite that produces a 5-hour-40-minute job and a confused post-mortem.

## Core Value Propositions
1. **Measure before rewriting.** A six-hour number without a breakdown is not a performance problem, it is an un-instrumented one. The first deliverable is a per-phase timing split (parse / HTTP wait / DB write / other) on a fixed sample, not a new framework.
2. **Spend engineering effort only where the math pays.** Connection reuse and batched writes are cheap and help in both worlds. Unbounded parallelism is expensive and helps in neither. A token-bucket limiter is mandatory in the 10 req/s world and still wise in the unconstrained world.
3. **Correctness is part of "faster."** A job that finishes in 5.5 hours with duplicate keys, or that must restart from row 0 after a crash at 80%, is not faster. Idempotent upserts and checkpoints are not optional hardening; they are what makes a multi-hour run an operable artifact.
4. **Sustain the allowed rate; do not burst it.** Retries consume the same budget as new rows. A "faster" client that 429s and retries is slower, and may lose the credential. The limiter is a first-class component, not a `sleep()` in a catch block.
5. **Tell the business the floor before promising the win.** If 5 h 33 m is still too slow, the next move is a conversation with the API owner (batch endpoint, higher quota, bulk export) — not another weekend spent on worker-pool tuning. See [Phased Implementation Plan — Phase 4](./06_phased_implementation_plan.md#phase-4--conditional-capacity-negotiation).

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0 against a held-out sample**, not facts.

1. **Wall-clock vs. the honest floor.** In the unconstrained regime, wall-clock should be dominated by API latency under a measured safe concurrency, not by connection setup or per-row commits. In the 10 req/s regime, wall-clock for a clean run (no retries) should sit close to 5 h 33 m plus a small, measured overhead — not six-plus hours of self-inflicted idle. Missing the floor by a lot after Phase 1–2 means we still have waste; beating the floor is a measurement error or a contract violation.
2. **Quota waste rate.** Fraction of requests that are retries of already-attempted rows, duplicate fetches of already-checkpointed rows, or 429-driven repeats. After Phase 3, this should trend toward near-zero on a healthy run. If it does not, the limiter or the checkpoint is lying.
3. **Correctness on every canary and full run.** Row count in Postgres equals unique successful enrichments; no duplicates on resume; a checksum or source-id set comparison against the CSV passes. A faster run that fails this is a defect, not a ship.
4. **Resume residual.** After a simulated kill at ~50% and ~90%, a restart completes the remainder without re-calling the API for already-persisted rows (or, if a small replay window is accepted, that window is bounded and documented). Residual work should be proportional to unprocessed rows, not to "the whole file again."
5. **Error rate under the cap.** Sustained 429 rate near zero when the limiter is set at or under the documented cap. A non-zero 429 rate that is "handled" by retry is a design failure, not operational excellence — those retries steal from the 10/s budget.

## Business Rules
1. **No behavior change before a baseline.** Phase 0 instruments the existing script (or an equivalent slice) and does not ship concurrency, batching, or a limiter. Optimizations that skip this are not allowed to claim credit.
2. **One change at a time, sample-verified.** Each optimization in [Phased Implementation Plan](./06_phased_implementation_plan.md) has an exit gate that is a before/after on a fixed representative sample (on the order of 5,000 rows), plus a correctness check. Bundling "async + batching + retries + checkpoints" into one PR is how you get a faster, wrong job and no idea which change did what.
3. **The limiter observes 429 and `Retry-After`, not just the documented number.** A "hard limit of 10/s" is a starting budget. Other consumers may share the credential; the window may be a clock-second rather than a rolling window; the vendor may lie. Bursting to "use the remaining 10 at millisecond 999" is forbidden.
4. **Writes are idempotent on a source-row identity.** Re-processing a row must upsert, not insert-again. There is no "at-least-once is fine, we'll dedupe later" exception for v1 — later is how duplicates become a week of cleanup.
5. **A run that cannot resume is not done.** Multi-hour jobs fail. Network blips, deploys, OOM, operator interrupt. Checkpointing is an exit gate of Phase 3, not a nice-to-have.
6. **If 5 h 33 m is unacceptable, stop tuning and start negotiating.** Phase 4 is a conversation (batch API, higher cap, bulk file), not a new concurrency framework. The architecture will not promise to outrun a hard 10 req/s × 1-call-per-row contract.

## Pipeline Consumers
This is an internal batch job, not a product; its surface area is operational:

1. **Downstream consumer**: needs the Postgres table complete and trustworthy. This person is why silent incompleteness or silent duplicates are treated as first-class failures.
2. **Pipeline operator**: owns the cron/job runner, the API credential, the database, the checkpoint, and the alert when the job will miss its window or the limiter has been in backoff too long.
3. **API owner (external)**: not in the runtime path, but the source of the only scarce resource. Phase 0 and Phase 4 ask them things; a "no" is the expected steady state and does not block Phases 1–3.
