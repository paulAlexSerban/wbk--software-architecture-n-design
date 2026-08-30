# prj--rag-metrics

Architecture and system design documentation for wrapping RAG pipelines with **evaluation, tracing, and a CI quality gate** — RAGAS-style metrics (faithfulness, answer relevancy, context precision/recall), request tracing, a dashboard, and a GitHub Actions / pytest pipeline that runs a fixed eval set on every change and flags regressions.

Documentation-only project: no RAGAS runner, no GitHub Actions YAML, no pytest suite, no tracing SDK, and no dashboard lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "score-as-truth / one-backbone trap"), not a hosted eval SaaS and not a replacement for [prj--prompt-lab](../prj--prompt-lab/README.md). The prompt is an intentional overpromise: "wrap any of the above pipelines," "flag regressions," "one eval backbone across all projects." The trap is treating an LLM-judged RAGAS number as ground truth that can auto-block a merge, and treating CI evaluation and production tracing as the same system because they both say "quality." The documented answer **splits the problem**: deterministic hard gates that may block a merge; LLM-judged metrics as calibrated, statistically tested *signals*; production tracing as a cheaper, always-on pipeline that shares a schema with the eval harness — not a second copy of RAGAS on 100% of live traffic.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the two traps, the working pipeline used throughout, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is three layers sharing a schema, not one RAGAS wrapper with a dashboard.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": hard-gate checks, RAGAS metric contracts, paired regression testing, judge calibration, eval-set governance, and the live-trace path.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what a RAGAS score is allowed to mean, what a CI gate is allowed to block, what "one backbone" is allowed to share, and when this platform is overkill.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a labeled eval set and a judge-vs-human baseline, not a dashboard demo.

## Related

- Source scenario: [AI Engineering Portfolio Roadmap — §1.5 RAG Evaluation & Observability Platform](../../04_challenges/ai-engineering-portfolio-roadmap.md)
- Eval backbone this is supposed to plug into, not replace: [prj--prompt-lab](../prj--prompt-lab/)
- First consumer (the naive baseline this exists to measure): [prj--docqa-basic-naive-rag](../prj--docqa-basic-naive-rag/)
- Later consumers the "wrap any pipeline" claim is tested against: [prj--retrieval-x](../prj--retrieval-x/), [prj--rag-selfheal](../prj--rag-selfheal/), [prj--rag-pipeline-at-scale](../prj--rag-pipeline-at-scale/)
- Adjacent, narrower eval story (one support bot, not RAG): [prj--support-bot-eval-harness](../prj--support-bot-eval-harness/)
