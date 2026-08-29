# Batch Enrichment Pipeline — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–3 are sequential. Phase 4 is conditional and may never trigger. Standing rollback criteria apply at every phase.

The frozen 5,000-row `sample.csv` and the confirmation protocol in [System Design §1](./03_system_design.md#1-instrumentation-exists-before-any-optimization) are assumed from Phase 0 onward.

## Phase 0 — Instrument and Baseline (no behavior change)

**Objective**: Turn "it takes six hours" into a per-phase breakdown on a representative sample, and confirm or refute the serial-HTTP hypothesis **before writing a worker pool**. Also learn whether the API is idempotent and whether a stable `source_id` exists.

**Deliverables**:
- Timers and counters on the **existing** script (or a wrap that does not change request/commit grouping): `parse`, `http_connect`, `http_ttfb`, `http_total`, `db_commit`, plus run-level HTTP status counts.
- Frozen `sample.csv` (≈5,000 rows, representative).
- Written note: identity column or derived key; whether the HTTP call is safe to replay; whether 429s already appear at current ~9.26 req/s.
- Optional, once: a written ask to the API owner for documented limits, `Retry-After` behavior, batch endpoints. A no/silence does not block Phase 1.

**Exit Gate**:
- [ ] Sample run produces histograms; instrumentation overhead vs. an uninstrumented sample is a few percent or less.
- [ ] Hypothesis is **confirmed** (HTTP dominates ~108 ms/row) **or explicitly refuted** with a new ranked bottleneck. If refuted, this plan's Phase 1–2 order is rewritten before code lands — do not "continue anyway."
- [ ] `source_id` strategy is decided. If none exists, Phase 1 does not start.
- [ ] If the API is non-idempotent without a key, concurrency (Phase 2) is blocked until an idempotency key exists; Phase 1 (keep-alive, batching of *our* writes) may still proceed.

## Phase 1 — Low-risk waste removal (keep-alive + batched writes)

**Objective**: Remove incidental serial costs that help in **both** capacity regimes, without yet overlapping API calls.

**Deliverables**:
- Shared HTTP client with keep-alive / connection pooling; still one in-flight request if the loop is still serial.
- Batch upsert writer with chunked transactions ([ADR-004](./04_architecture_decision_records.md#adr-004)). Unique `source_id` exists even if checkpoint/resume is still Phase 3 — a unique constraint now prevents a silent duplicate later.
- Before/after report on `sample.csv` for **each** of the two changes, landed separately or with attribution runs in between, not as an unseparated blob.

**Exit Gate**:
- [ ] Keep-alive: `http_connect` collapsed or documented as already negligible; error rate not worse.
- [ ] Batching: commit count dropped; `db_commit` per row-equivalent dropped or documented as already negligible.
- [ ] Correctness: distinct `source_id` count = successes; payload check on a subset.
- [ ] No 429 increase (there should be none; you have not raised concurrency yet).

## Phase 2 — Bounded concurrency + rate limiter

**Objective**: Overlap HTTP wait up to a **safe** `r`, then hold. In the unconstrained world, discover `r`. In the 10 req/s world, set `r` to 10 (or slightly under) and prove you can **sustain** it without 429s.

This phase introduces the pool, the limiter, and the in-process queue together because a pool without a limiter is unsafe to test against a real vendor. Attribution vs. Phase 1 is still possible: wall-clock and in-flight `N` are the variables; the limiter is the safety interlock.

**Deliverables**:
- Token-bucket limiter on every attempt ([ADR-002](./04_architecture_decision_records.md#adr-002)).
- Worker pool sized from Little's law; hard cap on `N` and queue depth `D` ([ADR-001](./04_architecture_decision_records.md#adr-001), [ADR-003](./04_architecture_decision_records.md#adr-003)).
- Global 429 / `Retry-After` cooldown.
- Canary path (sample table or filtered keyspace) using the same code as full run.
- Run flags: `r`, `b`, `N`, batch size — **no code fork** between regimes ([System Design §10](./03_system_design.md#10-configuration-surface-run-parameters-not-code-forks)).

**Exit Gate**:
- [ ] Unconstrained: sample wall-clock improved vs. Phase 1 until 429s or p99 climb; chosen `r`/`N` documented; 429 rate ~0 at that point.
- [ ] 10 req/s regime (when applicable): sustained successful throughput on the sample ≈ 10/s (or the configured slightly-under value); 429 ≈ 0; canary treated as **failed** if 429s are non-trivial.
- [ ] Queue never unbounded; memory stable for a soak longer than the sample (e.g. 15–30 minutes) if the sample is too short to see a leak.
- [ ] Correctness check still green.
- [ ] First full 200k run of this phase is watched, abortable, and compared to the 5 h 33 m floor when `r = 10`: wall-clock must not be magically far below the floor (that is a row-count or limiter bug); must not sit at six-plus hours without an explained waste term.

## Phase 3 — Resilience (retries done right, upsert, checkpoint/resume)

**Objective**: Make a 5-to-6-hour run an operable artifact: faults do not duplicate rows, do not restart from zero, and do not steal the rate budget with unbounded retries.

Some unique-key work may have landed in Phase 1; this phase completes the contract: classified retries, dead-letter, same-transaction checkpoint, advisory lock so two processes cannot run, kill/resume tests.

**Deliverables**:
- Retry policy per [System Design §5](./03_system_design.md#5-retry-and-backoff); retries call `acquire()`.
- Dead-letter table + operator inspection path.
- Checkpoint = committed `source_id` set; resume skip ([ADR-005](./04_architecture_decision_records.md#adr-005)).
- Single-runner lock.
- Fault injection: timeout, 500, 429 with `Retry-After`, SIGINT mid-batch, Postgres restart.

**Exit Gate**:
- [ ] Kill at ~50% and ~90% of the sample (and one longer soak): restart residual HTTP ≈ remainder; duplicate `source_id` = 0.
- [ ] Forced 429: limiter-wide pause; siblings do not keep blasting; tokens are not spent in a tight loop.
- [ ] Fatal 4xx for a row dead-letters; the rest of the run continues.
- [ ] Postgres bounce: run exits dirty; resume does not skip uncommitted work.
- [ ] Happy-path sample wall-clock is not meaningfully worse than Phase 2 (retries should be idle).

## Phase 4 — Conditional capacity negotiation (may never trigger)

**Objective**: Only if the business cannot accept the **5 h 33 m floor** (or the unconstrained discovered floor). Stop tuning the client. Change the contract.

**Entry Gate**: Phases 0–3 complete; a written measurement that we are at the limiter (`limiter_wait` dominates idle, 429 ≈ 0, DB and parse are noise) **and** a stakeholder says the floor is still too slow.

**Deliverables** (one or more, none assumed):
- Written request for: higher cap, burst policy in writing, a batch/bulk endpoint, or a file export.
- If the CSV has duplicate lookup keys: a memoization cache (this reduces *N*, which *does* beat the floor). Only if Phase 0/1 measured a material duplicate-key rate.
- If a batch endpoint arrives: a new fetch path, still rate-limited, still upsert/checkpoint; re-baseline.

**Exit Gate**:
- [ ] Either a new capacity (measured: new floor, new wall-clock on sample + canary), **or**
- [ ] Explicit business sign-off: "we will live with ~5 h 33 m + resume, stop spending engineering time on throughput."
- A third outcome — "keep tuning `N`" — does **not** satisfy this gate.

## Standing Rollback / Kill Criteria (apply at every phase)

Any of the following pauses the program and rolls back to the last phase whose exit gate was cleanly met:

1. **Correctness regression**: duplicate `source_id`, count mismatch vs. CSV, or silent data drop.
2. **Sustained 429 spike** or vendor complaint / credential warning after we raised `r` or `N`.
3. **Checkpoint lie**: skipped rows that were never committed, discovered on audit.
4. **Happy-path much slower** after a "performance" phase without a documented cause (usually retries in the happy path or logging-per-row).
5. **Unbounded memory/FD** growth on soak.

Rollback means: revert the phase's behavior change, keep the instrumentation, do not "fix forward" on the full 200k file with a red canary.
