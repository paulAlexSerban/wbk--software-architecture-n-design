# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: CRDTs over Operational Transformation as the Production Merge

**Status**: Accepted

**Context**: The scenario names OT *or* CRDTs as if they were interchangeable "low-latency conflict resolution mechanisms." They are not. OT requires a **total order** (or a central transformer that serializes intent). That is a natural fit for a single-region, always-online, server-authoritative editor: the server is the sequencer; clients transform against it. Hours-offline clients, three continents, and a dead central cluster break that assumption. You then need either a **single global sequencer** (cross-region RTT on the critical path, or a leader in `us-east-1` that makes Tokyo typing a WAN sport) or **decentralized OT**, which is a research-and-regret area at this richness of document types. CRDTs (op-based or state-based with identified ops) commute: replicas apply in any order and converge given the same set. Offline is a long partition. Multi-region is a continuous partition with a lag SLO. The current system's sequence drift is OT-shaped thinking (sequence numbers, Redis order, relational write order) meeting a network that is not a single queue.

**Decision**: Production merge is a CRDT with identified ops and a state summary. OT is not the serving path. A server-side OT transformer is not a fallback "for formatting." Rich-text is modeled as CRDT-native types (or well-specified types on a CRDT sequence), not as a JSON blob in a last-write-wins register.

**Consequences**:
- (+) Offline hours and multi-region partitions merge without electing a global leader for every keystroke.
- (+) Reconnect does not need a gapless sequence number from Redis.
- (–) Document size grows with tombstones and metadata; compaction is mandatory ([ADR-007](#adr-007)).
- (–) Concurrent structural edits (tables, tree moves) have defined but sometimes ugly results. OT-on-a-single-server can *feel* more "intentional" for those cases because it serializes. We give that up. See [Trade-offs §2](./05_tradeoffs_and_honest_assessment.md#2-what-i-would-give-up).
- (–) Engineering cost is the protocol and the schema, not `npm install`.
- **Alternative rejected**: central OT. Cannot honor hours-offline + multi-region without lying about the sequencer's location.
- **Alternative rejected**: OT in-region, CRDT across regions. Two merge theories in one product is a divergence factory.
- **Revisit trigger**: a document type that is structurally OT-shaped *and* is never edited offline *and* is single-region by policy (e.g. a lock-step spreadsheet in one campus). Then a *separate* engine, not a flag on this one.

## ADR-002: Local-First Client Storage over Server-Authoritative-Only

**Status**: Accepted

**Context**: Server-authoritative editing makes the caret a function of RTT. At 10–350 ms last-mile, that is a remote terminal. The prompt's "rapid typing leads to sequence drift" is what you get when the client speculatively renders and the server later assigns a different order. Local-first: the local CRDT *is* the document; the network ships ops. Persistence on device is what makes "hours offline" a mode rather than a lost buffer in RAM.

**Decision**: Every local edit applies to the client CRDT and is persisted locally before (and without waiting for) network ACK. The server is a replica with a durability job, not the owner of the caret. See [System Design §1](./03_system_design.md#1-control-flow).

**Consequences**:
- (+) Typing SLO is decoupled from oceans and from home-region health.
- (+) Offline is real.
- (–) Device loss / stolen laptop is a data incident. Encryption and wipe policy are part of the architecture, not an app-store checkbox.
- (–) Residency: a full local replica may violate "data stays in region X." That becomes a product/legal constraint, not a surprise. See [System Design §11](./03_system_design.md#11-security-and-residency-narrow).
- (–) Merge on reconnect can surprise; UX must not pretend the server "had the truth" the whole time.
- **Alternative rejected**: server-authoritative with optimistic UI. That is the current drift machine.
- **Alternative rejected**: local apply but no local persist. A tab kill still loses hours.

## ADR-003: Edge-Relay Regional Fan-out over a Single Centralized Broker

**Status**: Accepted

**Context**: The current architecture is a centralized WebSocket cluster plus Redis Pub/Sub. Redis Pub/Sub is at-most-once, has no replay, and fans out through a broker that is rarely in *every* user's metro. Even a "global" Redis or Kafka does not put a 50 ms p95 on NY↔Singapore. The intra-region 50 ms SLO is achievable only if same-region peers meet at a nearby edge, not via a central cluster on another continent. More WebSocket processes in one region still lose if the pub/sub hop is remote or if subscribers for one document are randomly sprayed across workers.

**Decision**: Clients connect to a regional edge/PoP. Durable ops are coalesced and fanned out **in-region** on a document-sticky relay (or a small relay tree for hot docs). Home persistence and cross-region replication are off the originator's paint path and off the in-region peer path. Redis Pub/Sub is **not** the durable op fabric. See [System Design §3](./03_system_design.md#3-edge-relay-batching-and-fan-out) and [Architecture — Scaling](./02_architecture_document.md#scaling-strategy).

**Consequences**:
- (+) Intra-region p95 has a chance of being a software problem rather than a geography problem.
- (+) Broker-shaped single-memory blowups are not the op path.
- (–) You now operate PoPs. Multi-region is a bill.
- (–) Document-sticky routing is mandatory; naive load balancing makes hot docs a mesh.
- **Alternative rejected**: bigger central WebSocket + Redis. That is the incident in the prompt.
- **Alternative rejected**: true P2P (WebRTC mesh) as v1. NAT, mobile, audit, and N² meshes for 400-editor docs are a different product. Edge relay is the boring overlay.

## ADR-004: State-Vector Delta Resync over Full-Snapshot-on-Reconnect

**Status**: Accepted

**Context**: Redis Pub/Sub cannot resume. The naive replacement is "on connect, download the document." That works for a demo and becomes a stampede: large rich docs × thousands of reconnects after a PoP blip. Hours-offline clients also *produce* a large local delta that must merge, not be overwritten by a server snapshot. CRDT state vectors (or equivalent summaries) name the missing set.

**Decision**: Connect/reconnect presents `replica_id` + state vector (+ pending ops). Server returns missing ops, or snapshot+tail when the delta exceeds a cap or the log has been compacted past the vector. Snapshot is a fallback, not the default for a 2-second blip. Idempotent apply is mandatory. Mechanics: [System Design §4](./03_system_design.md#4-resync-protocol).

**Consequences**:
- (+) Short disconnects are cheap; hours-offline has a defined merge.
- (+) Compaction can truncate the log without stranding clients (they snapshot).
- (–) Protocol is easy to get wrong (new replica id per session; snapshot that clobbers local queue). Tests in [System Design §12](./03_system_design.md#12-testing-that-actually-matters) are not optional.
- (–) Huge deltas still snapshot; time-to-interactive is a separate SLO, not 50 ms.
- **Alternative rejected**: always full snapshot. Causes the "severe performance degradation on reconnect" in the prompt.
- **Alternative rejected**: replay from genesis forever. Unbounded log; unbounded time.

## ADR-005: Document-Home-Region Sharding with Async Cross-Region Replication over a Single Global Cluster

**Status**: Accepted

**Context**: A single global cluster (even "multi-AZ in one region") makes every other continent a WAN client. A synchronously replicated global database of ops puts the slowest region on the write path. CRDTs allow replica regions to apply without a distributed lock. Someone still has to **store** the log durably and serve resync: that is the home region. Other regions follow asynchronously for documents that have local editors (and for failover).

**Decision**: Each document has one home region for the authoritative oplog and snapshot generation. Replica regions apply CRDT batches asynchronously. No cross-region two-phase commit on keystrokes. Re-homing is an explicit migration. Active replication follows *editors in region*, not a full mesh of every live document into every PoP. See [System Design §5](./03_system_design.md#5-home-region-sharding-re-homing).

**Consequences**:
- (+) Typing and in-region fan-out do not wait on APAC if home is NA.
- (+) Residency can pin home to a region.
- (–) Cross-region visibility is eventual with a physics floor. The global 50 ms SLO is incompatible with this ADR — that is intentional. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-global-p95-50-ms-is-the-wrong-slo).
- (–) Failover and re-home are operational load. Dual-home split without merge is the foot-gun; the runbook must union logs.
- **Alternative rejected**: one global Redis/Kafka as "the document." Recreates the central bottleneck and still does not beat light.
- **Alternative rejected**: sync replicate every op to three continents before ACK. Makes p95 a function of the worst path; local-first would still work, but "durability" then costs hundreds of ms and still does not make Tokyo *see* the keystroke in 50 ms.

## ADR-006: Separate Presence/Awareness Channel over Multiplexing with Durable Ops

**Status**: Accepted

**Context**: Cursors and selections are high-frequency, loss-tolerant, and worthless after disconnect. Durable ops are low(er)-frequency, loss-intolerant, and persist forever (until compact). One channel means one backpressure policy. In practice presence wins the packet count and ops lose, or both get persisted and the log becomes a cursor graveyard. The current Redis memory profile is often this mix.

**Decision**: Presence is a separate, coalesced, in-memory, optionally unreliably-delivered channel. It is not written to the oplog. Under load, drop presence first. Cross-region presence is best-effort and low-fidelity in v1. See [System Design §8](./03_system_design.md#8-presence-and-awareness).

**Consequences**:
- (+) Durable path capacity is reserved for data.
- (+) Presence can be shed without a "lost characters" incident.
- (–) Two protocols to implement and auth.
- (–) Cross-region cursors may look stuck. That is honest; interpolating fake smoothness is optional UX, not a sync guarantee.
- **Alternative rejected**: one WebSocket message type with a `kind` field into the same Redis topic. That is multiplexing with extra steps.

## ADR-007: Periodic Snapshot and Compaction over Unbounded Oplog Growth

**Status**: Accepted

**Context**: CRDTs and op logs grow faster than visible text. Without snapshots, resync and storage track history, not the document. Without GC, deleted secrets and tombstones live in every client. The old relational "latest row" model hid this by destroying history (and also destroying replay). We need history *bounded*.

**Decision**: Snapshots at a state vector are first-class. The oplog truncates behind a replicated snapshot after a grace window. Compaction/GC is a launch gate, not a v2 optimization. Incorrect GC is a correctness bug; keep multiple snapshot generations. Legal hold is extra snapshot generations in a vault, not a freeze on live GC. Mechanics: [System Design §6](./03_system_design.md#6-compaction-and-tombstones).

**Consequences**:
- (+) Reconnect and storage stay bounded.
- (+) Slow clients past the horizon snapshot-resync instead of blocking GC forever.
- (–) Clients behind truncation cannot delta from ancient vectors.
- (–) GC bugs resurrect or lose content; this needs tests and checksums, which cost engineering time.
- **Alternative rejected**: keep every op forever as the serving log. Will not survive a year of enterprise docs.
- **Alternative rejected**: no snapshots, only CRDT state in a DB row overwritten in place. Destroys delta resync and makes audit a prayer.
