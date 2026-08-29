# prj--support-bot-eval-harness

Architecture and system design documentation for an evaluation harness that must decide whether a customer-support bot prompt is safe to ship — and keep deciding, after ship, whether the model behind an unchanged API name is still the model that was evaluated.

Documentation-only project: no judge scripts, CI YAML, or dashboard implementation lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "vibes-and-ship trap"), not a general LLM evaluation platform. Scope is the eval pipeline around one support bot: golden-set curation, regression detection across model version upgrades, and catching silent quality drift after a provider swaps the underlying model under the same API name.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Phased Implementation Plan](./_docs/05_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is — two loops, a pre-ship gate and a production canary — and why a one-time playground comparison is the failure.
3. Read [System Design](./_docs/03_system_design.md) for the data model, golden-set curation, judge calibration, paired regression, and the silent-swap detection path.
4. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) capture the trade-offs that shape the design.
5. [Phased Implementation Plan](./_docs/05_phased_implementation_plan.md) is the gated rollout — Phase 1 is deliberately "offline gate only, no production monitoring," and Phase 3 is the first phase that can actually catch a same-name model swap.
