# Ad-Tech Click Fraud & Attribution Engine — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need Flink."** Building a 4.5-billion-key KV against guessed rates is how you buy a cluster that is empty or a cluster that melts. Dual-run against Hadoop billing numbers is mandatory before any phase that moves money. Phase 5 closes Hadoop as a decision engine; cutting it earlier to save opex is a kill criterion.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is a **multi-quarter program**, not a one-week death march. A realistic Phase 0 is weeks (instrumentation, legal, finance). Phase 1–2 is the KV POC and shadow decisions. Cutover is gated on **weekly close cycles**, which you cannot accelerate by deploying more often. Do not compress Phase 4 by skipping a close.

## Phase 0 — Measure the Batch and the Money (before any streaming rewrite)

**Objective**: Replace the scenario's round numbers with production numbers, name whether this project is a streaming program or a micro-batch/file-grain incident, and lock the constraints that would invalidate the design (no join key, no clawback, no KV operators). See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- Peak and p95 impression/s and click/s from collectors (not the marketing slide). Event payload size p50/p95.
- Hadoop (or Spark) job wall time p50/p95/p99, overlap/skip rate, whether duration is shuffle-work vs waiting on hourly files.
- Join-key presence rate on clicks; `click_id` uniqueness/collision estimate; synthetic-id need.
- Event_time vs ingest_time histogram; reorder rate (click before impression); late-arrival tail.
- Duplicate `click_id` rate; current batch fraud catch rate by category (replay vs model vs deny-list).
- Dollar estimate: spend in a 45-minute window; spend currently flagged fraud (even if late); recovery/clawback rate historically.
- Contract summary: clawback / withholding allowed? Invoice semantics (last-click vs other)? Attribution window in the IO vs the 30-minute batch window.
- Billing system's ability to unique `click_id` / apply compensating clawbacks.
- Written FP budget for hot-path drops; written dual-run bands (percent **and** dollars).
- Platform: who operates a multi-billion-key KV; existing log/lake reality.
- A one-page "unknowns log": each item `observed`, `ruled out`, or `still open`. Open items that change the design (no join key, global window required, clawback forbidden) flagged immediately.

**Exit Gate**:
- [ ] Rates, job-duration *cause*, join-key fill rate, and a leakage dollar range exist as **measured** figures.
- [ ] Go/no-go: **rates + leakage + sub-second need justify a KV → proceed to Phase 1.** **File-wait 45 minutes and modest rates → micro-batch the lake, emit decision records, stop this program's KV/evaluator.** Both outcomes are successful Phase 0.
- [ ] If proceeding: join-key plan is written (exists today, or a dated client dependency with a fill-rate target). Phase 2 cannot start below that target.
- [ ] Clawback legality is written. If forbidden, Tier 2 is explicitly "score only / withhold future," not silent money movement.
- [ ] Dual-run bands and FP budget have finance/fraud signatures (even if the signature is "we will not sign zero").
- [ ] Billing uniqueness on `click_id` is confirmed or is a **blocker** (fix billing first).

Do not "start Flink in parallel" before this gate. Parallel is how the wrong-sized KV gets a head start.

## Phase 1 — Canonical Log + Tier 0 Shadow (no cutover, no full join)

**Objective**: Make events uniquely identifiable and replayable, and prove that **deterministic** rules can be scored in a consumer without affecting the invoice. Prove ingest at real rates (or a honest scaled POC) *before* buying the full impression KV.

**Deliverables**:
- Collectors publish to a canonical log (compact encoding). Hadoop switched to **consume the log or the lake derived from it**, not a second SDK path. This may be the hardest political deliverable.
- Lake sink of raw events with `event_id` / `click_id` / `impression_id`.
- Click consumer: Tier 0 **shadow only** — emit `would_drop` decision records, Hadoop still invoices.
- Shadow metrics: would-drop rate by rule vs Hadoop flags for the same ids (where Hadoop has an analogue).
- Log cluster sized with headroom; consumer lag and watermark dashboards.
- KV **POC plan** scheduled: not necessarily production traffic yet; a cardinality test cluster may be procured here but is not required to be on the serving path.

**Exit Gate**:
- [ ] Hadoop invoice still matches pre-Phase-1 closes (ingest change did not shift money). If it did, **stop** and fix ingest alignment; do not start the KV.
- [ ] Shadow Tier 0 vs Hadoop: disagreements are classified (streaming extra, Hadoop extra, id mismatch). No unexplained dollar-class gap in the *overlap of rules that both have*.
- [ ] Late_click_rate and reorder rate are visible and believed.
- [ ] Full raw PII is not in a general debug log at 3M/s.
- [ ] Kill switches exist per Tier 0 rule (even in shadow: a rule that would-drop 20% is a page).

If the log cannot hold production rate, **do not start Phase 2**. The join will not be the first fire.

## Phase 2 — Impression KV + Attribution Lookup, Dual-Run vs Hadoop

**Objective**: Put the 30-minute join on a TTL'd KV and emit `accept_attributed` / `accept_unattributed` in shadow. Prove the store at **cardinality and write QPS**, not on a 1% sample that always works.

**Deliverables**:
- Impression indexer PUT with TTL `W+L`, first-write-wins / `expires_at` in value.
- Click evaluator GET + event-time delta; repair consumer for click-before-impression.
- Decision records for attribution outcomes, still **not** the invoice.
- Comparator v1: join Hadoop attributed clicks to streaming decisions on `click_id`; **spend delta** and miss-each-way.
- KV dashboards: keys, write QPS, GET p99, evictions, hotspot shards.
- Runbook: warm a KV from last `W+L` of the log (the 4.5B-write event).
- Forced drills: KV timeout → fail open; impression replay must not extend window.

**Exit Gate**:
- [ ] POC or production-like cluster held **production-like key count** and **write QPS** with TTL churn for a duration that includes a daily peak. A 10-minute demo is not a gate.
- [ ] Lookup hit rate is in a band explained by join-key fill + reorder + true unattributed — not "50% and we will fix it later."
- [ ] Dual-run attribution **counts and spend** inside a *preliminary* band for a defined shadow period (working: **two weeks of peaks**, not one afternoon). Final billing band is Phase 4; this gate is "not insane."
- [ ] Repair path does not wait in the evaluator; pending size is bounded.
- [ ] Evaluator p99 including GET is within the sub-second SLO on shadow traffic (or on a production mirror).
- [ ] Checkpoint/ops: if anyone still proposed Flink state for the join, it **lost** this gate unless it independently passed the same cardinality test. Default remains external KV ([ADR-002](./04_architecture_decision_records.md#adr-002)).

If the KV fails this gate, **kill the streaming join** (see standing criteria). Micro-batch attribution on the lake is the fallback, not RocksDB-as-a-surprise.

## Phase 3 — Tier 1 Hot Path (Shadow then Limited Drop) + Tier 2 Clawback Pipeline

**Objective**: Put cheap heuristics on the hot path the same way Tier 0 was proven, and stand up async scoring **without** billing from it until clawback application is a signed process.

**Deliverables**:
- Tier 1: too-fast, over-frequency (per-impression atomic), campaign mismatch; **shadow first**.
- Per-impression frequency counters on the KV record.
- Tier 2 workers: features at minute–hour grain, batch model, clawback topic, model version on the record.
- Billing **sandbox** applying clawbacks to a shadow ledger; production ledger still Hadoop.
- Fraud monitoring: score drift, would-claw volume, overlap with Hadoop's late fraud flags.
- Support/dispute draft: reason-code taxonomy for drops vs scores.

**Exit Gate**:
- [ ] Tier 1 shadow FP vs labeled or sampled traffic is **inside the signed FP budget**. Only then may a flag enable **drop** for those rules, still with Hadoop as invoice (drops in streaming are still shadow wrt money until Phase 4 — unless a rule already exists identically in Hadoop; even then, streaming drop must not *widen* Hadoop's drop set without a signed delta).
- [ ] Tier 2 clawbacks in sandbox: applied fold is idempotent; reruns do not stack refunds.
- [ ] Hot-path p99 **unchanged** by Tier 2 (separate consumers; no model HTTP in evaluator). A spike in evaluator latency during a model deploy is a failed gate.
- [ ] Legal has signed the clawback-application path (or signed "score only").
- [ ] Hadoop remains invoice. This phase does not "go live on fraud" for money.

Enabling a new drop rule in production money is a **Phase 4 concern** (or a late Phase 3 flag that still does not change the invoice until 4). Prefer: Phase 3 never changes the invoice.

## Phase 4 — Cutover: Streaming Becomes Billing System of Record

**Objective**: Point billing at streaming decision records (and at clawbacks if signed). Hadoop remains a **fallback and audit** producer for a time-box, still consuming the same log.

**Entry Gate**: Phase 2 dual-run is in the **final** finance band for **four consecutive weekly closes** (or the signed equivalent). Phase 3 drops that will apply at cutover have been shadow-true against that same period. This phase does not start because the KV is "stable."

**Deliverables**:
- Billing pointer switch runbook: streaming decisions in, Hadoop out, with a **same-day rollback**.
- Clawback application in production per signed policy (or explicitly off).
- Live counters for ad ops pointed at the decision stream so "real-time" is not still a 45-minute batch with a new logo.
- Time-box date for Hadoop-as-fallback removal (Phase 5), on a calendar.
- Support note: unattributed vs drop vs clawback; two-number world (invoice vs warehouse multi-touch).

**Exit Gate**:
- [ ] At least one weekly close on streaming as invoice **inside the band vs the Hadoop audit run** (Hadoop still running). A close that "looks fine" without the audit job is a failed gate.
- [ ] Rollback drill actually executed in a lower environment or a documented tabletop with finance; RTO is known.
- [ ] Fail-open behavior did not silently become fail-closed in production configs.
- [ ] Residual leakage metric (Tier-2-only fraud, aged) is on a dashboard finance has seen.
- [ ] If Phase 0 said Hadoop applied a model that streaming Tier 0/1 does **not**: those dollars are either in Tier 2 clawback or **accepted leakage**, in writing. Do not cut over a *weaker* fraud set by accident.

## Phase 5 — Decommission Hadoop as Decision Engine; Lake/OLAP Owns History

**Objective**: Stop paying for a second *decision* engine. Keep the lake. Multi-touch is a warehouse product. Hadoop MR jobs that only exist to duplicate the evaluator are turned off.

**Entry Gate**: Phase 4 exit is honestly green for the time-box (working: **two additional weekly closes** after the first streaming close). Fallback Hadoop has been unused except audit.

**Deliverables**:
- Hadoop decision job off; audit job optional for one more quarter then off.
- OLAP multi-touch jobs documented as **not invoice** unless finance changed that (new ADR).
- KV and log runbooks without "and then the MR job."
- Cost retro: actual KV + log + dual-run spend vs Phase 0 leakage estimate. Write it down even if it is embarrassing.

**Exit Gate**:
- [ ] Invoice still closes inside band with Hadoop decision job **off**.
- [ ] Replay/backfill from lake proven once in this phase (evaluator_version side table).
- [ ] No remaining consumer still dual-ingesting from a legacy HDFS dump as if it were canonical.
- [ ] Ownership: KV, evaluator, Tier 2, comparator-or-successor monitoring, lake tables — named on-call rotations.

This phase may be short (Hadoop already a thin Spark-on-lake job) or long (political decommission). Both are successful if the decision engine is singular and the warehouse is labeled.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the billing pointer back, or kill the project — do not "keep streaming invoicing to see if it settles" — if any of the following hold:

1. **Phase 0 says micro-batch is enough.** Building the KV anyway is résumé-driven. Kill this program's hot path; keep event ids and a lake.
2. **Join-key fill rate below the Phase 0 target** at Phase 2. Do not fuzzy-join. Block on the SDK.
3. **KV cardinality/QPS POC fails.** Kill the streaming join. Do not "temporarily" put 4.5B keys in Flink managed state to save the narrative.
4. **Dual-run spend delta outside the signed band** for a close. Hadoop remains or returns as invoice. Investigate; do not widen the band after the fact to make a gate pass.
5. **Pressure to turn off Hadoop before the Phase 4/5 gates** to save opex. That request is a kill criterion for *cutover quality*, not a savings idea. Refuse, or the rollback story is gone.
6. **Hot-path drop FP exceeds signed budget** (or a rule would-drops an unexplained spike). Kill-switch the rule. Do not "tune in production" on the invoice.
7. **Evaluator p99 includes a model call** or otherwise leaves the SLO. Strip it. Tier 2 exists.
8. **Billing cannot unique `click_id`.** Stop the program until it can. Streaming will double-apply.
9. **Clawbacks stacking or applying where contracts forbid.** Turn off application; scores may continue.
10. **Window extension to hours of raw impressions in the KV** without a new capacity approval. Refuse; that is a new working set.

Rollback is always to the last phase whose exit gate was honestly green — typically "Hadoop is the invoice, streaming is shadow." After a kill, the honest output is the Phase 0 measurements plus whatever micro-batch or deny-list improvement is justified. The output is not a half-cutover evaluator that invoices 10% of publishers on streaming, undocumented, while Hadoop still shuffles a 45-minute join for the rest.
