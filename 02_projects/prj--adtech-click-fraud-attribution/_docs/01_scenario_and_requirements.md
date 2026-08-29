# Ad-Tech Click Fraud & Attribution Engine: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

An ad-tech platform processes 350,000 click events per second and 2.5 million impression events per second from mobile apps and web publishers worldwide. Every incoming click must be matched against impression logs within a rolling 30-minute attribution window to assign conversion credit to advertisers, while simultaneously evaluating traffic against fraud models (botnets, IP spoofing, fast-click replay, proxy networks). The legacy batch-processing system on Apache Hadoop takes up to 45 minutes to process attribution and filter fraud. That delay is financial leakage: bad traffic is billed, paid, and disputed before anyone knows it was bad.

The design must answer, concretely:

1. What those rates actually imply for live state, not just for "events per second" on a slide.
2. Why a 45-minute Hadoop batch leaks money, and what "real-time" can and cannot recover.
3. How attribution matching is shaped so the 30-minute window is tractable at this volume.
4. How fraud evaluation can be sub-second *and* deterministic for the class of fraud that admits that, without pretending botnet detection is a rule on a click.
5. How multi-touch queries over petabytes of historical click logs sit next to the hot path without contaminating it.
6. What that redesign costs in complexity, money, and calendar, and what it still will not catch.

This is the "just add Flink" trap. The naive answer — replace Hadoop MapReduce with a stream processor, declare a 30-minute sliding-window join, drop fraud in the same job, and query the same store for multi-touch — is the failure. It treats three different problems (hot-path matching, probabilistic fraud, historical analytics) as one job, and it treats "deterministic + sub-second + catches sophisticated fraud" as a single SLA.

The correct shape is: **a keyed, TTL'd impression lookup at click time; a three-tier fraud pipeline that only blocks what can be decided from the event plus cheap local/global state; an async behavioral/ML path that claws credit back; and a decoupled lake/OLAP plane for multi-touch.** Dual-run against Hadoop billing numbers until the divergence is a known, accepted number.

That paragraph is the whole architecture. Everything else in this project is the honest cost of making it true at 2.5 million writes per second into a 4.5-billion-key working set, with money on both sides of every accept/drop.

## The Trap, Stated Directly

Stream processing is the right *class* of system. It is not a product. "Sliding-window join" is the phrase that will get a design review to nod, and it is the phrase that will bankrupt the state store if taken literally.

A click-to-impression join at these rates is **not** "for each click, scan 30 minutes of impressions." 2.5 million impressions per second × 1,800 seconds = **4.5 billion impressions live in the window**. A naive windowed join is an N×M explosion. Real ad-tech attribution is a **point lookup**: the click carries (or is joined via) an impression identifier, a click ID issued at serve time, or a compact device+campaign fallback for view-through. The 30-minute window is a **TTL on that key**, not a scan. If the product cannot emit a stable join key at impression time, this entire design is the wrong system; go back to product and fix the signal, do not buy a bigger cluster.

"Deterministic fraud dropping" is a second trap, stacked on the first. Duplicate `click_id`, malformed payloads, over-rate from a single IP or device, known-bad CIDR, timestamp in the future, click with no matching impression in window — those are deterministic, or close enough to encode as rules with documented false-positive cost. Botnets, residential proxies, IP spoofing that survives the packet path, and coordinated low-and-slow click farms are **not** deterministic from a single event. They need graphs, device graphs, publisher-level baselines, minutes-to-hours of context, and they produce scores, not truths. Putting them on the sub-second path means either (a) you lie about latency, (b) you lie about detection quality, or (c) you drop legitimate traffic when the model is wrong and you eat advertiser and publisher lawsuits. The architecture splits the pipeline. Anyone who insists the split is "temporary until the model is good enough" is asking to put a probability on the billing critical path.

The 45-minute Hadoop job is the third trap. Forty-five minutes of leakage is real. Closing it to sub-second for *all* fraud is not how the 45 minutes go away. Closing it to sub-second for **duplicate, replay, and unattributable clicks**, and to minutes for **scored fraud with clawback**, is how the 45 minutes go away. The residual leakage is a business number, not an engineering embarrassment. Phase 0 must put a dollar figure on it or the program has no success metric except "we stream now."

Multi-touch attribution over petabytes is the fourth trap. It is a warehouse question. It does not belong in the click-evaluation SLA. If the same serving cluster is asked to answer "show me last-touch vs linear vs time-decay for campaign X over 18 months" at the same time it is dropping fraud at 350k clicks/s, one of those jobs will starve the other. Decouple them on day one.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Publishers and mobile SDKs POST or beacon impression and click events into collection endpoints (or a CDN log dump).
2. Events land in HDFS (or a cheap object store feeding HDFS) as hourly or smaller files, often after a collector that batches for throughput and loses the original arrival order.
3. A Hadoop (or Spark-on-Hadoop) job, scheduled every N minutes, reads the last 30–90 minutes of impressions and clicks, joins, scores fraud in batch, writes attributed conversions and fraud flags to billing tables.
4. Advertiser dashboards and publisher payouts consume those tables. Disputes arrive days later. The fraud that was obvious at click time was billed for 45 minutes, sometimes for the whole billing cycle if the job failed or the model was applied late.

That version will appear to work in a lab with a day's sampled logs and a join that finishes in 20 minutes. It will fail in production as: the job overruns into the next hour; late SDK events miss the window and are silently unattributed or attributed to the wrong campaign; replayed clicks are billed until the next batch; on-call pages on HDFS occupancy instead of on stolen spend; "real-time" dashboards are a 45-minute-old batch with a websocket painted on top.

This project documents the replacement, not a faster scheduler on the same batch.

## Two Numeric Realities (Load-Bearing)

Walk the numbers before the components. If Phase 0 shows the real rates are an order of magnitude lower, the design shrinks; the *seams* do not. If the rates are real, these two facts dominate every ADR.

### Reality 1 — ~4.5 billion live impression keys

| Quantity | Working figure | Why it matters |
| --- | --- | --- |
| Impression ingest | 2.5 × 10^6 /s | Write rate into the lookup store. Not a stream-processor checkpoint curiosity; it is a KV write budget. |
| Attribution window | 30 min = 1,800 s | TTL. Not a batch interval. |
| Live keys (steady state) | 2.5e6 × 1,800 = **4.5 × 10^9** | Working set of the join. |
| Compact record (id, campaign, publisher, device hash, ts, a few flags) | ~200–400 bytes | Payload only. Indexes, replication, and tombstones are extra. |
| Hot payload (unreplicated) | **~0.9–1.8 TB** | Before 3× replication, before a second region, before "we also keep last-hour for debugging." |
| Replicated working set | **~3–6 TB** in a 3-replica KV, more with a hot standby region | This is the bill. "Flink RocksDB state" at this size is the same bill with worse operational story unless you have already operated Flink at multi-TB keyed state. |
| Writes | 2.5M PUT/s + TTL expiry | A store that can ingest this and expire it. Many popular caches cannot. |
| Click lookups | 3.5 × 10^5 GET/s | Plus fraud-tier reads (rate counters, bloom/seen-id). Same cluster or a sibling; still real. |

**What this is not:** 4.5 billion rows in a warehouse table that a stream job "joins against." Warehouse latency is not the SLA. The lookup store is a purpose-built, TTL'd, partitioned KV (or an equivalent: a stream processor's *external* state, not "the Flink job will hold it"). See [ADR-002](./04_architecture_decision_records.md#adr-002).

### Reality 2 — 350,000 clicks per second of *decision* budget

Every click must leave the hot path with one of: `drop_deterministic`, `accept_attributed`, `accept_unattributed` (no impression in window — a first-class outcome, not a bug), or `accept_pending_score` (rare; default is accept-then-clawback). The CPU, network, and rule-eval budget per click is **sub-millisecond if you want sub-second p99 including queueing**. Sub-second is an end-to-end SLO, not "the model inference is 80 ms so we are fine." Ingest → parse → Tier 0 → lookup → Tier 1 → emit is the path. Anything that needs a remote model, a graph hop, or a 30-minute feature window is **not on this path**.

350k/s is also the rate at which a bug drops legitimate traffic or bills fraud. A 0.1% false-positive on Tier 0 is 350 false drops per second. That is a commercial incident, not a metric blip. Deterministic rules need dual-run and a kill switch per rule, not a YAML file shipped on Friday.

## Layer-by-Layer Fault Tree (Leakage and Wrongness, Specifically)

Walk the path. At each layer, name what fails *because the batch is slow*, *because the join is wrong*, or *because fraud is applied too late or too eagerly*. Generic "Hadoop is down" is out of scope except as it extends the leakage window to infinity.

### Collection / SDK

- **Clock skew and event time vs processing time.** Mobile devices lie about time. A click stamped 40 minutes ago arriving now is either late legitimate traffic or a replay. Batch jobs that join on file time silently mis-window. Stream jobs that join on processing time do the same with more confidence. Event time + a documented allowed lateness is the design; "we assume NTP" is not.
- **Duplicate beacons and retries.** SDKs retry. CDNs retry. Fast-click replay looks like retries until you have an idempotency key. Hadoop distinct-count at hour grain will miss intra-minute replays and double-bill or double-drop depending on who wrote the reducer.
- **Missing impression ID on the click.** If the SDK cannot carry the serving-time ID, you are in fuzzy match territory (IP+UA+campaign in a time band). That is a different, worse join. Do not hide it inside "sliding window." Name it as a degraded path with a cap, or refuse it.

### Hadoop batch

- **45-minute (or worse) time-to-knowledge.** Every fraudulent click in that window is a receivable you may never collect and a payable you may already have committed to a publisher. Leakage is `fraud_rate × spend_in_window × (1 - recovery_rate)`. If you cannot estimate that in Phase 0, you cannot prioritize this project against "make the job run every 10 minutes."
- **Job overrun.** A 45-minute job that sometimes takes 70 minutes means overlapping jobs, skipped windows, or "catch-up" that processes stale fraud models. Overrun is how a "batch every 15 minutes" becomes "batch whenever."
- **Window-edge effects.** Clicks at T+29:50 whose impression landed in the previous file, or impressions that arrive in the next file, are systematically wrong at partition boundaries. This is the quiet cousin of leakage: not fraud, just misattribution, which is also money.
- **Fraud as a post-join map.** Batch fraud models see a 30–90 minute feature window "for free" because the job already materialized it. That is why people think streaming will "just run the same model." It will not. The model is coupled to a materialized hour. Streaming must rebuild features or accept a weaker inline model. See [ADR-003](./04_architecture_decision_records.md#adr-003).

### Attribution semantics (business, not Hadoop)

- **Last-click in a 30-minute window is not multi-touch.** Last-click (or last-impression) for *billing of this click* can be a hot-path decision. Multi-touch (linear, time-decay, position-based) over a user's week of impressions is a **re-aggregation**. Mixing them produces a dashboard that disagrees with the invoice. The invoice uses the hot-path rule; the dashboard uses the warehouse. Both must be documented or finance will pick the larger number.
- **Unattributed clicks.** A click with no impression in-window may still be billable under contract (clicks sold as clicks) or not (view-through / impression-required). The architecture must emit the miss, not drop it on the floor because the join "failed."

### "Real-time" painted on the batch

- **Dashboards that read the last successful batch.** Stakeholders believe the platform is already real-time. The 45-minute number is then a surprise during an incident. Phase 0 includes showing them the actual watermark.

## What to Check First, and Why That One First

**Check first: the actual production rates, the actual job duration distribution, the actual join key, and a dollar estimate of leakage in the current window — from existing Hadoop outputs and billing, not from this scenario's round numbers.**

This is a read-only, no-rewrite-needed check. It partitions "we must stream" from "we should run the job more often" and from "our SDK does not even send an impression id."

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| Peak impression/s and click/s from collector metrics, not the slide | Whether 2.5M / 350k are real, 10× marketing, or 10× under | Counters you already emit, or can add to the collector in a day |
| Hadoop job wall time p50/p95/p99 and overlap/skip rate | Whether 45 min is a p50 or a disaster-only number | Job tracker / Spark UI / Airflow already has this |
| Fraction of clicks that carry a stable impression or click id | Whether the join is a lookup or a fuzzy nightmare | One field presence rate in a day's logs |
| Late-arrival distribution: event_time vs ingest_time | Whether 30 min + 2 min lateness is honest | Histogram, not a new system |
| Duplicate `click_id` rate in a raw day | Replay / retry volume the batch may be papering over | Distinct vs count on one column |
| Spend in a 45-minute window × currently flagged fraud rate | Order-of-magnitude leakage | Finance already has spend; fraud flags already exist even if late |
| Contract language: can you claw back publisher payouts after the fact? | Whether Tier 2 is legally a product or a science project | One email to legal/sales ops |

**Why not start with a stream-processor POC.** A POC that joins 1% sampled traffic in Flink will "work" and teach you nothing about 4.5 billion keys or about billing divergence. Measure, then dual-run a thin slice. See [Phased Implementation Plan](./06_phased_implementation_plan.md).

**Why not "just run Hadoop every 5 minutes."** If the job is 45 minutes because it *does 45 minutes of work* (shuffle of a 30-minute join, fraud features over a wide window), shrinking the schedule without shrinking the work produces overlapping jobs and a messier leak. If the job is 45 minutes because it waits for hourly files, then a 5-minute micro-batch might be the right *interim* and might even be the right long-term for some fraud. Phase 0 must say which 45 minutes you have. This project still assumes you need sub-second *deterministic* drop; micro-batch does not give you that. It can still be a Phase 1 hedge if streaming state cost is rejected.

**Second check, only after the numbers:** where money is committed (advertiser IO, publisher payable event) and whether a post-facto clawback is contractually possible. Architecture that assumes clawback when finance cannot reverse a payout is a design that will be forced to put more fraud on the hot path than the hot path can honestly hold.

**Third:** current fraud model inputs. If the "model" is five regexes and a known-bot UA list, Tier 0 is most of the value and Tier 2 is a later program. If the model is a trained graph that needs 24 hours of device edges, it will not ride along in the Flink job. Do not let a vendor demo collapse those two worlds.

## Target Users

- **Owning engineer / streaming platform**: implements ingest, lookup, and tiers; needs the state-size number and the join-key invariant, not a slogan.
- **Fraud / data science**: needs a documented home for models that cannot run in 1 ms, and a dual-run harness so a new rule does not become a 350/s false-drop incident.
- **Billing / finance / ad ops**: needs to know which pipeline is the invoice, when dual-run diverges, and what clawback means in the contract.
- **On-call**: needs watermarks, state-store saturation, drop rates per rule, and "Hadoop still running as shadow" as first-class pages, not "the cluster is red."
- **Legal / publisher relations**: needs the drop-reason taxonomy for disputes. "The AI said so" is not a reason you can put in a traffic-quality report.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which dashboard chart, which ML framework) are out of scope.

1. **Ingest must absorb the stated rates with headroom**, worldwide, with backpressure that sheds *collection retry* rather than silently dropping untracked events. Losing events without a metric is worse than a lagged watermark.
2. **Hot-path evaluation of a click must complete in sub-second p99** for Tier 0 + lookup + Tier 1. This SLA does **not** include Tier 2 model score. Stating one SLA for "fraud" is how the SLO gets defined as the model's p99 and then missed.
3. **Attribution matching in the 30-minute window is a keyed lookup with TTL**, not a window scan. The click must present a join key the impression stored. Fuzzy match is a bounded, explicit degraded path or it is out of v1. See [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **Deterministic drops must be replay-safe and explainable.** Same event in, same drop reason out. Reasons are stable enums for disputes. A model score is not a deterministic drop.
5. **Financial effects are idempotent.** Replaying a click (collector retry, stream replay, Hadoop dual-run) must not double-bill or double-pay. Dedup key is `click_id` (or equivalent) with a retention longer than the maximum retry/replay window, not 30 minutes if retries last hours.
6. **Late events have a documented policy.** Allowed lateness is a number (working default: minutes, not hours). After watermark + lateness, the event is counted as late: either dead-lettered for offline attribution or attached with an `late` flag that billing may reject. Silent drop is forbidden.
7. **Tier 2 fraud may not block the hot path.** It produces scores and clawbacks (or "do not pay publisher" flags on a delay) against already-accepted events. If clawback is contractually impossible, that is a product constraint that forces more conservative Tier 0/1 or accepted leakage — it does not magically make graph fraud sub-second. See [ADR-003](./04_architecture_decision_records.md#adr-003).
8. **Every accept/drop/clawback is auditable.** Advertiser and publisher disputes will come. The record (event ids, rule id / model version, lookup hit/miss, timestamps) must exist in a cheap log, not only in a dashboard that rolled off.
9. **Multi-touch and historical queries run on a lake/OLAP plane** fed by the same canonical event stream (and by decision logs). They must not read the hot KV as a source of truth for last year. See [ADR-004](./04_architecture_decision_records.md#adr-004).
10. **Cutover that affects billing requires dual-run against Hadoop** within a written numeric tolerance, for a written duration, with a kill switch back to Hadoop as system of record. See [ADR-005](./04_architecture_decision_records.md#adr-005).

## Success Criteria for the Design (Not Implementation Metrics)

1. A duplicate or replayed `click_id` is dropped (or ignored for billing) within the hot-path SLO, without waiting for Hadoop.
2. A click with a valid join key whose impression is still in TTL is attributed in the hot path; a miss is an explicit `unattributed` outcome, not a job failure.
3. The live impression working set is operable: TTL expiry matches the 30-minute window, state size is a first-class metric, and a store outage has a defined degrade (fail open to "accept unattributed + flag" vs fail closed — a written choice; see System Design).
4. A new deterministic rule can be shadow-scored against production traffic before it drops. Shipping a rule that immediately drops is a process failure.
5. Dual-run: streaming vs Hadoop attributed spend and fraud-flagged spend stay within the agreed tolerance (a percentage *and* an absolute dollar cap) for the gate duration. Divergence is investigated; it is not "streaming is newer so it wins."
6. A Tier 2 score that marks a previously accepted click as fraud produces a clawback record; billing applies it only if the contract allows; the hot path did not wait for the score.
7. A multi-touch query over a month of logs does not change hot-path latency or error rate (it cannot share the same saturation domain).
8. Hadoop can be the billing source of truth again within a defined rollback window after a bad cutover.

## Business Rules (Attribution- and Fraud-Scoped)

1. **Hot-path attribution rule is last-valid-impression (or last-click) in window for this join key**, unless product has already standardized something else *for invoicing*. Do not invent multi-touch on the click. Multi-touch is warehouse.
2. **Join key is minted at impression-serve time** and echoed on the click. The server, not the client, mints IDs. Client-minted IDs are an abuse surface.
3. **Unattributed is a first-class billing state**, mapped to contract (bill as click / do not bill / bill at a different rate). It is not "join failed."
4. **Tier 0 drops are final for that event copy** (idempotent). They still emit an audit event. They do not write an attributed conversion.
5. **Tier 1 may drop only on thresholds that were dual-run.** Borderline scores go to accept + Tier 2, not to drop. When in doubt, leak a little money rather than drop a real user; inverted, only if the contract and brand risk say so — write it down, do not leave it as an engineer preference.
6. **Clawbacks adjust future invoices or a dispute ledger**; they do not silently rewrite last week's locked invoice unless finance has a process for that. Architecture provides the event; finance owns application.
7. **Model and rule versions are on the audit record.** A dispute six months later must be reconstructable: "rule `replay_v3` dropped this," not "whatever was in prod."

## Non-Goals

- **Not a general real-time analytics platform.** No "run arbitrary SQL on the click stream" as a v1 requirement. If someone wants that, it is a different product on the lake, or a different budget.
- **Not solving all fraud.** Residential proxies, app-install farms, and human click farms will pass Tier 0. Claiming otherwise is a sales problem this architecture will not fix.
- **Not zero financial leakage.** Sub-second deterministic drop reduces the 45-minute window for *that class* of fraud. Sophisticated fraud still has a detection lag. Putting a zero on the slide is how the program is declared a failure on day 90.
- **Not a from-scratch ML / graph platform.** Tier 2 consumes scores from a model service the fraud team already has or will build as its own program. This design specifies the *integration* (async, versioned, clawback-shaped), not the model.
- **Not an implementation.** No Flink SQL, no Terraform, no model weights. Numbered steps and diagrams only.
- **Not a promise that Flink (or Spark Streaming, or Kafka Streams) embedded state will hold 4.5 billion keys cheaply.** That is an ADR, and the default is external KV. See [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Not identity-resolution / people-graph as a hot-path dependency.** Device graphs are Tier 2 / warehouse. If marketing wants "people-based attribution in real time," that is a new ASR and a new cost model.
- **Not a claim this is a one-team, one-quarter swap.** Dual-run plus a multi-TB KV plus fraud-process change is a program. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not replacing the SDK.** If the join key is missing, this project surfaces that as a blocker; it does not design a new mobile SDK. A one-line "must emit impression_id" requirement to the client team is in scope as a dependency, not as this repo's work.

## The 45-Minute Leakage Window, Named as Money

Until Phase 0 replaces this with a real figure, treat the leakage as:

**Every minute between event time and fraud-aware billing is a minute where known-bad *classes* of traffic (replay, duplicate, unattributable under an impression-required contract, obvious datacenter IP if you already block those in batch) still look like good traffic to whoever is looking at a "live" counter, and may already have been committed to a publisher depending on your payable event.**

Streaming does not remove leakage of unknown-bad traffic. It removes *delay* for known-bad. Those are different sentences. The second is this project's job. The first is the fraud team's job, on a different SLA. Conflating them is the trap.
