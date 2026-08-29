# prj--agent-pipeline-cancellation

Architecture and system design documentation for streaming and cancellation across a 4-step agent chain (plan → tool call → tool call → synthesize) — including cleanup, partial billing, and what happens when a tool call already fired (sent an email) before the cancel arrived.

Documentation-only project: no orchestrator, streaming gateway, tool adapter, or billing-ledger implementation lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "cancel-is-not-rollback trap"), not a general multi-agent platform. Scope is one pipeline invocation from the user's request through four sequential steps, plus the cancel path that can intersect any of them.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is, the run/step ledger, and why a hard kill is the wrong cancel.
3. Read [System Design](./_docs/03_system_design.md) for the four cancellation-timing sequences, the idempotency-key contract, and the billing ledger.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what "Stop" actually costs and what it cannot undo.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is an inventory of side effects, not a streaming demo.
