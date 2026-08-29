# prj--agentic-hitl-approval-gate

Architecture and system design documentation for an agentic workflow that researches a lead, drafts an outbound outreach email, and **pauses for a human approval gate** before the send is allowed to fire. The design covers guardrails, durable pause, content-hash-bound approval, authorization, expiry, and idempotent send.

Documentation-only project: no n8n workflow, custom orchestrator, guardrail checker, approval UI, or mail adapter lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "decorative-gate trap"), not a general workflow engine and not the larger multi-agent project. Scope is one outreach run from research through a single irreversible send, plus the approval path that must sit in front of that send. It is the deliberate complement to [`prj--agent-pipeline-cancellation`](../prj--agent-pipeline-cancellation/): that project is the trap already sprung mid-flight; this one is the gate *before* the trap.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is, the draft-version-then-gate shape, and why a confirm button is not a gate.
3. Read [System Design](./_docs/03_system_design.md) for the five sequences (happy path, redraft, expiry, double-approve, prompt injection), the content-hash contract, and the dispatch ledger.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what human-in-the-loop actually costs and what it cannot buy.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is an inventory of irreversible actions and who is allowed to approve, not an n8n demo.
