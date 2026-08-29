# prj--iot-telemetry-anomaly-platform

Architecture and system design documentation for a multi-tenant real-time IoT telemetry and anomaly-processing platform: 2 million wind turbines and smart-grid sensors across 12 geographic clusters, ingesting 1.2 million events per second (~6 GB/sec), detecting operational anomalies within 2 seconds, triggering automated safety alerts, and retaining 7 years of aggregated history for regulatory audit.

Documentation-only project: no MQTT broker, stream processor, Cassandra schema, or dashboard code lives here. This is the design specification a build phase would implement against.

The defining failure is not "Cassandra is slow." The current path writes the raw firehose into Cassandra and then asks the same cluster to serve analytics scans. At this write rate that is a **CQRS violation dressed as a database choice**: compaction and analytics fight for the same disks, and read latency spikes over 3 seconds are the predictable result. The system is therefore not "a bigger Cassandra cluster with better compaction settings." It is a **decoupled ingest log, a regional stream-processing path for 2-second detection, an isolated safety-alert path, a narrowed Cassandra for latest-value lookups, an OLAP store for recent aggregates, and a cold object-storage tier of rollups — not raw — for seven years.**

A second load-bearing word in the requirement is **aggregated**. Seven years of *raw* 6 GB/sec is on the order of an exabyte. Seven years of *hourly* rollups is a different, payable problem. That word must be confirmed with legal before anyone sizes disks.

A third load-bearing constraint: a 2-second *cloud* detection SLA is fleet-level operator/SCADA notification. It is **not** the turbine's local hard-real-time safety interlock. That interlock must remain on-device (or on-farm) and must not depend on a WAN round trip to this platform. Pretending otherwise is how a Kafka outage becomes a safety incident in a slide deck.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Security and Multi-Tenancy](./_docs/04_security_and_multitenancy.md)
- [Architecture Decision Records](./_docs/05_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the numbers, the trap, the tenancy model (external SaaS customers), and the safety-authority assumption.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* the write path, the detect path, and the query path are three different systems.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": partitioning, windowing, quotas, rollups, and failure modes.
4. Read [Security and Multi-Tenancy](./_docs/04_security_and_multitenancy.md) before treating `tenant_id` as a filter you remember to add. Isolation is a first-class key, not a WHERE clause.
5. Read [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md) for what this costs, what is given up, and when a simpler design is the honest one.
6. [Architecture Decision Records](./_docs/05_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is compaction evidence and a legal letter about aggregates, not a Kafka cluster.
