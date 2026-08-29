# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone promises "p95 < 50 ms globally" or treats CRDTs as a drop-in Redis replacement.

The math, once: **light in fiber is ~200,000 km/s.** NY↔London is already ~55 ms+ RTT before your process runs. NY↔Singapore is ~150 ms+ RTT. **500,000 concurrent sessions are connections, not documents**; fan-out is `editors_on_this_doc`. Redis Pub/Sub cannot resume a client that was offline for hours. Designing "a bigger WebSocket cluster plus OT" is refusing to do that arithmetic.

## 1. What I would build

A **local-first CRDT engine with regional edge fan-out and a home-region log**, not a smarter central broker.

- **Client CRDT + local persist** so typing never waits on a WAN ACK. Replica ids stable per device/doc. Checksums at a state vector so "converged" is testable.
- **Regional edge relays**, document-sticky, coalescing 8–16 ms, fanning out in-region **before** the home region or any other continent hears about it. That is the only 50 ms number I would put in a contract.
- **State-vector resync** with snapshot+tail fallback. This is the actual fix for reconnect-after-offline and for PoP blips. Redis Pub/Sub is out of the durable path.
- **Home-region oplog + snapshots** (append-only, compactable). Postgres for metadata, not for keystrokes.
- **Async cross-region replication** of CRDT batches for documents that have editors in that region. Merge, don't lock.
- **Presence on a different channel**, shed first under load.
- **Compaction as a launch gate.** Tombstones are a product defect with a delay fuse.

If Phase 0 discovers the fleet is 500k sessions of mostly 1-editor documents and same-region teams, this looks slightly heavy on the multi-region replicator. Build the *seams* anyway (state vector, snapshots, local-first, separate presence). Shrink the PoP count. Do not shrink the design into "one Redis cluster in us-east-1" and spend the next incident re-adding everything the seams were for.

## 2. What I would give up

Be explicit. These are not "later" disguised as principles. Some are never in this design.

**True global p95 < 50 ms for peer visibility across continents.** I would give this up on day zero because it is false. Local-first makes *your* typing fast everywhere. *Their* typing in Tokyo appearing in New York in 50 ms is not a CRDT feature. See [§4](#4-why-global-p95-50-ms-is-the-wrong-slo).

**Strong consistency / locking on concurrent edits.** CRDT convergence is the model. Two users will interleave characters in the same word. Structural merges on tables can look wrong while being "correct." If the product needed Google-Sheets-class cell locking, that is a different engine or a lock service *on top*, with all the offline pain locks imply.

**Central OT.** I would give up the (real) cases where a single sequencer produces more "intentional" transforms. I will not put a global sequencer under 500k sessions and hours-offline.

**Unbounded history in the live document.** Compaction truncates. Time-travel is a snapshot vault, not the serving CRDT.

**Perfect offline merge of wildly divergent rich structure.** After four hours on a plane independently restructuring the same table, users will not get a magically sensible table. They will get a defined CRDT result and a support ticket. I would rather that than silent overwrite. Product may add explicit "your offline copy conflicts" UX for some types. I would not promise the algorithm removes the need for that UX.

**Pixel-perfect cross-region cursors.** Presence is lossy and, across oceans, stale. Fake smoothness is optional animation, not a sync SLO.

**P2P WebRTC as the v1 fabric.** NAT, enterprise proxies, audit, and 400-editor meshes. Edge overlay is boring and operable.

**Redis Pub/Sub as "temporary" op delivery.** Temporary becomes production. Kill it on the durable path.

**A single global 50 ms histogram as the launch metric.** A dashboard that averages Tokyo–NYC with same-PoP peers will stay green while the SLO as written is a lie.

**Cheap CRDT-library swap in production.** The schema, GC, and resync tests *are* the product. Swapping Yjs for Automerge is a migration, not a package bump.

## 3. Cost, in the units that actually hurt

**Engineering time dominates year one.**

- Correct resync, replica-id stability, checksum audits, table/list CRDT behavior, GC that does not resurrect text. Not the WebSocket library bake-off. A two-week "we picked Yjs vs Automerge" that skips Phase 0 editor-count measurement and the SLO split is how you buy the wrong size of the right algorithm.

**PoPs are real money, and still not the novel cost.**

- 500k connections × 3 regions × HA is a known fleet (memory per socket, terminate TLS). Budget it. It does not buy you cross-ocean 50 ms.

**Cross-region bandwidth is easy to underestimate.**

- CRDT ops are larger than visible text. Three regions full-meshing every keystroke of every live document is a tax. Replicate where there are editors. Do not replicate presence at 10 Hz across oceans.

**CRDT storage vs "the document size" finance was shown.**

- A 1 MB memo can be several MB of CRDT. Without compaction, last year's deletes are still in RAM on every client that opens it. Snapshot+GC is a cost-control feature.

**Reconnect herds are spiky egress.**

- Design for the PoP fail, not the mean. Snapshot caches at remaining edges. Jitter. Deltas for the recently-alive.

**Hot documents are a product limit as much as a scale-out problem.**

- At some N (measure; it might be 80, it might be 300), every op to everyone is a UX and a CPU problem even with a relay tree. Capping concurrent *editors* (viewers can be cheaper if they are presence-only / snapshot-followers) is a product decision I would force early rather than pretending the architecture is infinitely N-friendly.

## 4. Why global p95 50 ms is the wrong SLO

This is the bar the scenario sets for a serious design. The sentence in the prompt is the scaling RFC I would send back.

**Physics is not a backlog item.** One-way NY–Singapore floor ~75 ms. You cannot "edge compute" the op onto a satellite of the other user in 50 ms if the bit has to represent a keystroke that happened in New York. Edge compute helps **the people near that edge**. It does not teleport.

**Local-first already solved the SLO users actually quit over.** If my character appears in 4 ms, I stay. If my colleague in London appears in 90 ms, I still stay. If *my* character waits 90 ms on a server ACK, I leave. Combining those into one "end-to-end propagation" number is how products overfit a marketing target and then make typing wait on replication "to hit 50 ms globally" — which they still will not hit, and now typing is worse.

**A mixed histogram is a lie.** p95 of a population that is 80% same-region and 20% cross-ocean can look like 45 ms while every transoceanic pair is at 180 ms. The 20% are the users the prompt used to justify the number.

**More WebSocket servers do not change this.** They add sockets in a region. They do not shorten fiber. They can *worsen* hot-doc fan-out if they scatter subscribers. See [Architecture — Scaling](./02_architecture_document.md#scaling-strategy).

**OT vs CRDT does not change this.** Neither algorithm moves bits faster than the path. They change *who you wait for* and *how you merge when you did not wait*. This design refuses to wait.

What I would do instead, in order: split the SLO into **local apply**, **intra-region peer p95**, and **cross-region lag**; put 50 ms only on the second; instrument all three; put PoPs where the users are; home the doc near writers; replicate async; never ACK typing on the third. That list is [ADR-003](./04_architecture_decision_records.md#adr-003) and [ADR-005](./04_architecture_decision_records.md#adr-005). A launch RFC that still contains one global 50 ms p95 is incomplete and I would send it back.

## 5. What changes if the 50 ms target or the concurrency shape was different

The prompt is ambiguous in two places: what "globally" binds, and what 500k sessions imply for per-document N. The architecture is the same *shape*; the **cluster, the SLO, and the panic** are not. Name both in Phase 0 or every latency meeting is fiction.

| If the requirement is… | What I would actually do |
| --- | --- |
| **50 ms p95 intra-region / same-PoP peer visibility** (this design's default reading) | Full design as written. Edge relays, document-sticky fan-out, coalesce inside the budget. Cross-region lag is a second SLO. |
| **50 ms p95 including Tokyo-sees-NYC** | **Refuse the SLO.** Offer local-first + intra-region 50 ms + cross-region lag target consistent with the pair (e.g. 400–800 ms p95). If they insist, the honest system is science fiction or a single-city product. Adding CRDTs, OT, or Redis will not close the gap. |
| **50 ms p95 only for local apply** (misnamed "propagation") | Local-first is sufficient for that sentence; still build CRDT+resync because of the *other* symptoms (drift, offline, Redis). Do not build a global edge fabric *only* to hit 50 ms local apply — a laptop already can. |
| **500k sessions, mean N ≈ 1** | Same seams; tiny fan-out; edge is mostly a sync gateway; still need resync and snapshots for offline. Do not overbuild relay trees. |
| **500k sessions, p99 N ≈ 50–200** (this design's working worry) | Full fan-out design, hot-doc trees, load-test the p99 document, product cap conversation. |
| **A few docs with N in the thousands** (all-hands, classroom) | Per-op full-document fan-out will not stay inside 50 ms intra-region either. Viewers on snapshots / throttled follows; editors capped; presence-only for the crowd. That is a product split, not "more relays." |
| **Single region, no offline** | CRDT still wins vs Redis Pub/Sub for reconnect, but OT+central sequencer becomes *defensible*. I would still not use Redis Pub/Sub as the log. I would still snapshot. Multi-region ADRs shrink. |
| **Hard EU residency, no APAC local replica** | Offline in APAC may be illegal or must be a thin client. Local-first is then a per-tenant flag. The engine still CRDTs in permitted regions. Do not "accidentally" sync full docs to forbidden disks. |

If the business will not fund Phase 0 measurement of N, latency matrix, and an explicit SLO split, I would refuse to size the edge fleet or to sign the 50 ms sentence. Guessing N=8 to two significant figures is already a professional risk; buying PoPs on it without a histogram is malpractice. Signing a global 50 ms p95 knowing the fiber numbers is worse.

## 6. Brutal summary

The clever design is not a larger WebSocket cluster. The clever design is **treating collaboration as local-first replication**: a CRDT so partitions merge, an edge so same-region peers do not visit another continent, a log that can resume, a snapshot so history cannot grow forever, presence that cannot drown ops, and an SLO that does not argue with the speed of light.

Intra-region p95 < 50 ms is feasible **if** clients are near a PoP, relays are document-sticky, coalesce stays small, home/cross-region are off the peer path, and you did not lie about N. It is not feasible as a **global** end-to-end number, and it is not feasible if every keystroke still enters Redis Pub/Sub or a relational row lock.

If they wanted a demo of two cursors in one region, this document is too long. If they wanted 500,000 sessions on three continents without corrupting state after a flight, it is the minimum honesty.
