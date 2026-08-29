# Multi-Region Collaborative Document Engine: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A real-time collaborative document platform that can host **~500,000 concurrent editing sessions** across North America, Europe, and Asia, where users regularly edit the *same* large documents simultaneously, including after hours of offline work, without sequence drift or state corruption.

This is not "a textarea with WebSockets." It is a distributed consistency product with a typing surface on top. The collaboration engine is the product. The editor UI is a consumer of whatever the engine actually converged, including the cases where two people independently restructured the same table for three hours on a plane.

## Business Context
- **Product**: enterprise SaaS collaborative rich-text / document suite. Documents are large: headings, lists, tables, embeds, comments, presence. Heterogeneous size. Heterogeneous editor-count. Not a chat message.
- **Users**: knowledge workers across NA / EU / APAC, on networks from ~10 ms to ~350 ms to the nearest current origin. They type. They expect the character to appear *now*. They do not care about your broker topology.
- **Operator**: a platform team that will own CRDT compaction, reconnect storms, hot-document fan-out, and the 3 a.m. "the 800-person all-hands doc melted Redis" page. That team is the actual user of this design.
- **Constraint the prompt hides**: "p95 end-to-end propagation delay under 50 milliseconds **globally**" is stated as if it were a software SLO. Between continents it is a physics contradiction. Those two words — *globally* vs *intra-region* — are load-bearing. Phase 0 exists to split the sentence into numbers that can be true. Until then every latency claim in these docs is an **honest split labeled as such**, not a promise that Tokyo sees New York's keystroke in 49 ms.

## The Math (the actual requirement)

This is the constraint every other document in this project exists to respect. It is not a preference for CRDTs. It is a physics and fan-out ceiling.

### Light does not care about your stack

Fiber in typical long-haul routes propagates at ~2/3 *c* ≈ 200,000 km/s. Processing, serialization, TLS, and queueing sit *on top* of that floor.

| Path | Great-circle (order of) | One-way physical floor | Realistic RTT before app logic |
| --- | --- | --- | --- |
| Same metro / edge PoP | tens of km | < 1 ms | 2–15 ms |
| NY ↔ London | ~5,500 km | ~28 ms | ~70–100 ms |
| NY ↔ Frankfurt | ~6,200 km | ~31 ms | ~80–110 ms |
| NY ↔ Singapore | ~15,000 km | ~75 ms | ~150–220 ms |
| London ↔ Singapore | ~11,000 km | ~55 ms | ~140–200 ms |
| User on 350 ms last-mile to origin | last-mile dominates | — | 350 ms to *first hop*, before any peer |

**The conclusion, which is not optional:** a p95 of 50 ms for *cross-continent, end-to-end, other-user-sees-the-keystroke* is not an architecture problem. It is false. No CRDT, OT, QUIC, or "edge compute" removes 75 ms of one-way floor. The architecture's job is:

1. Make **your own typing** independent of the network (local-first apply).
2. Make **same-region / edge-adjacent peers** see ops with p95 < 50 ms, which *is* a software problem (fan-out, batching, no central Redis hop across an ocean).
3. Treat **cross-region convergence** as a separate SLO with a floor of ~100–300 ms, observed, not promised below physics.

Anyone quoting a single global 50 ms number is either measuring local apply, measuring intra-region only, or lying. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-global-p95-50-ms-is-the-wrong-slo).

### 500,000 sessions are not 500,000 documents

| Assumption | Working value | Why it is load-bearing |
| --- | --- | --- |
| Concurrent editing sessions | 500,000 | The number in the prompt. A session is one user↔one document connection plus presence. |
| Mean editors per active document | unknown; working **8** (range 1 for a private note, 50–800 for a war-room / all-hands doc) | Distinct hot documents ≈ `500k / N`. At N=8: **~62,500 live documents**. At N=2: 250k. At N=50 on a fat tail: a handful of documents eat the fan-out budget. |
| Ops per editor per second (active typing) | ~5–15 keystrokes/s peak, far less average; plus cursor/awareness at 10–30 Hz if naively sent | Presence is often *more* messages than durable edits. Multiplexing them onto the durable channel is how Redis dies of gossip. |
| Fan-out per op | `subscribers_on_doc` (and, in the current design, *every* WebSocket node via Redis) | Cost is `ops/s × editors_on_doc`, not `ops/s × 500k`. The **hot document**, not the fleet total, is the stress case. |
| Hours-offline reconnect | hours of local ops, then a burst | Without a state vector, this is "download the world" or "replay an unbounded log." With Redis Pub/Sub: there is no replay. That is the reconnect incident. |

**The conclusion, which is not optional:** capacity math uses **sessions** for connection/presence fleet sizing and **editors-per-document** for merge/fan-out. Sizing a Redis cluster for 500k pub/sub channels, or a Postgres for 500k row-locks, without a measured `N` distribution is how you survive the average and die on the all-hands doc. If Phase 0 measures a p99 of 200 concurrent editors on a document, the system you just sized for N=8 is a toy. See [Architecture — Scaling](./02_architecture_document.md#scaling-strategy).

### Why the current stack is already the incident

The prompt names the symptoms: message sequence drift, state corruption, high Redis memory, reconnect-after-offline collapse. Those are not mysterious.

| Mechanism | What it actually does at this shape |
| --- | --- |
| Centralized WebSocket cluster | Every client is a TCP session to a region that may be 350 ms away. Local typing still waits on (or races) the server if the client is not local-first. |
| Redis Pub/Sub | **At-most-once. No backlog.** A blip or a process restart is a missed op. Hours offline has nothing to subscribe *from*. Memory grows with *channel fan-out and retained client buffers*, not with "how much text is in the doc." |
| Per-op (or per-keystroke) relational writes | Two editors on one paragraph serialize on a row. Sequence numbers assigned by a single writer become a global lock. Drift is what you get when you pretend the network was totally ordered and then it was not. |
| Full snapshot on reconnect | A 50 MB rich doc × thousands of reconnects after a PoP blip is a thundering herd against the DB. "Severe performance degradation" is the load spike, not a CRDT bug. |

This design replaces that shape. It does not "tune Redis." See [ADR-003](./04_architecture_decision_records.md#adr-003) and [ADR-004](./04_architecture_decision_records.md#adr-004).

## Core Value Propositions
1. **Your keystroke is visible before the network answers.** Local-first apply. The SLO the user actually feels is client-side apply latency, not cross-ocean RTT. See [ADR-002](./04_architecture_decision_records.md#adr-002).
2. **Conflict resolution is commutative, not sequenced.** Concurrent edits from NA/EU/APAC and from the laptop on a plane merge without a single global sequencer. That is the CRDT bet. It has a compaction bill. See [ADR-001](./04_architecture_decision_records.md#adr-001).
3. **Reconnect after hours is a delta, not a snapshot lottery.** A compact state vector names what the client already has; the server (or a peer/edge cache of the log) sends the missing ops or a snapshot *if* the delta is larger than the snapshot. Redis Pub/Sub cannot do this. See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **Intra-region propagation is the 50 ms problem; cross-region is a different number.** Edge relays batch and fan out inside a geography. Cross-region replication is async, CRDT-mergeable, and metered as lag, not stuffed into the same histogram as local peers. See [ADR-003](./04_architecture_decision_records.md#adr-003) and [ADR-005](./04_architecture_decision_records.md#adr-005).
5. **Presence is not document state.** Cursors and "is typing" ride a lossy, coalesced channel. They must not share the durable op log or they will starve it. See [ADR-006](./04_architecture_decision_records.md#adr-006).

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0**, not facts. The split between local / intra-region / cross-region is not negotiable as a *structure*, even if the numbers move.

1. **Local apply p99 < 16 ms** (one frame) from keydown to CRDT+DOM update, **offline or online**. If this is red, nothing else matters; the product feels like a remote terminal.
2. **Intra-region / edge-adjacent peer visibility p95 < 50 ms** for durable ops, measured as `apply_on_peer - apply_on_originator` for clients attached to the same regional edge (or same metro). This is the only 50 ms number this design will put in a contract.
3. **Cross-region convergence lag**: p50 / p95 / p99 of `apply_on_remote_region - apply_on_originator`. Expected floor ~100–300 ms depending on pair. **Alert if it exceeds a product number (working: p95 < 400 ms NA↔EU, p95 < 800 ms NA↔APAC)** — not 50 ms. A dashboard that mixes this with (2) is a lie.
4. **Hours-offline resync**: p95 time-to-interactive after reconnect for a client with ~4 hours of local ops against a document that also moved, at a stated doc size. Working target: **interactive < 2 s for p95 of documents under a size cap**; above that, snapshot path with a progress UI. "Eventually" is not this metric.
5. **State integrity**: zero silent divergence incidents (two clients at the same logical state vector rendering different trees) in production. A detected divergence is a SEV, not a "CRDT will converge later" shrug — if the same vector hashes differently, the engine is wrong.
6. **Document metadata health**: CRDT payload / visible-text ratio, tombstone bytes, time since last successful compaction. Unbounded growth is a cost and a reconnect-latency incident in slow motion.
7. **Hot-document survival**: a synthetic (or real) document with the Phase 0 p99 editor count remains inside the intra-region SLO and does not take down the edge shard. If the all-hands doc pages the fleet, the fan-out design failed.
8. **Operator toil**: compaction, re-homing, and a regional PoP loss are runbooks, not heroics. If every Redis-shaped incident is replaced by a CRDT-GC incident of the same frequency, we moved the fire.

## Business Rules
1. **The client applies every local edit before waiting on the network.** Server round-trip is not on the typing path. See [ADR-002](./04_architecture_decision_records.md#adr-002).
2. **Durable ops and presence are different channels**, with different durability, coalescing, and backpressure. See [ADR-006](./04_architecture_decision_records.md#adr-006).
3. **Reconnect uses a state vector (or equivalent summary); full snapshot is a fallback** when delta size exceeds a cap, not the default. See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **A document has a home region for durability; replicas in other regions are async and mergeable.** There is no global Redis. There is no cross-region synchronous lock. See [ADR-005](./04_architecture_decision_records.md#adr-005).
5. **OT as the production merge algorithm is rejected for this constraint set** (offline hours + multi-region + no central sequencer). CRDT (or a CRDT-backed hybrid) is the v1 merge. See [ADR-001](./04_architecture_decision_records.md#adr-001).
6. **Compaction/snapshot is a launch-gated job, not a follow-up.** An oplog that cannot be snapshotted is a time bomb. See [ADR-007](./04_architecture_decision_records.md#adr-007).
7. **A single global 50 ms p95 that includes cross-continent peers is not an accepted SLO.** A launch RFC that still contains that sentence has not passed Phase 0. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-global-p95-50-ms-is-the-wrong-slo) and the [phased plan](./06_phased_implementation_plan.md).
8. **"Just add more WebSocket servers" is not an accepted scaling RFC.** A scaling change must name the effect on hot-document fan-out, reconnect herd, cross-region lag, and compaction. See [Architecture — Scaling](./02_architecture_document.md#scaling-strategy).

## Pipeline Consumers
This is a collaboration engine. Its surface area is operational and product-facing:

1. **Editor application**: receives a local CRDT document, a sync session, and presence. It must never be the sequencer. It will blame "sync" for UI bugs in tables; the metrics have to make that argument decidable.
2. **End users**: feel local apply and same-room (same-region) peer lag. They do not feel your home-region assignment until re-homing or a bad PoP maps them across an ocean.
3. **Collaboration operators**: own edge fleets, home-region placement, compaction, divergence alerts, and the reconnect SLO. If this team needs a CRDT researcher to notice that tombstones ate a region, the monitoring design failed.
4. **Compliance / eDiscovery**: snapshots and (bounded) history are the audit artifact. An unbounded CRDT log is not a legal hold strategy; a named snapshot generation is.
