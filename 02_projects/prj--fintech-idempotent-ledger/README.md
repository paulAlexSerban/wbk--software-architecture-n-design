# prj--fintech-idempotent-ledger

Architecture and system design documentation for PayGlobe, a cross-border remittance gateway whose current client-side retry path has produced duplicate payouts totaling millions in losses — and for the ledger and settlement pipeline that must replace it.

Documentation-only project: no ledger implementation, no provider adapter, no SQL schema lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "exactly-once / ACID / 100ms trap"). The prompt asks for an immutable double-entry ledger, strict ACID across distributed datacenters, exactly-once execution, dynamic failover across 35 volatile banking networks, and a sub-100 millisecond end-to-end SLA — all at 20,000 TPS peak. Several of those requirements cannot be true at the same time. The design names which ones are scoped, which ones are rewritten into honest forms, and which ones are refused.

The one-sentence architecture: **a client-supplied idempotency key reserves a single payout intent in a regional ACID ledger before any bank is called; outbound execution is at-least-once, made effectively-once by never blindly retrying an unknown outcome; cross-border settlement is a saga, not a distributed transaction; sub-100ms is the accept-into-ledger SLA, not the bank-confirmed SLA.**

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, the rewritten SLAs, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is, the latency budget, and why a global ACID ledger at 100ms is a fiction.
3. Read [System Design](./_docs/03_system_design.md) for the data model, the intent lifecycle, and the sequences that matter: duplicate submit, timeout-with-unknown-outcome, failover, reconciliation.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what is actually achievable, what is given up, and what to ask finance and banking-ops before building.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 1 is a single-region ledger that does not call a bank.
