# Multi-Tenant IoT Telemetry & Anomaly Processing: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A green energy management company operates a **multi-tenant SaaS platform** that monitors **2 million** connected wind turbines and smart-grid sensors across **12 geographic clusters**. Sensors emit timestamped diagnostic payloads containing **50 vector metrics every 3 seconds** over MQTT and gRPC. The resulting ingestion rate is **1.2 million events per second** (~**6 GB/sec** network throughput).

The current architecture feeds raw data directly into an **Apache Cassandra** cluster. High write amplification and heavy background compaction cause **analytics-query read latencies to spike over 3 seconds**.

The system must:

1. Ingest raw telemetry **without dropping packets**.
2. Evaluate stream-window analytics and detect operational anomalies **within 2 seconds of occurrence**.
3. Trigger **automated safety alerts**.
4. Retain **7 years of aggregated historical data** in a cost-effective cold tier for regulatory auditing.

The design must answer, concretely:

1. Why the current Cassandra-as-ingest-and-analytics design fails at this write rate, and why "tune compaction / add nodes" is not the architecture.
2. How ingest is made durable *before* any detection or serving work, so a slow analytics path cannot drop the firehose.
3. How a 2-second detection budget is met across 12 regions without a global pipeline that has already spent the budget on a WAN hop.
4. How safety alerts are isolated from bulk telemetry so a backlog of raw data cannot delay an alert.
5. How 7-year retention is made payable — and what "aggregated" is allowed to mean.
6. How independent wind-farm-operator tenants share infrastructure without reading each other's turbines, starving each other's ingest, or turning one noisy tenant into a fleet-wide outage.

This is the **firehose-into-the-serving-store trap**. The naive answer — more Cassandra nodes, a different compaction strategy, maybe TimeWindowCompactionStrategy and a TTL — is the failure. It treats a structural anti-pattern (one cluster owns the write firehose *and* the scan) as a knob-tuning problem. Compaction settings are real and they must be named, because they *are* what is failing today. They are not the architecture.

The correct shape is: **a durable log absorbs the firehose; regional stream processors detect anomalies on the event path; an isolated alert path pages operators; Cassandra is narrowed to latest-value point lookups; an OLAP store serves recent aggregates; object storage holds rollups for seven years.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under multi-tenancy, MQTT+gRPC, a 2-second SLA, and a regulator who may not agree that "aggregated" is enough.

## The Trap, Stated Directly

Cassandra is a fine **wide-column, write-optimized, point-lookup** store. It is a poor **analytics scan engine** when it is also ingesting 1.2M small time-series writes per second.

Every write:

1. lands in a memtable,
2. flushes to an SSTable,
3. is later compacted with other SSTables.

Compaction is not optional hygiene. It is how Cassandra reclaims space, applies TTLs, and keeps read paths from opening hundreds of SSTables. At this write rate, compaction is a **continuous background job competing for the same disks** that a dashboard query needs for a multi-hour scan. The 3-second read spike is compaction I/O, not a mysterious Cassandra bug.

Adding nodes spreads the pain. It does not remove the coupling. TWCS plus a short TTL on raw rows makes the *raw* table slightly less pathological and does **nothing** for the requirement to *query years of history* from the same cluster. A 7-year Cassandra table of raw 5 KB payloads is an exabyte-class object that no compaction strategy will make cheap to scan.

Three more traps hide behind the first:

**The packet-loss trap.** If ingest ACK depends on Cassandra commit, then compaction/GC/compaction-storm latency becomes packet loss (or broker buffer overflow, which is packet loss with extra steps). "Don't drop packets" and "write Cassandra first" cannot both be true at this rate unless Cassandra never stalls. Cassandra will stall.

**The 2-second-window trap.** A tumbling window that *closes* at 2 seconds has already spent the SLA waiting. Detection "within 2 seconds of occurrence" means the event that crossed the threshold must be classified before T+2s, not after a window that started at T finishes at T+2s and then waits for a shuffle. Per-event evaluation against running statistics (EWMA / z-score / threshold) is the real-time path. Windowed rollups are the analytics path. They are not the same job.

**The safety-interlock trap.** "Trigger automated safety alerts in 2 seconds from the cloud" is a useful operator/SCADA notification. It is **not** a replacement for the turbine controller's overspeed trip, vibration interlock, or pitch-runaway protection, which must fire in milliseconds on the device or the farm network. If this platform is sold as the safety system of record, a Kafka partition, a regional outage, or a tenant-quota misconfiguration becomes a safety event. It is not. [ADR-005](./05_architecture_decision_records.md#adr-005).

## The Numbers, Taken Literally

These figures are load-bearing. They are also internally slightly inconsistent, which is itself a finding.

| Claim | Arithmetic | Implication |
| --- | --- | --- |
| 2M devices × 1 event / 3s | ≈ **667k events/sec** | The stated **1.2M events/sec** is ~1.8× that. Extra sensors, dual-protocol duplicates, or a subset emitting faster. Phase 0 must measure the real mix. Design to **1.2M/s peak**, not the 667k back-of-envelope. |
| 1.2M events/s at 6 GB/s | ≈ **5 KB per event** | Plausible for 50 metrics + timestamp + device/tenant metadata + encoding overhead. Schema inflation (JSON with repeated keys, uncompressed) blows this up; binary/Protobuf and a schema registry are cost control, not taste. |
| 6 GB/s continuous | ≈ **518 TB/day** raw | **~189 PB/year**. **~1.3 EB over 7 years** of raw. This is not a Cassandra disk plan. It is a "do not store raw for 7 years" plan. |
| 12 geographic clusters | ~100k–200k devices each if even | A single global ingest region makes the 2s budget a bet on WAN latency and turns a regional fiber cut into a global detection outage. |

**Aggregates change the cost class:**

| Grain kept 7 years | Approx. reduction vs 3s raw | Order-of-magnitude 7-year volume |
| --- | --- | --- |
| Raw (3s) | 1× | ~1.3 EB |
| 1-minute rollup (min/max/avg/count per metric) | ~20× | still tens of PB |
| 1-hour rollup | ~1,200× | ~1 PB class |
| Hourly for 90 days, then daily | further | low-hundreds of TB — the actually cost-effective cold tier |

Phase 0 must get a **written** answer: which grain satisfies the regulator. Designing the cold tier as hourly rollups and discovering in year two that the auditor wants raw 3-second traces for every overspeed event is how the cost model collapses. See [ADR-004](./05_architecture_decision_records.md#adr-004).

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. MQTT brokers and a gRPC service accept device payloads.
2. A thin handler writes each event as a row into Cassandra, keyed somehow by device and time.
3. Dashboards and "analytics" queries scan Cassandra for ranges (last hour, last day, fleet comparison).
4. Some application job, or a CQL query, tries to detect anomalies by reading recent rows back out.

That version will appear to work in staging with a few thousand simulated devices, an empty cluster, and a dashboard that only asks for the last five minutes of one turbine. It will fail in production the first time compaction coincides with a fleet-wide dashboard refresh, the first time one tenant's historian query saturates the same disks another tenant's ingest is using, or the first time someone asks for "last week, all metrics, this farm."

This project documents the replacement, not a patch of those knobs.

## Tenancy Model (Assumption, Confirmed)

**Tenants are external SaaS customers**: independent wind-farm operators (and possibly grid operators) who share the platform. Each tenant owns a set of devices and geographic sites. Isolation is a **security and compliance boundary**, not only noisy-neighbor protection.

Consequences that shape the architecture:

- `tenant_id` is a first-class key on every record, topic, quota, and query. A missing tenant key is a bug, not a default.
- Per-tenant ingest quotas and circuit breakers exist so one customer's misconfigured firmware cannot take the cluster's ingest ACK path down for everyone.
- Query APIs are tenant-scoped. Cross-tenant queries do not exist as a product feature. Platform operators have a break-glass path that is audited.
- Dedicated per-tenant Kafka clusters and Cassandra rings at 2M devices would multiply operational cost by tenant count. Isolation is **logical on shared infrastructure**, with blast-radius drills, not a Kubernetes namespace sticker. See [ADR-006](./05_architecture_decision_records.md#adr-006) and [Security and Multi-Tenancy](./04_security_and_multitenancy.md).

## Safety Authority (Assumption, Explicit)

| Layer | Latency | Authority | This platform's role |
| --- | --- | --- | --- |
| On-device / farm PLC / turbine controller interlock | milliseconds | **Authoritative trip** (overspeed, overtemp, protection relay) | **Out of scope.** Must exist independently of this cloud. |
| On-farm SCADA / local historian | tens–hundreds of ms on LAN | Local operator action | May receive a copy of our alerts; not designed here. |
| This platform | **≤ 2 seconds** from event occurrence to alert dispatch *in the regional region* | **Fleet-level detection and notification** | Detect, dedup, notify, audit. Never the sole trip signal. |

If a tenant has no local interlock and is "relying on the cloud," that is a **commercial and safety-engineering defect** this architecture will not paper over. Phase 0 inventories what actually exists on the farms. [ADR-005](./05_architecture_decision_records.md#adr-005).

## Target Users

- **Owning engineer / platform architect**: needs a design that can be defended when someone asks why Cassandra is still in the picture at all.
- **On-call for ingest and detection**: needs to know, from lag and alert-path freshness, whether packets are landing and whether detection is inside 2s — without waiting for a dashboard that itself is the victim of compaction.
- **Safety / grid operations**: needs the honest sentence about what a cloud alert is and is not.
- **Security / tenant success**: needs isolation that survives a curious customer, a buggy firmware, and an auditor asking who accessed seven-year data.
- **Finance / capacity**: needs the raw-vs-aggregate cost table before signing a storage contract.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which chart library the dashboard uses, the exact list of 50 metrics) are out of scope except as they affect schema and rollup grain.

1. **Ingest must not drop packets under the stated peak** because a downstream store is slow. ACK of ingest is ACK of durable log append (or equivalent), not of Cassandra / OLAP / alert delivery.
2. **Detection must complete within 2 seconds of occurrence in the regional cluster** that received the event. The budget is wall-clock from sensor timestamp (with bounded clock-skew policy) to alert-path enqueue. It is not "best effort, p50."
3. **The safety-alert path must not share fate with the bulk telemetry backlog.** A 10-minute ingest backlog may delay rollups. It must not delay a critical alert already detected.
4. **Analytics reads must not share fate with the write firehose.** Compaction of the ingest store must not be the dashboard's tail latency.
5. **Seven-year retention is of aggregates, in a cold tier, at a grain legal has signed.** Raw is retained only for a short replay window (days, not years) sufficient to recompute rollups and investigate incidents.
6. **Tenant isolation is mandatory** on ingest identity, data at rest, query, quotas, and audit. A cross-tenant read is a severity-1 incident, not a missing `WHERE`.
7. **Geographic clusters are failure and latency domains.** Detection for cluster N must not require a healthy link to a central region. Central is for cross-cluster rollup, billing, and the query API's historical path — not for the 2s loop.
8. **Both MQTT and gRPC are first-class ingest protocols** for the existing device fleet. The platform normalizes to one internal event schema. It does not require a fleet-wide protocol migration as a launch gate.

## Success Criteria for the Design (Not Implementation Metrics)

1. A Cassandra compaction storm (or a total Cassandra outage) does **not** cause MQTT/gRPC ingest to refuse or drop within the log's retention and disk budget. Devices see ACK from the ingest path.
2. An injected threshold-crossing event is detected and enqueued on the isolated alert path in **< 2 seconds** at 1.2M events/s in a representative regional load test, with the central region partitioned off.
3. A bulk-telemetry consumer lag of minutes does **not** increase critical-alert dispatch latency.
4. A tenant-scoped dashboard query for last-24h aggregates at farm grain does not read the raw firehose table and does not show multi-second stalls correlated with ingest compaction.
5. A query issued with tenant A's credentials cannot return tenant B's device data, including via "forgot the tenant filter" bugs in the API (enforced below the handler).
6. A 7-year audit retrieval returns the contracted aggregate grain within the cold-tier SLO (minutes, not milliseconds — it is an audit, not a dashboard). Raw 3-second reconstruction of year 6 is **not** a success criterion unless legal changes [ADR-004](./05_architecture_decision_records.md#adr-004).
7. One tenant at 3× their quota is shed at the gateway; other tenants' ingest ACK and detection SLO remain inside spec.

## Business Rules (Platform-Scoped)

1. Ingest ACK is issued only after the event is on the durable log (or the device is rejected for auth/quota/schema — those are not "drops" of valid traffic; they are refusals).
2. Every event carries `tenant_id`, `device_id`, `event_time`, `ingest_time`, `schema_version`. Events without tenant identity are discarded and metered as a security event.
3. Anomaly detection in the real-time path is **deterministic threshold / statistical** (see [System Design](./03_system_design.md)). A heavy ML model is not on the 2s path in v1.
4. Alert dispatch is **at-least-once** with idempotent alert IDs. Duplicate pages are a lesser failure than a dropped safety notification. Dedup windows exist so a stuck-high sensor does not page every 3 seconds forever.
5. Raw events have a **short TTL** in hot storage / object staging. Rollups are the long-term record.
6. The query API never scans raw Cassandra for dashboards. If a debug tool does, it is break-glass, sampled, and not the product.
7. This platform does not command the turbine (no "cloud emergency stop" as a v1 feature). Notification only. Command-and-control is a different safety case.

## Non-Goals

- **Not the on-device safety interlock or farm SCADA.** See safety authority above.
- **Not a general-purpose IoT platform** for arbitrary device types, firmware OTA, or billing of electricity markets. The payload shape is a 50-metric diagnostic vector from this fleet.
- **Not exactly-once end-to-end.** At-least-once ingest + idempotent downstream is the contract. Exactly-once across MQTT, Kafka, and three stores is a research paper at this rate.
- **Not global total ordering** of all 1.2M events. Order is per `(tenant_id, device_id)` partition.
- **Not a 7-year raw data lake** unless legal forces a new ADR. The cost is the reason the requirement said "aggregated."
- **Not a single global Kafka cluster** as the 2s path.
- **Not per-tenant dedicated physical stacks** as the default isolation model.
- **Not an implementation.** No Java Flink jobs, no CQL, no Terraform. Numbered steps and diagrams only.
- **Not a claim this is a small project.** Replacing "write Cassandra, query Cassandra" with this design is a **multi-quarter platform program** with a real on-call load. See [Trade-offs](./06_tradeoffs_and_honest_assessment.md).
