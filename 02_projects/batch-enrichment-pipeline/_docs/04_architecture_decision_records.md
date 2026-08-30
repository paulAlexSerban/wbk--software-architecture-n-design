# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Bounded Async Worker Pool vs. Unbounded Parallelism / Thread-per-Row

**Status**: Accepted

**Context**: The current job is serial: one HTTP call, then the next. The obvious "make it faster" move is to start 200,000 requests at once, or one thread per row. That will either file-descriptor-exhaust, memory-exhaust, or 429 the vendor — often all three — and under a 10 req/s cap it cannot increase throughput anyway. The useful idea is overlapping *in-flight* wait, not maximizing goroutine count.

**Decision**: Use a **fixed-size worker pool** (or equivalent async semaphore) whose `N` is derived from Little's law (`N ≈ r × typical_latency`), not from the remaining row count. `N` is a run parameter with a hard ceiling. There is no thread-per-row path in v1.

**Consequences**:
- (+) Throughput can overlap HTTP wait up to the limiter's `r`, which is the only overlap that is real.
- (+) Memory, FDs, and retry blast radius stay bounded.
- (+) The same pool is correct when `r = 10` (N will be small) and when `r` is higher (N grows with measured latency).
- (–) A too-small `N` leaves allowed rate unused if latency is high; this is tuned from Phase 0 histograms, not guessed.
- **Alternative rejected**: unbounded `asyncio`/`goroutine` spawn of all remaining work — rejected because it confuses "concurrent" with "faster" and is operationally dangerous.
- **Revisit trigger**: none for v1. Horizontal multi-process workers would need a *distributed* limiter; that is not justified at a global 10 req/s.

## ADR-002: Token-Bucket Rate Limiter as a First-Class Component vs. Reactive 429 Handling Only

**Status**: Accepted

**Context**: Many HTTP clients "handle rate limits" by catching 429 and sleeping. That is a control loop with the vendor as the sensor. It overshoots every time, wastes tokens on 429 responses, and under a hard 10 req/s cap those 429s are stolen from useful work. The current job already averages ~9.26 req/s; a naive parallel client will overshoot immediately.

**Decision**: Put a **token-bucket limiter in front of every attempt**, including retries. 429 / `Retry-After` **tighten the limiter globally**, they are not a per-worker sleep while siblings keep firing. Reactive handling is the safety net, not the primary governor.

**Consequences**:
- (+) Steady paced traffic is less likely to draw 429s than burst-and-back-off.
- (+) Retries cannot bypass the budget.
- (+) Switching from "unconstrained" to "10 req/s" is a configuration of `r`, not a rewrite ([System Design §2](./03_system_design.md#2-rate-limiter)).
- (–) Slightly more code than `sleep` in a `except RateLimitError`. Worth it.
- (–) If the vendor's window is a strict clock-second, a poorly chosen burst `b` still 429s — burst is kept small on purpose.
- **Alternative rejected**: "send as fast as we can and back off on 429" — rejected as the default, because 429s are not free under a shared budget.

## ADR-003: Decoupled Fetch/Write via Internal Queue vs. Tight Per-Row Fetch-then-Write Loop

**Status**: Accepted

**Context**: The serial script ties "API returned" to "row committed" in one loop. That adds DB latency to HTTP latency on the critical path and makes batching unnatural. A durable external queue (Kafka, SQS, RabbitMQ) would decouple them too, at the cost of another system to run for a single batch job.

**Decision**: Use a **bounded in-process queue** between the worker pool and the batch writer. The queue is not durable. Crashes replay uncommitted ids via the checkpoint. Do not introduce a message bus in v1.

**Consequences**:
- (+) HTTP workers and the DB writer can overlap; batching becomes natural.
- (+) Backpressure (full queue) is a single, testable mechanism.
- (+) No new operational dependency.
- (–) Crash loses in-flight and in-queue work; those rows are re-fetched. Under 10 req/s that replay costs wall-clock, which is why checkpoint *frequency* (batch size) is a trade-off, not "as big as possible."
- **Alternative rejected**: keep fetch-then-write per row — simpler, leaves easy win on the table, fights batching.
- **Alternative rejected**: Kafka/SQS for v1 — rejected as complexity that does not raise a 10 req/s ceiling.

## ADR-004: Batched Multi-Row Writes / Chunked Transactions vs. Per-Row Autocommit

**Status**: Accepted

**Context**: 200,000 autocommits means 200,000 round-trips and 200,000 fsyncs (or a WAL flush pattern that behaves like it on remote Postgres). Even if this is only ~10–20 ms/row, that is 30–60 minutes stacked on HTTP in the serial design. It is also a common hidden cost when "the DB is in another region."

**Decision**: Buffer successful enrichments and **upsert in chunks inside a transaction**, with the checkpoint update in the **same transaction** when the checkpoint lives in Postgres ([System Design §4](./03_system_design.md#4-batch-writes)).

**Consequences**:
- (+) Removes a class of waste that is real even when the API cap makes concurrency uninteresting.
- (+) Same code path for canary and full run.
- (–) A crash loses up to one uncommitted chunk of API calls (replay cost). Mitigated by moderate chunk size (hundreds, not 50,000).
- (–) Slightly harder to reason about than insert-one-commit-one.
- **Alternative rejected**: `COPY` as the only write path — fastest for empty-table load, wrong for resume/retry which must upsert.

## ADR-005: Checkpointing + Idempotent Upsert vs. All-or-Nothing Restart

**Status**: Accepted

**Context**: A six-hour (or 5.5-hour) job will be killed: deploys, OOM, laptop lid, cloud spot interrupt, operator abort. Restarting from row 0 doubles API spend and wall-clock, and without a unique key it duplicates rows. "We'll just run it when we can babysit" is not an architecture.

**Decision**: Persist enrichments with a **unique `source_id` and upsert**. Treat committed ids as the checkpoint. Resume skips them. Require the API call to be **idempotent** (or to accept an idempotency key); if Phase 0 finds a non-idempotent side-effecting API, stop and do not add concurrency.

**Consequences**:
- (+) A kill at hour four costs the remainder, not another six hours.
- (+) Duplicate delivery (HTTP succeeded, we crashed, we called again) cannot duplicate Postgres rows.
- (–) Requires a stable `source_id` in the CSV or a derivable business key. No identity → no safe resume.
- (–) Last-write-wins on upsert can change a row if the API is not a pure function of the input. Documented.
- **Alternative rejected**: delete-and-reload the table each run — simple, incompatible with resume, dangerous if consumers read mid-run.
- **Revisit trigger**: if the vendor adds a bulk file drop, the checkpoint still applies to applying that file, but the HTTP worker pool may shrink to "download once."

## ADR-006: Measure-First, One Change at a Time vs. Rewriting the Whole Pipeline at Once

**Status**: Accepted

**Context**: The prompt (and every real incident of "we made it faster") is about **confirming** that a change helped. A rewrite that introduces async, a new HTTP client, batched writes, retries, and checkpoints in one step will produce a different wall-clock and no attribution. It will also mix correctness bugs with performance changes.

**Decision**: **Phase 0 instruments the existing behavior.** Subsequent phases each change one independent variable (or a tightly coupled pair like "limiter + small N", which cannot be tested separately without being unsafe) and must pass a before/after on a frozen 5,000-row sample plus a correctness check ([Phased Implementation Plan](./06_phased_implementation_plan.md)). Shipping a grand rewrite that skips Phase 0 is a process failure.

**Consequences**:
- (+) We can say "keep-alive saved X ms/row; batching saved Y; concurrency saved Z until the cap."
- (+) If the hypothesis is wrong (time not in HTTP), we find out before writing a worker pool.
- (+) Correctness regressions are attributable.
- (–) Slower calendar time than a weekend rewrite. Accepted: the 10 req/s math says the weekend rewrite was never going to produce a 10× win anyway.
- **Alternative rejected**: "just rewrite it in Go/async and see" — rejected as the default plan of record.
