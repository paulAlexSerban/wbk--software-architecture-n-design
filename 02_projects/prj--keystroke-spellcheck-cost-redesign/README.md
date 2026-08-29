# prj--keystroke-spellcheck-cost-redesign

Architecture and system design documentation for a Fermi estimate and a redesign: an LLM-based spell-checker that fires on every keystroke in a text editor used by 10M DAU, and the architecture that makes that idea ~100x cheaper without materially hurting UX.

Documentation-only project: no inference server, no WASM dictionary, no cache client lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "LLM per keystroke trap"), not a Grammarly clone. The naive answer — put a language model behind every `keydown` — is arithmetically a tens-of-millions-of-dollars GPU bill. The replacement is not a cheaper model. It is **not calling the model**: debounce, client-side triage, a shared typo cache, and a batched LLM only for the residual. Those four words are the whole architecture. Everything else in this project is the honest cost of making them true under latency, privacy, cache poisoning, and "the suggestion arrived after the user already moved on."

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the worked Fermi estimate, and the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, and why a cheaper GPU is not the 100x lever.
3. Read [System Design](./_docs/03_system_design.md) for debounce, cache keys, batching, and the three request paths.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what "100x cheaper without hurting UX" actually costs.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is measure, not buy GPUs.
