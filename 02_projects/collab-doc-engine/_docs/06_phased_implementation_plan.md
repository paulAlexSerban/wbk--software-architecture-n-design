# Collaborative Document Engine — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not documentation theater** — signing a global 50 ms p95 or sizing an edge fleet off a guessed editors-per-document distribution is how you ship a broken promise and then "add more WebSocket servers" in a war room.

Phases 0–4 are sequential. Phase 5 is ongoing operations after serving production traffic. A later phase must not start because a calendar slide said so if the previous gate is yellow.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never take production traffic with Redis Pub/Sub as the durable op fabric, without state-vector resync, or with a single histogram that claims global 50 ms p95.** Those are not follow-up tickets.

Calendar is *not* "two sprints." Phase 0 might be a week of measurement plus a fight about the SLO wording. A correct single-region CRDT on a **sample** might be months — the schema of tables and comments is the work. 500k sessions in three regions is a function of PoP build-out and a load test that includes the p99 hot document — **not** a promise of Phase 1. Anyone who schedules "global 50 ms p95, 500k sessions" at the end of month one has not read [Business Overview — The Math](./01_business_overview.md#the-math-the-actual-requirement).

## Phase 0 — Measure Sessions, Physics, and the SLO Split (before PoPs)

**Objective**: Replace the load-bearing guesses (editors per document, latency matrix, document size, what "50 ms globally" is allowed to mean) with measurements and a written SLO. Refuse to size the edge fleet or to sign a latency contract until this gate is green.

**Deliverables:**
- **SLO split in writing**, signed by product: local apply; intra-region / same-PoP peer p95; cross-region lag by pair. The prompt's single global 50 ms sentence is either **rewritten** or **explicitly rejected**. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-global-p95-50-ms-is-the-wrong-slo).
- **Latency matrix**: probe RTT between target user metros and candidate PoP/home regions (p50/p95/p99), including the 350 ms last-mile tail the prompt names. Fiber floors vs observed.
- **Editors-per-document histogram** from the current system (or a comparable product): p50/p95/p99 of N, and the existence of all-hands-class outliers. Distinct live documents ≈ `sessions / N`.
- **Document size sample**: visible bytes vs stored bytes today; peak docs; reconnect times today (the incident you are replacing).
- **Offline reality**: do users actually work hours offline, or is that a theoretical? If no, resync still matters for blips; compaction still matters; you may de-scope airplane-mode UX, not the state vector.
- **CRDT format shortlist** (Yjs / Automerge / internal) with a *downsampled* bake-off: text+marks+a table type, concurrent edits, GC, payload size. Quote engineering cost, not just npm stars.
- **Residency/offline legal one-pager**: can a full local replica exist in APAC for an EU-home doc?
- One-page unknowns log: each item `measured` or `open, fallback assumption is X`. Open items that kill feasibility (global 50 ms insisted; N in the thousands without a viewer/editor split; residency forbids local-first) are flagged immediately.

**Exit Gate:**
- [ ] SLO is three numbers (or more), not one global 50 ms p95 that includes cross-continent pairs — unless product **explicitly accepts** that the third number cannot be 50 ms and the contract is rewritten.
- [ ] N histogram exists; p99 N is named; a product cap or hot-doc plan exists if p99 is large.
- [ ] CRDT family chosen for the *schema you will actually ship* (not text-only).
- [ ] Residency vs local-first is decided per tenant class.
- [ ] Feasibility call: **intra-region 50 ms + local-first + CRDT resync fits a fundable PoP plan → proceed.** **Insistence on Tokyo-sees-NYC in 50 ms p95 → kill/escalate**, do not quietly enter Phase 1 as if fiber will shorten.

Do not buy the full three-region edge fleet in Phase 0. Buy enough to measure.

## Phase 1 — Single-Region CRDT Correctness (local apply, one edge, persist)

**Objective**: Prove the data path: local CRDT apply → local persist → one edge relay → home oplog → peers in the same region. No cross-region. No 500k. Correctness, checksums, and "typing does not wait on home ACK."

**Deliverables:**
- Client engine with stable `replica_id`, local store, outbound queue.
- One regional edge: document-sticky sessions, coalesce per [System Design §3](./03_system_design.md#3-edge-relay-batching-and-fan-out).
- Home document service: append-only log (not row-per-keystroke), idempotent `op_id`.
- Editor path for text + marks at minimum; tables as a **named** type or an explicit "out of Phase 1" with the consequence that Phase 3 cannot discover table CRDTs.
- Tests: two clients same position; disconnect mid-type; home restart does not reorder/lose identified ops; checksums match at a vector.
- **No Redis Pub/Sub on the op path**, even "temporarily."

**Exit Gate:**
- [ ] Local apply p99 < 16 ms on a representative doc size (measured on target devices, not only a developer laptop).
- [ ] Originator paint does not wait on home ACK (explicit test: home delayed 500 ms, caret still instant).
- [ ] Two-peer intra-lab visibility instrumented; not yet the 50 ms production SLO, but the histogram exists.
- [ ] Checksum mismatch test is red if you deliberately corrupt an op; green on the happy path.
- [ ] No production traffic. This gate is not a launch.

If the chosen CRDT cannot represent the Phase 1 schema without last-write-wins blobs, **stop and change the schema or the library**. Do not "make up for it in OT later."

## Phase 2 — Resync, Offline, Snapshot, Compaction

**Objective**: Replace snapshot-every-reconnect and prove hours-offline merge. This is the phase that kills the prompt's reconnect incident. Still one region.

**Deliverables:**
- Hello/state-vector protocol; delta vs snapshot+tail per [System Design §4](./03_system_design.md#4-resync-protocol).
- Snapshot store; compaction job; grace window; N snapshot generations retained.
- Hours-offline test: 4-hour local queue vs server that compacted past the old vector; merge local ops after snapshot install; checksum.
- Reconnect herd drill on a *small* fleet (thousands of clients): jitter, snapshot cache, delta ratio for short blips.
- Presence channel **separate** from ops ([ADR-006](./04_architecture_decision_records.md#adr-006)); load test that presence drop does not drop ops.
- Metrics: resync bytes, delta vs snapshot ratio, document CRDT/visible ratio, time since compact.

**Exit Gate:**
- [ ] Short disconnect (2 s) uses delta, not snapshot, in the test harness.
- [ ] Hours-offline + compaction scenario passes checksum and does not clobber local queue.
- [ ] Compaction of a hot test doc reduces payload; deleted text does not resurrect; previous snapshot generation still restorable.
- [ ] Reconnect herd drill does not take down home (cache or fail the gate).
- [ ] Presence cannot be injected into the oplog (review + test).

Do not start multi-region until this gate is green. Multi-region without resync is three copies of the reconnect incident.

## Phase 3 — Multi-Region Home, Async Replicate, Presence at Distance

**Objective**: Home-region assignment, replicator, second (then third) region. Cross-region lag is **measured and owned**, not stuffed into the intra-region SLO.

**Deliverables:**
- Router: `doc_id → home_region`; ACL at bind.
- Replicator: at-least-once batches; idempotent apply; lag histograms **per region pair**.
- Remote edge fan-out for documents with local editors; no full mesh of all live docs into every region by default.
- Presence: same-PoP full fidelity; cross-region best-effort / throttled.
- Partition drill: split regions, edit both sides, heal, checksum (union, not winner-takes-all).
- Optional: re-home runbook on a test doc (can slip to Phase 4 if Phase 3 time is tight; **do not** skip the partition drill).

**Exit Gate:**
- [ ] Intra-region p95 histogram and cross-region lag histogram are **different panels**; alerts do not share a 50 ms threshold.
- [ ] Cross-region p95 sits near the measured matrix from Phase 0 (physics-consistent), not 50 ms.
- [ ] Partition-heal checksum passes.
- [ ] A document with editors only in region B does not full-firehose into region C with zero editors (bandwidth test).
- [ ] Home loss drill: RPO written down; failover or read-only behavior matches the write-up.

## Phase 4 — Fan-out at Target Concurrency, Latency Validation, 500k-shaped Load

**Objective**: Prove the intra-region 50 ms SLO at realistic N, and the connection fleet at 500k-*shaped* load (or a documented fraction with a linear model). Validate the [latency ledger](./03_system_design.md#7-latency-budget).

**Deliverables:**
- Document-sticky relay trees for hot docs; load test at **p99 N** from Phase 0, not only mean N.
- Connection load toward 500k (or staged: 50k → 150k → 500k) with presence on; watch memory, not only CPU.
- PoP kill + reconnect herd at this scale (jitter, snapshot cache).
- Coalesce window tuned against the 50 ms budget (show that 100 ms coalesce fails the SLO).
- Capacity model: connections × regions × HA; hot-doc send/s; replicator bandwidth.

**Exit Gate:**
- [ ] Intra-region peer p95 < 50 ms at agreed N and PoP placement, **excluding** last-mile 350 ms users who cannot reach a nearby PoP — those are sliced out and reported, not averaged away.
- [ ] Hot-doc test at p99 N stays up; if it does not, product cap or viewer/editor split is **accepted in writing** before launch, not hoped.
- [ ] 2× coalesce-window experiment exists; the team can explain why they did not pick it.
- [ ] Kill criterion: if the only way to "hit 50 ms globally" is to exclude APAC from the histogram, **do not publish that histogram as global**.
- [ ] Full 500k not required on day one of the gate if a 20% test plus a model is accepted — **silent** "we will scale" is a failed gate. Coverage of the load test is printed.

Do not tell customers 500k concurrent if the test stopped at 20k idle connections with N=2.

## Phase 5 — Production Degradation Monitoring (ongoing)

**Objective**: Make "sync got worse" and "docs are inflating" detectable without a quarterly CRDT research reading. Entry requires Phase 2 metrics and Phase 3 lag histograms.

**Entry Gate:** Serving real users, even if session count is still climbing. Monitoring is not delayed until 500k.

**Deliverables:**
- Dashboards + pages: local apply (sampled RUM), intra-region p95, cross-region lag by pair, replicator age, resync mix, CRDT/visible ratio, `checksum_mismatch`, `presence_dropped`, hot-doc ops/s.
- Canaries: synthetic two-peer intra-region ping on each PoP; cross-region canary docs.
- Game day: pause compaction (size alert); pause replicator (lag page); corrupt a replica (checksum SEV); PoP fail (herd).
- Compaction SLO: time-since-compact and size ratio have owners.
- Golden concurrent-edit fixtures (text, list, table) run on a clock against **production** engines, not only CI.

**Exit Gate** (re-checked continuously; never "done"):
- [ ] Staged regressions are **detected by the intended signal** in a game day.
- [ ] Mixed global-50 ms dashboard cannot be the only latency view (policy).
- [ ] Golden fixtures updated when schema changes.
- [ ] Logging/probe retention reviewed against document classification.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the sockets green" — if any of the following hold:

1. **SLO miss as written**: product still requires global p95 < 50 ms including cross-continent peers, and will not rewrite the contract. Honest output: "this requirement is not feasible as stated." Adding WebSocket servers or switching CRDT brands is not a workaround. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-global-p95-50-ms-is-the-wrong-slo).
2. **Redis Pub/Sub (or equivalent at-most-once bus) as the durable op fabric** in any environment past Phase 0. Kill the deploy. Presence cache in Redis is not this criterion; **ops on Pub/Sub is**.
3. **Launch without resync**: full snapshot on every connect as the only path. Block traffic. This is the incident in the prompt.
4. **Checksum mismatches in production** reproduced and not treated as SEV. Stop expanding traffic; the engine is wrong.
5. **ACL fail-open** on bind or fan-out. Kill the deploy.
6. **GC resurrecting deleted content** or compacting without a restorable previous snapshot generation. Stop compaction; fix; do not "free the RAM."
7. **Typing waits on cross-region ACK** (regression to server-authoritative). Roll back the client/edge immediately.
8. **p99 N ignored**: fleet sized for mean N=8, production all-hands doc at N=400 takes down a PoP, and the response is "add servers" without a document-sticky tree or a product cap. Halt scale-up of *traffic* until the hot-doc plan exists.
9. **Pressure to ship OT-in-the-middle** to hit a date. Research stays off the serving path ([ADR-001](./04_architecture_decision_records.md#adr-001)).

Rollback is always to the last phase whose exit gate was honestly green (including the previous snapshot generation of the protocol). After a kill, stakeholders still get the measured N histogram, the latency matrix, the SLO split, and a recommendation: rewrite the global 50 ms sentence, cap N, fund PoPs, or drop offline. They do not get a confident global 50 ms collaborative engine we never had.
