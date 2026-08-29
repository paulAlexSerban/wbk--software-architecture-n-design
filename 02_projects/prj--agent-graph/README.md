# prj--agent-graph

Architecture and system design documentation for a multi-agent orchestration platform: a supervisor coordinates specialized agents (planner, coder, reviewer, tester) over a message bus, with scoped tools, durable checkpoints, retries, a dead-letter queue, and a human-in-the-loop approval gate before merge.

Documentation-only project: no LangGraph graph, FastAPI agent service, message-bus consumer, or checkpoint store lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "retry-after-partial-failure duplicate-side-effect trap"), not a generic agent-platform product. Scope is one issue-to-PR graph: plan → code → review → test → human approval → merge, plus the failure/retry paths that can fire a side-effecting tool twice.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Security and Guardrails](./_docs/05_security_and_guardrails.md)
- [Observability and Evaluation Framework](./_docs/06_observability_and_evaluation_framework.md)
- [Trade-offs and Honest Assessment](./_docs/07_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/08_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is: ledger-then-act graph execution, isolated agent processes, and why the bus is not the system of record.
3. Read [System Design](./_docs/03_system_design.md) for the data model, node loop, idempotency keys, and the sequence diagrams that actually answer the scenario.
4. Read [Security and Guardrails](./_docs/05_security_and_guardrails.md) before anything operational — a reviewer agent's output is untrusted input to the coder, and merge is never an agent capability.
5. Read [Trade-offs and Honest Assessment](./_docs/07_tradeoffs_and_honest_assessment.md) for what this complexity buys and when it is overkill.
6. [Architecture Decision Records](./_docs/04_architecture_decision_records.md), [Observability and Evaluation](./_docs/06_observability_and_evaluation_framework.md), and [Phased Implementation Plan](./_docs/08_phased_implementation_plan.md) cover locked decisions, how you know it is working, and the gated rollout — Phase 0 is a vendor-idempotency inventory, not a multi-agent demo.
