# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone buys a multi-TB KV fleet or promises "sub-second deterministic botnet blocking."

The math, once: **2.5 million impressions per second × 1,800 seconds = 4.5 billion live keys.** Compact payload is already ~1 TB unreplicated; replicas and a second region are how it becomes a real bill. **350,000 clicks per second** is a decision budget of well under a millisecond of honest compute if you want a sub-second p99 with queueing. A remote fraud model does not fit. A sliding-window scan does not fit. "Use Flink" does not multiply these for you.

## 1. What I would build

A **hot-path lookup and policy engine**, and a **slow-path fraud and warehouse plane**, sharing one log.

- **Canonical event log** from collectors; Hadoop and streaming both drink from it. Dual-ingest from SDKs is how you make incomparable pipelines.
- **TTL'd KV** for impression records, sized for the 4.5B-key working set, regional, high-entropy keys. POC at full cardinality before promising the SLO. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Click evaluator**: idempotency, Tier 0, GET, Tier 1, decision record. Almost stateless. Fail open on store blindness.
- **Repair consumer** for click-before-impression, bounded by lateness slack, not a wait in the hot path.
- **Tier 2** as a separate consumer + batch inference + clawback events. No model in the click p99. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Lake + OLAP** for multi-touch and disputes. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Comparator** that speaks **dollars**, not only counts, for as many billing cycles as finance demands. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Per-rule kill switches and shadow scoring** before any new drop.

I would not start by writing Flink SQL for a 30-minute interval join. I would start by measuring whether 2.5M/s is real, whether `impression_id` is on the click, and what 45 minutes of currently knowable fraud is worth.

If Phase 0 shows the failures are *only* "the job waits for hourly files" and the real rate is 20k clicks/s, this whole KV is overkill. Compact the log, run a 5-minute Spark job, ship. The streaming answer is for when the rates and the leakage are real, or when sub-second drop of *replay* is a contractual requirement. Be honest about which incident you are in.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never on this path.

**A single pipeline that "does attribution, fraud, and analytics."** That sentence is how Hadoop became a 45-minute everything-job. Streaming makes the same mistake faster.

**Literal sliding-window joins.** The join is a keyed GET. If the key is missing, I give up real-time attribution for those clicks, or I wait on the SDK. I do not fuzzy-join the world's IPs.

**Sub-second botnet, proxy-pool, and "AI" blocking.** I will catch replay and too-fast and over-frequency in the hot path. I will score the rest later. I will not put "deterministic" on a softmax.

**Zero financial leakage.** I close the 45-minute window for *knowable* fraud. Unknown-bad traffic still exists. Tier 2 still lags. Anyone who needs zero should leave ad-tech.

**Global 30-minute attribution across regions in v1.** I give up the extra KV copies. Cross-region last-touch in 30 minutes is a measured exception, not the default topology.

**A 24-hour "real-time" impression window.** That is 24× the keys. I will offer warehouse multi-touch instead, and a short "no."

**Fail-closed drops when the KV is down.** I will leak money for a few minutes rather than drop a continent of legitimate clicks. If brand risk inverts that, they sign it.

**Turning off Hadoop in month two to save opex.** I give up that savings until the dual-run gate is honestly green. The double bill is the cost of not gambling the invoice.

**Embedded Flink state as the 4.5B-key source of truth**, unless the team has already operated that and the POC passes. Even then I prefer a KV I can bounce the workers without replaying a changelog from the heat death of the universe.

**Real-time multi-touch on the invoice.** Last-impression-in-window (or the existing invoice rule) on the hot path. Multi-touch in SQL. Two numbers, labeled.

**People-based / device-graph attribution in the evaluator.** That is a graph product.

**A custom "exactly-once" story that billing does not honor.** If the ledger cannot unique `click_id`, I stop. Stream processing will not save it.

**The fantasy that last-mile SDK clocks are NTP.** Ingest-time watermarks, clamped event-time deltas. Some honest mis-windowing. Better than a globally wrong watermark.

**Cheapness, if the old path was an hourly MR job on hardware you already own.** This is more moving parts, a KV that costs real money, and a multi-quarter program. Pay it when leakage × probability of catching it in-window exceeds the stack, or when a contract requires real-time drop. Do not pay it because a design-review audience likes Kafka.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with the measurements. Silence must not block the measurement.

Ask finance / ad ops / legal:

1. **What is attributed spend and fraud-flagged spend in a typical 45-minute window, and can you put a recovery rate on late fraud flags?** If they cannot, the ROI slide is fiction. Expected: a painful spreadsheet, not a round number.
2. **Can publisher payouts and advertiser invoices be clawed back or adjusted after the fact?** If no, Tier 2 is a quality signal, not a money signal. Expected: "depends on the contract." Get the mix.
3. **What dollar and percent divergence vs Hadoop is acceptable for four weekly closes?** If they say "zero," they are asking to never cut over. Pick a band.

Ask product / fraud:

4. **Is the join key actually on the click today, at what rate?** If 60%, Phase 2 is blocked. Expected: "we think so." Measure.
5. **False-positive budget on Tier 0/1.** A number, not "as low as possible." 0.1% at 350k/s is 350/s. Expected: they will not want to name it. Make them.
6. **Is "uploaded billed, then clawed" acceptable in the UI and in IO terms?** If no, they are asking for delayed accept, which is not the sub-second product they wrote in the scenario.
7. **Do we need 30 minutes, or did 30 minutes come from the batch file grain?** If the real attribution window in the IO is 24 hours view-through, the hot path still does 30 minutes last-touch (or whatever is invoiced now) and the warehouse does the rest. Do not silently extend TTL.

Ask platform:

8. **Who owns a multi-million QPS, multi-billion-key KV, and have we run one?** If nobody, that is a hiring or vendor problem in front of Phase 2.
9. **Will we dual-run Hadoop for N months without an executive "turn it off to save cost" surprise?** Get the budget line.

What I would **not** ask for: a new ML platform, a global mesh, a rewrite of billing, Kubernetes-as-the-architecture, "exactly-once Flink so we can skip the ledger unique key." Those asks spend calendar that belongs to the KV POC and the comparator.

## 4. Complexity inventory (what "just add Flink" costs)

| You take on | You shed |
| --- | --- |
| Multi-TB TTL'd KV at 2.5M writes/s | Hadoop shuffle as the join |
| Canonical log + compact encoding | Dual SDK taps that disagree |
| Decision records + lake uniqueness | Job-output-as-truth with no event id |
| Three fraud tiers + clawback process | One 45-minute model that is also the invoice |
| Dual-run comparator in **dollars** | Hope that streaming matches batch |
| Per-rule shadow and kill switches | Friday YAML deny-list deploys |
| Regional topology and a "no" to 24h hot windows | A single global "the cluster" |
| Repair path for out-of-order SDK | Pretending arrival order is event order |
| On-call for watermarks, KV occupancy, delta spend | On-call only for MR job failure |
| Residual leakage as a named metric | The slide that said "real-time = zero fraud delay" |

Net: **more parts, in the right places.** The old design was simple *and late for the fraud it already understood.* The new design is the standard one for this industry at this scale, and the standard one is still a **program**, not a sprint: KV capacity, dual-run, fraud process, billing pointer. Flink (or not) is a worker implementation detail once the join is a GET.

### What is not worth building

- Fuzzy IP+UA window join "so we don't have to fix the SDK."
- Graph neural nets on the click path.
- Multi-touch in the evaluator.
- A custom people-identity graph as a dependency of v1.
- Replicating 4.5B keys to three continents "for simplicity."
- Exactly-once stream processing as a substitute for billing uniqueness.
- A real-time analytics SQL layer on the same cluster "while we're at it."
- Stretching TTL to match a 24h view-through IO.

## 5. When I would not do this

- Phase 0 shows rates far below the slide and the 45 minutes is file-wait. **Micro-batch the lake, emit decision records, stop.** Streaming seams can wait.
- Leakage dollars of *currently detectable* fraud do not survive contact with the KV + dual-run bill, and there is no contractual need for sub-second drop. Do not pre-pay this complexity as a résumé.
- Join key is mostly missing and client teams will not emit it. This design is the wrong shape. Fix the signal or accept unattributed.
- Legal forbids any post-facto adjustment **and** fraud will not accept fail-open. Then you are being asked to put a high-FP model on the hot path. I would refuse that combination and make them pick: leakage, or delayed billing, or a named FP budget.
- Nobody can operate the KV at this QPS and cardinality, and the POC fails. **Kill the streaming join.** Do not "temporarily" dump 4.5B keys into RocksDB and hope checkpoints complete before the next hour's data arrives.

When I **would** do this: the rates are real, the join key exists, the 45-minute window is worth real money for *simple* fraud, and finance will dual-run. Then the architecture is lookups + tiers + lake + a slow cutover, and this document is the bill.

## 6. Brutal summary

The clever design is not a 30-minute sliding-window join in a stream processor. The clever design is **refusing to scan 4.5 billion impressions**, **refusing to put a botnet model on a 350k/s SLO**, and **refusing to let streaming become the invoice because it feels more real-time**.

"Stream processing, sub-second fraud, sliding-window attribution" is the right *direction*. The next words are: keyed TTL lookup, three tiers, clawback if the contract allows, warehouse for multi-touch, dual-run in dollars, residual leakage as a metric, and a KV that costs what 4.5 billion keys cost.

If the volume is fake, do not build this. If the volume is real, do not pretend a Flink SQL join is a strategy. Either way, Phase 0 is the actual eps, the join-key fill rate, and a dollar figure on the 45-minute window — before anyone opens a stream-processor vendor's architecture diagram.
