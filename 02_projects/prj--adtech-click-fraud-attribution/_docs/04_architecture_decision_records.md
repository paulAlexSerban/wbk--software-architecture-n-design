# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

<a id="adr-001"></a>
## ADR-001: Streaming Decision Path over Hadoop Batch as System of Record

**Status**: Accepted

**Context**: Attribution and fraud currently run in a Hadoop batch that takes up to 45 minutes. In that window, replay, duplicates, unattributable clicks, and any other fraud the batch already knows how to flag are still treated as good traffic by anyone watching a "live" counter, and may already be committable as publisher payables. The rates (350k clicks/s, 2.5M impressions/s) are not a fit for "run MapReduce more often" if the 45 minutes is *work* (shuffle of a 30-minute join, wide fraud features), though they might be a fit if the 45 minutes is *waiting for hourly files* — Phase 0 must say which.

The expected redesign is a real-time stream-processing architecture with sub-second evaluation. That class of system is correct for **time-to-knowledge** of events that are already decidable. It is not a drop-in of the Hadoop job into Flink, and it is not an immediate replacement of the invoice.

**Decision**: Introduce a canonical event log and a hot-path click evaluator as the *future* system of record for click-level accept/drop/attribute decisions. Hadoop (or Spark-on-lake) continues to produce the **invoice** until the dual-run gate in [ADR-005](#adr-005). Collectors write **once**; Hadoop becomes a consumer of the same log/lake, not a second tap on the SDK. Sub-second SLO applies to Tier 0 + lookup + Tier 1 only ([ADR-003](#adr-003)).

**Consequences**:
- (+) Knowable-bad traffic can be dropped or flagged in the hot path instead of after 45 minutes.
- (+) Replay and dual-run have a single event identity.
- (+) Hadoop can be rolled back as invoice source without rebuilding ingest.
- (–) Dual-running both stacks is months of double opex and double on-call. That cost is mandatory, not optional "if we have time."
- (–) A stream processor is a new operational competency if the team only runs Hadoop. Budget it.
- **Alternative rejected**: "Just schedule Hadoop every 5 minutes." If the job does 45 minutes of work, this produces overlapping jobs. If the job is I/O-wait on hourly files, micro-batch is a valid **interim** (and Phase 0 may choose it as a hedge) but it does not meet a sub-second deterministic-drop SLO.
- **Alternative rejected**: Rewrite billing inside the stream job. Billing is a ledger with its own idempotency and disputes. This system emits facts.
- **Revisit trigger**: Phase 0 shows real rates orders of magnitude below the slide *and* leakage dollars do not pay for a KV. Then micro-batch on the lake may be the whole design; keep the **seams** (join key, decision records, dual-run) anyway.

<a id="adr-002"></a>
## ADR-002: External TTL'd KV Lookup over Embedded Stream-Processor Window State

**Status**: Accepted

**Context**: The scenario asks for a sliding-window join of clicks to impressions over 30 minutes. Literal windowed join at 2.5M impressions/s is 4.5 billion live keys. Compact records are ~0.9–1.8 TB unreplicated; replicated working set is several TB. Stream processors *can* hold keyed state at this scale (RocksDB/changelog) in principle. In practice, checkpoint duration, recovery time, and operational blast radius at multi-TB Flink state are a specialized skill. A windowed `interval join` that is really "state.get(join_key)" does not need the join operator; it needs a store that is good at millions of TTL'd PUT/GET per second.

Real attribution is a **point lookup** on a server-minted `impression_id` carried by the click. If that key does not exist, the problem is the SDK, not the join algorithm.

**Decision**: Attribution in the 30-minute window is a **GET** against an **external, TTL'd, partitioned KV** sized for ~4.5 billion keys and ~2.5M writes/s. The stream/consumer job is **almost stateless** on the join (optional LRU cache). KV TTL = window + lateness slack. Attribution correctness still checks event-time delta, not TTL alone. Fuzzy device+campaign matching is **out of v1**. Repair of click-before-impression uses a much smaller pending-click index, not a wait in the evaluator.

Embedded Flink/Spark state as the *system of record* for the 4.5B-key window is **rejected** unless a Phase 2 POC proves checkpoint/restore and p99 under production-like churn — and even then the KV is the default because it is independently operable (bounce evaluators without rebuilding 4.5B keys from a changelog).

**Consequences**:
- (+) Join complexity is O(1). The scary number is sized as a store, not as "Flink will handle it."
- (+) Evaluator restart does not mean 4.5B-key recovery before clicks can flow (KV is already warm). Warming a **new** KV is still a planned 4.5B-write event.
- (+) Independent scaling: write-heavy KV vs CPU-heavy evaluator.
- (–) A new (or newly sized) KV cluster is the largest infra cost on the hot path. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- (–) Network hop on every click GET. Design for in-region, compact records, p99 SLO that includes this hop.
- (–) Consistency: evaluator and indexer are separate; click-before-impression is a first-class miss + repair, not a transaction.
- **Alternative rejected**: True N×M sliding-window join. Intractable at this cardinality. Anyone proposing it has not multiplied 2.5e6 × 1800.
- **Alternative rejected**: Warehouse table "queried from the stream job." Warehouse p99 is not the click SLO.
- **Alternative rejected**: Redis as a casual default. Redis *may* work at this size with a large cluster and careful TTLs; it is not the assumed winner. Phase 2 POC at **cardinality**, not at 1% sample.
- **Revisit trigger**: Join key missing on a material fraction of clicks. Then this ADR is the wrong shape; stop and fix signals. Do not "just interval-join on IP."

<a id="adr-003"></a>
## ADR-003: Three-Tier Fraud — Inline Deterministic Drop vs Async Probabilistic Clawback

**Status**: Accepted

**Context**: The scenario asks for **simultaneous** sub-second evaluation, **deterministic** fraud dropping, and detection of **botnets, IP spoofing, fast-click replay, and proxy networks**. Replay and malformed traffic can be deterministic (same inputs → same drop) and cheap. Fast-click can be a threshold on impression-to-click delta (Tier 1). Botnets, residential proxies, and spoofing that survived the packet path are **scores over time and graphs**. Putting them on the sub-second path means lying about latency, quality, or both. "Deterministic neural net" is not a thing you can defend in a publisher dispute.

Hadoop hid this by giving the model a 30–90 minute materialized window "for free." Streaming does not.

**Decision**: Split fraud into three tiers:

- **Tier 0**: deterministic, hot path, drop. Schema, duplicate `click_id`, insane timestamps, deny lists already proven in batch.
- **Tier 1**: cheap heuristics using the KV record and per-impression counters, still hot path, drop only after shadow. Too-fast, over-frequency, campaign mismatch.
- **Tier 2**: async models (botnets, proxies, farms). **Cannot block the click.** Emits versioned clawbacks. Billing applies if contracts allow.

The combination "fully deterministic + sub-second + catches botnets" is **rejected as a single SLA**. Fast-click replay is in Tier 0/1. Botnets are in Tier 2. IP spoofing: only the cheap, already-batch-proven checks are Tier 0; the rest is Tier 2.

Hot-path default under uncertainty: **fail open** (do not drop). Leakage of a maybe-bot is preferred to 350 false drops per second at 0.1% FP. Invert only with a written brand/legal decision.

**Consequences**:
- (+) Sub-second SLO is achievable because the model is not in it.
- (+) Disputes get a rule_id for drops, not "the model said 0.81."
- (+) Fraud science can ship models on a slower cycle without taking down billing.
- (–) Sophisticated fraud still has detection delay. The 45-minute Hadoop window is **not** fully closed for that class. Residual leakage is a success metric, not a surprise.
- (–) Clawback requires contractual ability to reverse or withhold. If Phase 0 legal says no, Tier 2 does not recover money; it only trains models and maybe withholds *future* traffic. Architecture cannot invent a clawback right.
- (–) Two cultures (streaming eng vs data science) must share versioning and dual-run. Process is harder than the topics.
- **Alternative rejected**: One Flink job runs the current Hadoop model inline. Will miss SLO or force a worse model, usually both.
- **Alternative rejected**: Block traffic at the edge CDN with the ML model. Same SLO problem plus worse audit.
- **Alternative rejected**: Wait for a perfect model before streaming. Leaves the 45-minute leak of *simple* fraud on the table. Ship Tier 0 first.
- **Revisit trigger**: Product/legal requires that no click is billable until a botnet model returns. Then the SLO is no longer sub-second; redesign as queued-accept and tell sales. Do not hide a 200 ms model in the "sub-second" budget at 350k/s.

<a id="adr-004"></a>
## ADR-004: Decoupled Lake/OLAP for Historical Multi-Touch, not Hot-Path Queries

**Status**: Accepted

**Context**: The scenario requires multi-touch attribution queries across petabytes of historical click logs **and** sub-second click evaluation. Multi-touch (linear, time-decay, position-based) is a re-aggregation over a user's or device's history, often days to months, not a 30-minute last-impression GET. Serving it from the same KV or from Flink state means either keeping petabytes hot (fantasy) or scanning cold data on the decision cluster (SLO death).

Last-click / last-impression in a 30-minute window is what the **invoice for this click** can use. Multi-touch is how marketers *analyze*. Mixing them without documenting which number is the invoice is how finance and analytics fight.

**Decision**: All events and decision/clawback records sink to a **data lake table format**. Multi-touch and long-range queries run on **OLAP/warehouse** jobs and cubes. The hot KV is not a historical store and is not queried by the warehouse. The click evaluator does not compute multi-touch. Invoice semantics stay last-valid-impression-in-window (or whatever product already invoices) until a *separate* finance decision changes the invoice, which is not this project's default.

**Consequences**:
- (+) Click SLO cannot be killed by an analyst's 18-month query.
- (+) Petabyte retention follows existing lake/compliance, not RAM.
- (+) Dual-run Hadoop can read the same lake ([ADR-005](#adr-005)).
- (–) "Real-time multi-touch dashboard" is not a deliverable of the hot path. If product needs it, it is an approximate streaming aggregate with a different SLO, a new ADR, and a willingness to be wrong vs the warehouse.
- (–) Two numbers will exist (invoice last-touch vs warehouse multi-touch). Ad ops must be told. This is documentation, not a bug.
- **Alternative rejected**: Serve last-year queries from the lookup cluster. That cluster's job is 30 minutes of keys.
- **Alternative rejected**: Compute multi-touch in the evaluator "because we have the user history in state." That is a people-graph, not this project.
- **Revisit trigger**: Finance changes the **invoice** to a multi-touch formula. Then the hot path still does not compute it; a **daily settlement job** on the lake does. Real-time last-touch remains a leading indicator, not the bill.

<a id="adr-005"></a>
## ADR-005: Dual-Run / Shadow against Hadoop Billing Numbers before Cutover

**Status**: Accepted

**Context**: Streaming decisions will not match Hadoop exactly even when both are "correct": window-edge effects, lateness, repair, rule versions, and Hadoop's own bugs. Attribution **moves money** (advertiser invoices, publisher payouts). Treating a new pipeline as source of truth because it is newer is how you create a quarter of uncollectable invoices and a publisher revolt. The Hadoop number is the one contracts and finance currently understand.

**Decision**: Until a written gate:

1. Hadoop (on the canonical log/lake) remains **system of record for billing**.
2. Streaming emits decisions in **shadow**: compared, not invoiced.
3. Comparator joins on `click_id` and reports count match, attributed-spend delta, fraud-flagged-spend delta, and per-rule disagreement — **percent and absolute dollars**.
4. Cutover (Phase 4) requires: divergence inside agreed bands for a written duration (working: **four consecutive weekly close cycles**, not "a good Tuesday"); kill switch back to Hadoop within a defined window; finance and ad ops signatures.
5. Ties and unexplained gaps: **Hadoop wins**. Streaming is wrong until proven otherwise, including when streaming "catches more fraud" — that is a **claim** to validate with samples, not an automatic win.

**Consequences**:
- (+) Cutover is a measured financial event, not a deploy.
- (+) Rollback is a billing pointer, not a cluster archaeology project.
- (+) "Streaming found more fraud" is investigated (could be false positives).
- (–) Double opex until Phase 5. Teams will want to turn Hadoop off to save money. That pressure is a **kill criterion** if it precedes the gate.
- (–) Comparator engineering is real work (event-id alignment, timezone, spend tables). It is not a side notebook.
- **Alternative rejected**: Cut over a single publisher as "canary" *without* a dollar comparator. One publisher can look fine while a second vertical is systematically misattributed.
- **Alternative rejected**: Shadow only counts, not spend. Counts hide CPC mix.
- **Revisit trigger**: Hadoop is already so broken that finance does not trust it. Then you still need *a* baseline (manual sample, a frozen week). "There is no source of truth" is not permission to skip measurement; it is a harder Phase 0.
