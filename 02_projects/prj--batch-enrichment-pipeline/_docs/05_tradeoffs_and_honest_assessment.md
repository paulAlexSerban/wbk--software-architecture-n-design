# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This is the document that answers the scenario's questions directly. The other docs exist so those answers are implementable. If you only read one file after the [Business Overview](./01_business_overview.md), read this one.

## 1. Where the time is most likely going — before you measure — and why

**Most of the six hours is almost certainly serial HTTP wait.**

200,000 rows in 21,600 seconds is **~108 ms per row** and **~9.26 requests per second**. That is the right order of magnitude for a single in-region HTTP round-trip (TLS already established) or a slightly worse one (new connection each time). It is the wrong order of magnitude for:

- **CSV parsing.** Parsing 200,000 rows of typical business CSV is seconds, maybe tens of seconds on a slow disk, not hours. If parse were the problem, you would not need an API to reproduce the runtime.
- **A healthy, local Postgres INSERT.** A single-row insert with autocommit on a same-AZ instance is typically sub-millisecond to a few milliseconds. 200,000 × 2 ms is ~7 minutes, not six hours. This can *become* material if Postgres is far away, if every insert takes a lock, or if every insert opens a new DB connection — but even a grim 20 ms/row is ~67 minutes, still not the whole six hours.
- **CPU in a typical script language.** 108 ms of CPU per row would show up as a pinned core and a hot profiler. Unlikely for "read fields, call HTTP, insert."

### Ranked priors (not facts)

| Rank | Hypothesis | Why it is plausible | How large it could be | How Phase 0 confirms it |
| --- | --- | --- | --- | --- |
| 1 | **Blocking HTTP, one in flight, no overlap** | Matches ~108 ms/row almost too well; the code shape ("for row in csv: requests.get; insert") is the industry-default original sin | ~all of the six hours | `http_total` ≈ 108 ms, `parse` and `db_commit` tiny, concurrency = 1 |
| 2 | **No keep-alive / new TCP+TLS per row** | A naive HTTP client does this; TLS handshake can be 50–200+ ms extra | Tens of ms to the whole 108 ms if the handshake *is* the round-trip | `http_connect` large and correlated with `http_total`; drops when pooling is on |
| 3 | **Per-row autocommit, possibly remote Postgres** | Also the industry default; rarely *the* six hours, often the next slice | Minutes to ~1 hour in bad cases | `db_commit` histogram; commit count ≈ 200,000 |
| 4 | **Everything else (parse, JSON, logging, sync disk)** | Usually noise | Seconds to a few minutes | Residual after 1–3 |

**Why this ranking is allowed before measuring:** because you are asked to say where the time is *likely* going, and because 108 ms/row is a strong signature. The ranking is still a **prior**. If Phase 0 shows `db_commit` at 80 ms and `http_total` at 20 ms, the plan's order swaps and anyone who shipped a worker pool first wasted a week.

**What this prior is not:** permission to skip instrumentation. The first change is still timers. See [ADR-006](./04_architecture_decision_records.md#adr-006).

## 2. What to change, in what order, and how you confirm each change helped

Work a **frozen 5,000-row sample** (`sample.csv`) for attribution. Then canary the full file. One independent variable per step. Correctness check every time (`source_id` uniqueness, counts, sample payload hashes). Full protocol: [System Design §1](./03_system_design.md#1-instrumentation-exists-before-any-optimization).

### Step 0 — Instrument (no behavior change)

- **Change:** per-phase timers and counters on the existing script.
- **Confirm it helped:** it didn't help runtime, and must not *hurt* it by more than a few percent. Success is a breakdown: "HTTP 101 ms, connect 40 ms of that, commit 6 ms, parse 0.4 ms" (illustrative). Hypothesis confirmed or **fork the plan**.

### Step 1 — HTTP connection reuse / keep-alive pooling

- **Change:** one shared session/client, connection pool, TLS reuse. Still serial, still one in flight. Smallest possible behavior change after measuring.
- **Confirm:** `http_connect` collapses; `http_total` drops by the handshake component; sample wall-clock drops in proportion. Error rate unchanged. If `http_total` barely moves, keep-alive was not the waste — say so, keep the pool anyway (it is cheap and correct), **do not claim a win**.

### Step 2 — Batch Postgres writes

- **Change:** buffer N successful rows, multi-row upsert, chunked transactions. Still serial HTTP.
- **Confirm:** commits/sample drop from 5,000 to ~10–50; `db_commit` per row-equivalent drops; sample wall-clock drops by roughly `old_db_per_row × 5000`. If it drops by 2 seconds, DB was never the story — **document the small win**, keep batching as structure. If it drops by 20%, you found a remote-DB tax.

### Step 3 — Bounded concurrency + limiter

- **Change:** worker pool of size `N`, token bucket at a **conservative** `r` (unconstrained world: start at ~2–4× current 9.26 if 429s are absent, not at 1,000). Result queue between fetch and write.
- **Confirm:** sample wall-clock falls as overlap increases; 429 rate stays ~0; p99 `http_total` does not explode (a climbing p99 is the vendor falling over — you did not get faster, you DDoS'd a friend). Stop raising `N`/`r` at the first of: 429s, latency climb, CPU saturation, no further wall-clock gain.

**Honest ceiling if there is no documented cap:** wall-clock ≈ `(200_000 / r_achieved) + tail`. If the API truly holds 100 req/s at 100 ms, you are in the **~33 minute** neighborhood, not six hours. If it holds 50 req/s then ~67 minutes. **Do not publish those numbers as commitments.** Unpublished throttling, WAF, and shared tenancy will lie to a load test that is not the real job. The confirmation *is* the measured `r_achieved` on the canary, then a watched full run.

### Step 4 — Retry/backoff + idempotent upsert

- **Change:** unique `source_id`, upsert, classified retries with jitter, attempts cap, dead-letter. May not reduce happy-path time at all.
- **Confirm:** a forced timeout/5xx on the canary retries and ends with one row, not two. A 400 does not retry five times. This step is for **not getting slower under faults** and not corrupting data. If happy-path wall-clock rises, retries are firing in the "happy" path — that is a bug.

### Step 5 — Checkpoint / resume

- **Change:** skip committed ids on start; same-transaction checkpoint ([System Design §6](./03_system_design.md#6-checkpoint-and-resume)).
- **Confirm:** kill at 50% and 90%; restart; remaining HTTP calls ≈ remainder; duplicate `source_id` = 0. Wall-clock of a *clean* run should be almost unchanged (checkpoint load of 200k ids is small). The win is **failure wall-clock**, not success wall-clock.

### What not to bother building (until the math changes)

- A fleet of workers, Kubernetes HPA, Kafka, "event-driven microservices." They do not mint API tokens.
- Rewriting the script in a faster language to "save the 108 ms." It is not CPU.
- Autoscaling `N` from CPU. The signal is 429s and limiter wait, not CPU.
- A dashboard product. A metrics log and a few histograms are enough for this job.

## 3. The 10 req/s hard limit — what changes, what stays the same

### The number that matters

`200,000 ÷ 10 = 20,000` seconds ≈ **5 hours 33 minutes**, if every request succeeds once and we add zero overhead.

The current job is **~9.26 req/s**. It is already within ~7% of that floor. **Parallelism cannot produce a 10× speedup.** Anyone who promises "we'll just concurrent it" after this disclosure is not doing engineering, they are performing it.

A clean reading of the six hours: you are paying ~108 ms/row, of which ~100 ms is likely HTTP. At 10 req/s you are *allowed* 100 ms/request of spacing. The serial job is almost already the rate-limited job, accidentally.

### What changes

1. **The meaning of concurrency.** It is no longer "go faster." It is "keep enough requests in flight to *hit* 10/s given latency, without exceeding it." If latency is 100 ms, `N ≈ 1`. The worker pool becomes almost vestigial. You still want it as a structure (timeouts, decoupling, future cap raises), but you stop selling it as the win.
2. **The limiter becomes load-bearing, not polite.** Configuration of `r = 10` (or 9.5), tiny burst, global 429 cooldown, `Retry-After` pauses *the whole process*. This is [ADR-002](./04_architecture_decision_records.md#adr-002) moving from "wise" to "the product."
3. **Retries get expensive in wall-clock, not just in logs.** Every retry is a token that is not a new row. Retry policy, timeout tightness, and "don't burst" move up the priority list. A retry storm is how a 5 h 33 m job becomes an overnight job that still has 40,000 rows left.
4. **Stakeholder messaging.** The honest goal is: **shave incidental waste** (handshake, autocommit, idle gaps that drop you *below* 10/s), **sustain ~10/s**, and **make 5.5 hours resume-safe**. The goal is not "sub-hour." If sub-hour is mandatory, that is Phase 4 (batch API / higher quota / fewer calls via key dedup), not Phase 2.
5. **How you spend engineer time.** Tuning `N` from 20 to 200 is now a waste of calendar. Building checkpoint/upsert is a better spend than it was when people still believed in a 20-minute rewrite. Canary discipline matters more: a 429-heavy full run burns a scarce daily token budget.

### What stays the same

1. **Measure first.** The 10/s disclosure does not tell you whether *your* 108 ms is HTTP, TLS, or DB. Phase 0 is unchanged.
2. **Connection reuse.** Still correct. It may be what lets you actually *reach* 10/s if you were spending half of each 108 ms in handshake and the vendor's limiter counts completed requests. It will not beat 10/s.
3. **Batched writes.** Still correct. They still remove a serial tax that can sit *on top of* the 10/s spacing if you remain in a fetch-then-write loop. They still reduce fsync/round-trip noise. They still make the writer cheap enough that the limiter is the bottleneck, which is what you want.
4. **Decoupled fetch/write.** Same pipeline shape. [Architecture](./02_architecture_document.md) does not fork.
5. **Idempotent upsert + checkpoint.** More important, not less: 5.5 hours is still long enough to fail.
6. **One change at a time, sample-verified.** Attribution still matters, if only to prove to a manager that concurrency did almost nothing and you are not incompetent — the cap did it.
7. **Single process, one limiter.** Horizontal scale stays a bad idea. Two machines at 10/s each is 20/s to a global cap.

### Side-by-side

| Concern | Unconstrained (unknown cap) | After "hard 10 req/s" |
| --- | --- | --- |
| Primary lever | Overlap HTTP; discover `r` | Pace at 10; don't waste tokens |
| Expected full-run time | Unknown; *maybe* tens of minutes if the API is fast and kind | **≥ 5 h 33 m** + retries + our waste |
| Worker pool size | Grows with `r × latency` | Small; Little's law with `r = 10` |
| Limiter | Conservative discovery | Configured ceiling, first-class |
| Worth a week of pool tuning? | Maybe, until 429s | No |
| Worth keep-alive + batching? | Yes | Yes |
| Worth checkpoints? | Yes | Yes, clearly |
| Next move if still too slow | Maybe raise `r` if 429-free | **Talk to the API owner** (Phase 4) |

## 4. Complexity vs. payoff (be adult about this)

| Investment | Complexity | Payoff if hypothesis holds, no 10/s cap | Payoff at 10 req/s | Verdict |
| --- | --- | --- | --- | --- |
| Timers | Low | Attribution | Same | Mandatory |
| Keep-alive | Low | Medium (handshakes) | Small–medium (reach the cap cleanly) | Always do |
| Batch upserts | Low–medium | Small–medium | Small wall-clock, real operational | Always do |
| Bounded pool + queue | Medium | **Large if API allows** | Tiny wall-clock, structural | Do, don't fetishize `N` |
| Token bucket + 429 cooldown | Medium | Prevents self-DDoS | **The whole game** | Mandatory once cap is known; wise before |
| Upsert + checkpoint | Medium | Low on happy path; huge on failure | Same | Mandatory for multi-hour |
| Distributed queue / many workers | High | None at a global cap; dangerous without distributed limiter | Negative | Do not |
| Vendor batch endpoint | Political + some code | Can break the 1-call-per-row floor | **The only way below 5 h 33 m** | Phase 4 if 5.5 h is unacceptable |

**The uncomfortable summary:** if the API owner tells you 10 req/s, the heroic architecture story is mostly cancelled. What remains is a **well-instrumented, paced, batched, resumable serial-ish pipeline** that tries not to drop below 10/s and not to go above it. That is less exciting than "event-driven workers" and it is the right system.

If 5 hours 33 minutes is still too slow for the business, **the architecture problem is the contract (1 HTTP call per row), not the script.** Ask for a bulk export, a batch endpoint, a higher cap, or a way to skip rows. Until one of those arrives, do not hire the complexity of a distributed pipeline to fight arithmetic.
