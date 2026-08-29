# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Durable Log Decouples Ingest from Storage

**Status**: Accepted

**Context**: The current path ACKs (or implicitly depends on) Cassandra writes for every telemetry event. At 1.2M events/s, Cassandra flush/compaction latency becomes ingest latency and then packet loss (or broker memory as a disguised queue). "Don't drop packets" and "the serving store must accept every write in-line" are incompatible when the serving store also answers analytics scans.

A durable partitioned log (Kafka/Pulsar-class) makes "accepted" mean "on the log," and lets Cassandra, OLAP, object storage, and detectors consume at their own speed.

**Decision**: Gateways produce to a **regional durable log** after auth/schema/quota. Device ACK is tied to **produce success**, not to Cassandra or OLAP. Cassandra is no longer on the ingest ACK path. See [Architecture](./02_architecture_document.md).

**Consequences**:
- (+) Ingest availability is a function of gateway + log, which can be sized for sequential write, not for random-read compaction.
- (+) Consumers can fail independently. A dashboard outage does not drop turbines.
- (+) Replay: processor bugs can recompute rollups from the replay window.
- (–) A new on-call surface: broker disks, partition count, consumer lag. This is real ops load, not a library.
- (–) At-least-once delivery to consumers. Downstream must be idempotent.
- (–) If the log hits disk watermark, ingest still sheds — you moved the cliff, you did not delete it. Size the cliff (disk, retention) and page before it.
- **Alternative rejected**: "Bigger Cassandra, TWCS, more nodes." Leaves analytics and ingest coupled. TWCS helps TTL'd time-series; it does not make 7-year scans cheap or stop compaction vs dashboard I/O.
- **Alternative rejected**: MQTT broker as the system of record. Broker disk is not a 7-day replay lake at 6 GB/s, and MQTT is a device protocol, not a consumer ecosystem for Flink/OLAP.
- **Revisit trigger**: none at this scale. If measured ingest is two orders of magnitude below the scenario, a simpler "write a time-series DB that is actually TS-native" might suffice — see [Trade-offs](./06_tradeoffs_and_honest_assessment.md).

## ADR-002: Regional-First Stream Processing over Global-First

**Status**: Accepted

**Context**: 12 geographic clusters, 2s detection SLA, ~6 GB/s. A single global pipeline (devices → central Kafka → central Flink) spends WAN RTT on every event, concentrates 1.2M/s and all keyed state in one blast radius, and goes dark for detection when the WAN dies.

**Decision**: Each geographic cluster is an **ingest + detect + alert** region with its own log and stream processors. Central (or a small number of "platform" regions) receives **rollups** (and optionally latest replicas) for tenant APIs and the cold tier. The 2s budget is **in-region** and must hold with the central region partitioned. [System Design](./03_system_design.md).

**Consequences**:
- (+) Detection survives WAN cut. That is the point of "12 clusters" as architecture, not as a sales map.
- (+) Checkpoint/recovery blast radius is one cluster's devices, not 2M.
- (–) 12× (or however many live regions) of log + processor operations. Runbooks, versions, and rule-config distribution become a fleet problem.
- (–) Cross-cluster "compare this farm to the global fleet in 2s" is **not** provided. That is OLAP/nearline.
- (–) If legal requires rollups to stay in-jurisdiction, "central OLAP" forks into federated regional OLAP. Phase 0 must answer this; the ADR still holds for **detect**.
- **Alternative rejected**: one global Kafka. Fails the partition case and the latency budget as a design, not as a tuning miss.
- **Alternative rejected**: detect in the central region but "edge buffer" in MQTT. The buffer is another queue without consumer isolation or replay tooling.
- **Revisit trigger**: all devices move to one metro and WAN is not a failure domain. Then one region is enough; do not keep 12 for ceremony.

## ADR-003: Narrow Cassandra to Point-Lookup; OLAP for Aggregates

**Status**: Accepted

**Context**: Cassandra is already in production. The failure mode is **analytics range scans** against a cluster absorbing the raw firehose. Cassandra's strength is upsert/point-get with a bounded row. The product still needs "what is this turbine doing **now**" (point) and "what did the farm do last week" (scan of **aggregates**).

A dedicated time-series or OLAP engine (ClickHouse / Pinot / Druid-class) is built for scans of columnar aggregates. Using Cassandra for both jobs is the trap.

**Decision**: After cutover, Cassandra (or a successor KV) stores **latest-value** (optional short last-N). **OLAP** stores rollups for interactive analytics. Raw history is not a Cassandra table. Product dashboards **must not** scan raw Cassandra. [Architecture — Data](./02_architecture_document.md#data-architecture).

**Consequences**:
- (+) Matches each store to an I/O pattern. Compaction of a one-row-per-device table is a different (still real) problem than compacting 7 years of 3s samples.
- (+) Keeps Cassandra ops knowledge instead of a flag-day deletion.
- (–) Two serving systems (+ object storage). Query API becomes a router. More failure modes ([System Design §8](./03_system_design.md#8-failure-modes)).
- (–) 1.2M latest upserts/s can still hurt Cassandra. Phase 3 must **prove** latest p99. If it fails, replace latest, do not reopen history tables "because Cassandra is already there."
- **Alternative rejected**: Cassandra-only with TWCS + TTL on raw and "analytics from Spark nightly." Detection in 2s cannot wait for nightly Spark; dashboards will still want ad-hoc scans; Spark-on-Cassandra at this volume is its own tax.
- **Alternative rejected**: dump raw into OLAP at 1.2M/s. Most OLAP engines prefer batched, larger rows. You would rebuild the firehose problem in a different logo. Feed **rollups**.
- **Alternative rejected**: delete Cassandra in Phase 1. Dashboards die; migration risk spikes. Re-scope, then shrink.
- **Revisit trigger**: latest-value SLO fails Phase 3 load test. New ADR for KV/Redis/regional split — not "put history back."

## ADR-004: Cold Tier Stores Aggregates Only; Raw Is a Short Replay Window

**Status**: Accepted

**Context**: The requirement says **7 years of aggregated** historical data. Raw at 6 GB/s is ~518 TB/day, ~1.3 EB over 7 years. That is not a "cost-effective cold tier." It is a second company.

"Aggregated" must still be **signed by legal/compliance**. If they meant raw, the design and the budget are different (sampled raw, event-triggered high-rate capture around incidents, or an honest "this is not payable").

**Decision**:
- Raw retained **days** (replay + incident debug) on log and batched object storage, then **deleted**.
- 7-year record = **hourly** (default) rollups in Parquet on object storage with lifecycle to archive storage class. Finer grains (1-min) are short-lived in OLAP unless legal requires otherwise.
- Audit queries run against the contracted grain. Reconstructing year-6 3-second traces is **out of scope**.

**Consequences**:
- (+) Cost class drops by ~10^3 vs raw (hourly vs 3s), more with daily downsample.
- (+) Audit SLO can be minutes (restore from archive), not dashboard-class.
- (–) You cannot answer "exact vibration waveform at 14:03:17 on a day in 2022" unless you change this ADR **before** the data ages out. After delete, it is gone.
- (–) A processor bug in rollup math may only be correctable inside the raw replay window. After that, the 7-year record is the (wrong) rollup. Rollup tests and dual-run matter.
- **Alternative rejected**: 7-year raw "just in case." Not cost-effective; contradicts the stated requirement; will be used as a dashboard source and recreate the trap.
- **Alternative rejected**: keep raw in Cassandra with TTL=7 years. This is the current failure, stretched in time.
- **Revisit trigger**: written legal requirement for raw or sub-minute grain for N years. Then: scoped capture (on anomaly, keep raw for 30 days; or sample 1-in-N devices), not silent full-fleet raw.

## ADR-005: Cloud Detection Is Fleet Notification, Not the Safety Interlock of Record

**Status**: Accepted

**Context**: "Trigger automated safety alerts within 2 seconds" is easy to sell as the protection system. Turbine overspeed, pitch runaway, and protection relays must trip in **milliseconds** on local controllers. WAN, Kafka, multi-tenant quotas, and processor restarts are not in that loop. If the platform is the sole trip, a regional ingest outage is a safety event the cloud team cannot accept.

**Decision**: This platform **detects and notifies** (operator, SCADA webhook, on-call). It does **not** command the turbine in v1. It does **not** replace on-device/farm interlocks. Phase 0 **inventories** local protection per tenant. Product copy and runbooks use "notification SLA," not "safety shutdown SLA." Residual: if a tenant has no local interlock, that is their plant's defect; we still do not become the interlock by accident.

**Consequences**:
- (+) Honest failure modes: platform down ⇒ missed **pages**, not "turbines cannot trip."
- (+) Alert path can still be isolated and treated as high-sev for **notification** quality.
- (–) Does not satisfy a buyer who wanted a SIL-rated cloud trip. Do not bid that. A command-and-control product is a different architecture (and a different liability).
- (–) Safety stakeholders may dislike the sentence. That is the point of writing it in Phase 0.
- **Alternative rejected**: "cloud emergency stop" over gRPC as v1. Dual-control, authz, and fail-closed vs fail-open vs stuck-open are a safety-engineering project.
- **Revisit trigger**: a regulated requirement that this SaaS is in the protection chain. Stop this ADR's "notification only" and staff a real safety case — or refuse the deal.

## ADR-006: Shared Multi-Tenant Infrastructure with Logical Isolation over Per-Tenant Dedicated Stacks

**Status**: Accepted

**Context**: Tenants are external customers. Isolation must be real. Dedicated Kafka+Flink+Cassandra+OLAP **per tenant** at 2M devices (even if split unevenly) multiplies ops and cost by tenant count and still leaves each small tenant over-provisioned.

**Decision**: **Shared** regional logs, processors, and serving stores. Isolation via device identity → tenant binding, keys/prefixes, query policy, quotas, and tests. Dedicated stacks are a **contracted enterprise tier** later, not the default. [Security](./04_security_and_multitenancy.md).

**Consequences**:
- (+) One capacity plane; cost shared; on-call is 12 regions, not 12 × N tenants.
- (+) Quotas become the fairness mechanism.
- (–) A platform bug (missing tenant predicate) is a **cross-customer** incident. Tests and key design are mandatory, not polite.
- (–) Tenants who require cryptographic isolation get **cold CMEK** as an add-on, not per-tenant Kafka in v1.
- **Alternative rejected**: namespace-per-tenant Kafka clusters as default. Death by a thousand clusters.
- **Alternative rejected**: "trust the dashboard to pass tenant_id."
- **Revisit trigger**: a tenant so large they are a region by themselves (e.g. 40% of a cluster's devices). Then **pin them to dedicated partitions or a dedicated regional cell** — still not a unique technology stack per small tenant.

## ADR-007: Alert Path Isolated from Bulk Telemetry

**Status**: Accepted

**Context**: A single topic/consumer group for "all events" means a 10-minute bulk lag is a 10-minute alert lag. The bulk path will lag (deployments, slow OLAP sink, raw shipper). Safety-adjacent **notification** cannot share that fate.

**Decision**: Stream processors emit anomalies to a **separate critical alert topic** (or dedicated broker quota/cluster if shared-topic quotas are insufficient). Dispatcher consumes only that path. Broker/producer quotas reserve capacity for alert produce even when bulk is back-pressured. [System Design §5](./03_system_design.md#5-backpressure-and-quotas).

**Consequences**:
- (+) Bulk consumer lag is not the alert SLO.
- (+) On-call can page on **alert lag** as a distinct signal.
- (–) Two produce paths from the processor. If the processor itself is down, **both** are down — isolation does not help a dead detector. That is honest: isolation protects against **downstream bulk sinks**, not against a dead Flink job. Mitigate detector with standby jobs / faster restart.
- (–) Misconfigured rules can still flood the **alert** topic. Suppression is mandatory.
- **Alternative rejected**: detect by querying Cassandra/OLAP on a timer. Reintroduces serving-store latency into the SLO.
- **Alternative rejected**: "priority headers on the same topic." Easy to get wrong under backlog; dedicated topic is cheaper than a clever consumer.
- **Revisit trigger**: alert volume approaches bulk volume (everything is "critical"). Then the rules are wrong; do not merge topics to make the chart look even.
