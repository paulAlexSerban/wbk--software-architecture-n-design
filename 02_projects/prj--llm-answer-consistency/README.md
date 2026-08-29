# prj--llm-answer-consistency

Architecture and system design documentation for getting **consistent answers from a non-deterministic LLM without setting temperature to 0 and without caching**. Answers must still reflect live data. Product still wants some creativity.

Documentation-only project: no sampler, no schema validator, no ensemble runner, no dashboard lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "consistency-under-contradiction trap"), not a general LLM platform. The prompt is an intentional contradiction. The trap is capitulating to one side — quietly setting temperature near zero, or quietly caching the answer. The documented answer **redefines "consistent"**: split decision from expression, vote on a schema-constrained decision layer at T>0 against a once-per-request live-data snapshot, then let the prose vary.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the contradiction, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is a self-consistency ensemble over structured decisions, not temperature=0 and not a cache.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": snapshot-once, schema, N-way sampling, per-field aggregation, the validator, and the failed-quorum path.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what "consistent" is allowed to mean, what N× cost buys, and what this system will never be able to claim.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a schema and a baseline disagreement measurement, not an ensemble demo.
