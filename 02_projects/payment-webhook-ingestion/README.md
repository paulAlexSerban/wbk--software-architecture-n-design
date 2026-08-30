# prj--payment-webhook-ingestion

Architecture and system design documentation for a payment-provider webhook ingestion endpoint that must tolerate retries, duplicate delivery, and out-of-order events — and recover when a downstream write fails after the provider has already been acknowledged.

Documentation-only project: no Express handler, worker, or schema implementation lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "webhook trap"), not a full payments platform. Scope is the ingestion path from HTTP request to durable, idempotent, ordered-enough application of a payment event.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Phased Implementation Plan](./_docs/05_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is, the status-code policy, and why the naive synchronous write fails.
3. Read [System Design](./_docs/03_system_design.md) for the data model, the four failure-mode sequences, and the post-ack recovery path.
4. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) capture the trade-offs that shape the design.
5. [Phased Implementation Plan](./_docs/05_phased_implementation_plan.md) is the gated rollout — Phase 1 is deliberately "ingest only, do not mutate business state."
