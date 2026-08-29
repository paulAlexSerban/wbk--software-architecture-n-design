# prj--llm-flaky-output-triage

Architecture and system design documentation for the interview scenario: a teammate insists the fix for flaky LLM outputs is "just add more few-shot examples." You have two minutes to disagree, then you have to say what you would actually do.

Documentation-only project: no prompt templates, judge scripts, decoding client, or eval runner lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "few-shot-as-universal-patch trap"), not a general prompt-engineering platform. Scope is one production LLM surface whose outputs are "flaky," plus the triage path that turns a complaint into a named failure class and a lever that can actually move it.

The defining fact is taxonomic, not stylistic. "Flaky" is not one failure mode. Few-shot examples only ever demonstrate an input→output *mapping*. They cannot supply missing facts, cannot repair a broken reasoning process, and cannot reduce sampling variance. Adding them anyway has a permanent per-call cost and a habit of rotting in the prompt. The architecture is therefore not a better prompt. It is **diagnosis before mitigation**: Capture → Classify → Route → Mitigate → Verify.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the 2-minute answer, the failure-mode taxonomy, and why "just add few-shot" is the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built — a triage pipeline, not a prompting trick — and the anti-pattern it exists to kill.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": the failure record, cheap-then-human classification, the mitigation playbook, and the regression gate that catches a few-shot patch on a retrieval bug.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for when few-shot is actually the right call, what this system cannot promise, and the permanent token cost of the wrong patch.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a labeled taxonomy, not a prompt rewrite.
