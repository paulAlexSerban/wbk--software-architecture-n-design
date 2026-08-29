# prj--context-forge

Architecture and system design documentation for a library that assembles the final context window from heterogeneous parts — system prompt, retrieved chunks, chat history, tool schemas, few-shot examples — under a **hard token budget**, with pluggable reduction strategies (truncate, summarize, prioritize-by-relevance).

Documentation-only project: no assembler, no tokenizer wrapper, no summarizer client lives here. This is the design specification a build phase would implement against.

This is a scenario showcase of **context engineering**: deciding *what* goes into the window, not how to phrase a prompt. The trap is treating assembly as string trimming (`concat` then `text[:N]`, tokens estimated as `chars/4`). The documented answer frames the budget as a **resource-allocation problem** — pinned vs evictable tenants, a bounded shrink-until-fits loop, an ordering policy independent of eviction, and measurement of what each strategy actually does to cost and answer quality. Fitting is not the same as helping.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the trap, the running `agent.answer_with_tools` route, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is a priority-tiered iterative allocator, not a trimming utility.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": token counting, tiers, the shrink loop, strategy contracts, ordering, and the impossible-budget failure.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what this library can honestly claim, what summarization actually costs, and when you should not build it.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is an inventory of real part sizes and a signed pinned/evictable policy, not a summarizer demo.
