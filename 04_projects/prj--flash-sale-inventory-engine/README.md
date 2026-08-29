# prj--flash-sale-inventory-engine

Architecture and system design documentation for a flash-sale checkout path that oversells and 504s when traffic fans in onto a handful of SKU rows — and for the redesign that makes zero oversell a mechanical invariant without pretending CAP does not apply.

Documentation-only project: no DynamoDB table, no waiting-room config, no checkout handler lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "hot-key trap"), not a general e-commerce platform. The current path is unshaped stampede → monolith → `SELECT … FOR UPDATE` on a Postgres inventory row, often with payment still inside the transaction. That path is a known anti-pattern for limited drops. The replacement is not "shard the cluster." It is **edge admission, a cache that cannot sell, cell-sharded conditional decrements, TTL reservations, a payment saga on tokens, cart AP / inventory CP** — and a pile of honest cost that the microservices slide usually leaves out.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap (hot-row contention ≠ shard-more), the fault tree, what to check first, and the ASRs.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, the latency budget, and why Postgres leaves the decrement path.
3. Read [System Design](./_docs/03_system_design.md) for cell geometry, reservation/reaper rules, and the four sequences (happy path, false sold-out, payment compensation, fail-closed failover).
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what the slide actually costs, including the CAP pick in money terms.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is diagnose, not provision; Phase 1 is admission, not cells.

Payment confirmation reuses the inbox shape in [prj--payment-webhook-ingestion](../prj--payment-webhook-ingestion/README.md); it is cited, not redesigned.
