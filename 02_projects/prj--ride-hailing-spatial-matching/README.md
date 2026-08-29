# prj--ride-hailing-spatial-matching

Architecture and system design documentation for an urban mobility platform that must match riders to nearby drivers and price that match with localized surge — at 900,000 drivers pinging every 3 seconds, across 60 metros, on a Redis Geospatial setup that already melts during rainstorms.

Documentation-only project: no matching service, no Kafka topic, no Redis key schema implementation lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "Redis GEO trap"), not a full ride-hailing platform. The current path is driver ping → `GEOADD` on one sorted set → `GEORADIUS` at match time, shared across every city. That path is a known anti-pattern at this write rate. The replacement is four words — **H3 cells, city-sharded** — and a pile of honest cost those four words usually leave out: an ingestion log, a restructured location store, atomic reservation, a streaming surge pipeline, and a deploy topology whose isolation unit is a metro, not a Redis box.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the scale arithmetic, the layer-by-layer fault tree on Redis GEO, what to check first, and the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, and why city-as-isolation-unit plus H3 cell membership replace a single geospatial key.
3. Read [System Design](./_docs/03_system_design.md) for the ping path, the match/reserve path, the surge aggregation window, and the staleness/reservation mechanics.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what those four words actually cost, and when city-sharding Redis alone is the stopgap instead of this rebuild.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is diagnose, not "stand up Kafka."
