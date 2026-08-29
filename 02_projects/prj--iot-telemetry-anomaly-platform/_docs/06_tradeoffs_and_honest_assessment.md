# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone stands up twelve Kafka clusters.

The expected answer is some mix of "Kafka, Flink, and don't use Cassandra for analytics." Those words are **correct**. They are not a weekend. Writing 1.2M events/s into Cassandra and scanning it is the anti-pattern; listing compaction settings is **diagnosis**, not design. This page is the cost of the design.

## 1. What I would build

A **geo-distributed, log-centric CQRS** pipeline for this fleet, not a bigger Cassandra ring.

- **Regional MQTT + gRPC gateways**: mTLS (or honest legacy), registry-bound `tenant_id`, schema registry, per-tenant and per-device quotas. ACK after log produce.
- **Regional durable log** (Kafka/Pulsar-class): partition `(tenant_id, device_id)`; bulk topic ≠ alert topic.
- **Regional stream processors**: per-event threshold + EWMA/z-score; 1-min rollups; latest upsert. No ML on this path.
- **Alert dispatcher**: rising-edge `alert_id`, suppression, at-least-once webhooks to SCADA/on-call, audit trail.
- **Cassandra narrowed** to latest-value point lookups (prove 1.2M upserts/s or replace).
- **OLAP** on rollups for dashboards.
- **Object storage**: batched raw for **days**; Parquet **hourly** (default) for **7 years**, lifecycle to archive.
- **Query API** that injects tenant scope and never offers raw Cassandra scans as a product.

I would not "tune compaction" as the fix. I would **read compaction and iostat in Phase 0** so I know what is failing *today*, then stop treating Cassandra as a lake.

If Phase 0 shows the real fleet is 20k devices and 5k events/s, this whole system is **overkill**. Buy or run a single-region time-series stack (Yes, that might even be Cassandra with TWCS *or* a TSDB) and a simple rules engine. The architecture in these docs is for the **stated** 2M / 1.2M/s / 2s / 12-cluster / multi-tenant-SaaS problem. Be honest about which incident you are in.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**The simplicity of one database.** Today's mental model is "it's in Cassandra." After this, "where is the data" has four honest answers (log, latest, OLAP, cold) and a fifth (gone, if it was raw older than the replay window). On-call must learn all of them. Teams that budget only "add Kafka" will ship a second firehose into the same Cassandra and double the bill.

**Global strict ordering and end-to-end exactly-once.** You get per-device order and at-least-once with idempotent alerts/rollups. Duplicate pages and duplicate rollup retries will happen. Exactly-once across MQTT, the log, and three stores at 1.2M/s is not a feature you are behind on; it is a thing you do not have.

**Seven years of raw 3-second traces.** [ADR-004](./05_architecture_decision_records.md#adr-004). After the replay window, the past is the rollup. If someone needs a waveform from year 4, they cannot have it. If legal disagrees, stop and change the ADR **before** lifecycle deletes.

**2-second farm-relative or fleet-relative ML.** Per-device rules in-region. Cross-device shuffle is nearline. An autoencoder on the hot path is a different capacity plan.

**Cloud as the safety interlock.** [ADR-005](./05_architecture_decision_records.md#adr-005). A Kafka outage misses **notifications**. Local protection must still trip. Product cannot say "we shut the turbine in 2 seconds from the cloud."

**Per-tenant dedicated Kafka/Cassandra rings.** Logical isolation on shared cells. [ADR-006](./05_architecture_decision_records.md#adr-006). A tenant who needs a dedicated cell pays for a cell, not a unique technology.

**Interactive queries over raw.** Dashboards run on aggregates. A debug tool on raw is break-glass, sampled, and not the customer UI.

**MQTT broker ACK as "durably stored in the platform."** If you PUBACK before produce, you lied. Some device firmware will still behave badly on delayed PUBACK. You will spend time on firmware, not only on brokers.

**A single global control plane for the 2s loop.** 12 regions of processors is 12 deployments, 12 lag graphs, 12 ways to be version-skewed. That is the price of the SLA and the WAN partition.

**Cheapness relative to today's cluster.** If today's Cassandra is already a money pit, cutover can **reduce** storage cost by deleting raw history from it. The **engineering** cost is still quarters. If today's cluster is small because the 2M devices are a roadmap lie, do not pre-pay twelve regions.

**Perfect zero packet loss in all failure modes.** You do not drop in-quota valid events because OLAP is slow. You **do** shed at quota, at auth failure, at schema failure, and at log disk watermark. "Without dropping packets" is a requirement about the **analytics path not being allowed to shed ingest**, not a promise that disks are infinite.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with Cassandra evidence. Silence must not block the diagnosis of compaction, but it **does** block building the 7-year tier and the tenancy model.

Ask legal / compliance:

1. **Does 7-year hourly aggregate (or specify grain) satisfy the audit duty?** Expected: delay, then "we need raw for incidents." Counter: incident raw for 30 days + hourly for 7 years. Get a signature. If they require full raw 7 years, the cost model in [Architecture](./02_architecture_document.md#cost-analysis) applies and this ADR-004 design is **not** what you should build.
2. **Data residency:** may rollups leave the geographic cluster? May alert metadata? Expected: a spreadsheet that does not match the 12 clusters. Federated OLAP is the expensive fork.

Ask safety / plant engineering:

3. **Inventory of on-farm interlocks per tenant.** Expected: uneven. Some farms will have been "waiting for the cloud." Write down that we still will not be their SIL loop. Expected friction: sales already promised it.

Ask product / tenant success:

4. **Per-tenant SLA tiers and device counts that are real.** Design to 1.2M/s **peak measured**, not brochure. Quotas need contracted numbers.
5. **Is 2s detection on per-device engineering limits enough**, or do they need farm-median comparison in 2s? Expected: "yes farm." Push to nearline unless they fund the shuffle.

Ask ops / platform:

6. **Who owns 12 regional log clusters at 3 a.m.?** If the answer is "the app team," the app team is now a platform team. Headcount is part of the design.
7. **Can we stop Cassandra raw writes by cluster**, or is there a secret Spark job we will discover at cutover? Phase 0 consumer inventory.

What I would **not** ask for: a new programming language, Kubernetes-for-its-own-sake, a multi-cloud abstraction, "blockchain for telemetry," or an LLM on the ingest path. Those spend calendar time that belongs to the log, the processor, and the migration.

## 4. Complexity inventory (what those words cost)

| You take on | You shed |
| --- | --- |
| Log ops, partition math, lag SLOs | Ingest ACK waiting on Cassandra |
| 12 regional processor fleets, checkpoints | Detection via dashboard scans |
| Isolated alert topic + dispatcher + suppression | Alerts stuck behind bulk backlog |
| OLAP + query router | Analytics vs compaction on one disk pool |
| Rollup math correctness + tests | 7-year raw disk (if legal agrees) |
| Tenant keys, quotas, cross-tenant tests | Pretending a WHERE clause is isolation |
| Schema registry + two protocols | JSON-anything firehose |
| Honest "notification not interlock" story | A safety claim the WAN cannot keep |
| Migration dual-run | A flag-day cutover hope |

Net: **many more parts, in the right places.** The old design was simple *and wrong at the stated size.* The new design is the standard industrial IoT shape, and the standard one is still a **multi-quarter program** with a standing on-call, not an afternoon of `compaction.rs` and a larger i3 instance.

### What is not worth building

- ML on the 2s path to look modern.
- Per-event PUT to object storage (518 TB/day of PUT requests).
- Exactly-once to PagerDuty.
- Per-tenant Kafka as default.
- Cloud emergency stop in v1.
- A custom MQTT-to-disk format "optimized for turbines" instead of a boring log + Parquet.
- Replacing Cassandra **and** introducing OLAP **and** rewriting the device protocol in the same phase.

## 5. When I would not do this

- **Measured** ingest is orders of magnitude below 1.2M/s, one region, one tenant (or internal-only). Then: a TSDB or Cassandra+TWCS **for raw with short TTL**, a small rules worker, object storage for daily rollups. Do not build 12 Flink jobs as a portfolio piece.
- The 3s-read-spike is **only** a missing `LIMIT` / allow-filtering / table-scan from a BI tool. Then: stop the query, add a rollup **table**, do not rebuild ingest. Phase 0 exists to catch this.
- Legal requires 7-year **raw** for the whole fleet **and** nobody will pay ~EB economics. Then the honest output is a **scope fight**, not an architecture that pretends Parquet hourly is raw. Do not "start Kafka anyway" to look busy.
- There is no local interlock **and** the buyer demands the cloud be SIL-rated protection. This design is the wrong product. Walk away or staff a safety-engineering program.

When I **would** do this: the numbers are roughly real (hundreds of thousands of devices, 100k+ events/s, multi-tenant, 2s notification, compaction vs analytics already hurting), or they will be real before the current cluster dies. Then the split paths are the design, and this document is the bill.

## 6. Brutal summary

The clever design is not a larger Cassandra cluster. The clever design is **refusing to use one I/O path for ingest durability, 2-second detection, interactive analytics, and a 7-year archive**, checking compaction evidence first so you know which layer is actually on fire, and paying for regional logs, keyed stream processors, an isolated alert queue, a narrowed latest store, an OLAP of rollups, and a legal letter that says **aggregated** is allowed to mean hourly.

"Kafka + Flink + don't scan Cassandra" are the right words. The fourth through four-hundredth words are quotas, mTLS at 2M devices, checkpoint recovery, alert suppression, Parquet lifecycle, tenant predicates below the API, and the sentence **the cloud does not trip the turbine**.

If the fleet is small, do not build this. If the fleet is this large, do not pretend `nodetool compact` is a strategy. Either way, Phase 0 is **iostat and a legal signature** — before anyone opens a Jira titled "stand up Kafka."
