# prj--adtech-click-fraud-attribution

Architecture and system design documentation for an ad-tech platform that must evaluate clicks and impressions in real time — match every click to a 30-minute impression window, drop fraudulent traffic deterministically where that is actually possible, and still answer multi-touch attribution queries over petabytes of historical logs.

Documentation-only project: no Flink job, no Kafka topic, no fraud-model training loop lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "just add Flink" trap), not a general real-time analytics platform. The stated numbers are 350,000 clicks per second, 2.5 million impressions per second, a 30-minute attribution window, and a legacy Hadoop batch that takes 45 minutes. Those numbers are not decoration. They imply ~4.5 billion live impression keys in hot state at any instant. The expected answer — **stream processing, sliding-window joins, sub-second fraud drop** — is directionally correct and incomplete. The windowed join is a keyed TTL lookup, not an N×M join. "Deterministic" and "catches botnets" cannot both sit on the sub-second path. Multi-touch over petabytes is not a hot-path concern. Pretending otherwise is how you buy a stream processor and still leak money for another year.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the two numeric realities, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, and why the hot path is a keyed lookup plus a three-tier fraud pipeline, not a sliding-window join.
3. Read [System Design](./_docs/03_system_design.md) for the lookup mechanics, the fraud decision sequences, partitioning, and financial idempotency.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what "real-time fraud and attribution" actually costs, and what it will not buy.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is measure the Hadoop pipeline, not rewrite it. Dual-run against billing numbers is mandatory before any cutover that moves money.
