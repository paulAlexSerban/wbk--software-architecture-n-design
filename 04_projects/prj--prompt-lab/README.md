# prj--prompt-lab

Architecture and system design documentation for a prompt-and-eval harness that runs the **same task** through zero-shot, few-shot, chain-of-thought, structured-output, and system-prompt variants, against different models and providers — then logs every run and **gates a prompt change on eval scores**, the way CI gates a code change on tests.

Documentation-only project: no harness SDK, no provider adapters, no GitHub Actions YAML, and no judge prompts live here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "one-off notebook per project" trap), not a hosted eval SaaS. The defining constraint is not "call an LLM." Calling an LLM is the easy part. A **prompt version is a composite identity** (template × technique × exemplars × schema × model × decoding), the **provider abstraction will leak**, scoring is **heterogeneous** (exact-match is not the same statistic as an LLM judge, and RAGAS is not a scorer you can turn on without a retrieval pipeline), and "this becomes the eval backbone every later project plugs into" is a **premature-abstraction risk** that has to be constrained, not celebrated. A CI gate that re-runs the full combinatorial matrix on every PR will be skipped. A CI gate that only runs a smoke subset will be gamed. Both failures are in scope.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the trap, the composite-identity problem, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is — a narrow harness core plus adapters plus scorers plus a change-scoped CI gate — and why a one-off script per project is the failure.
3. Read [System Design](./_docs/03_system_design.md) for variant hashing, the adapter contract and where it leaks, the two statistical treatments, and the smoke-vs-full matrix.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) before arguing for a plugin marketplace, RAGAS in v1, or building this instead of buying promptfoo / LangSmith / Braintrust.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — exact-match logging before judge, two providers before "agnostic," smoke matrix before merge gate, and a kill criterion if nobody else ever plugs in.
