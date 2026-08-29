# prj--social-feed-fanout-redesign

Architecture and system design documentation for a social-feed timeline engine that fails under celebrity write-amplification — and for the redesign that stops treating 20 million follower writes as a cache problem.

Documentation-only project: no Redis schema, no fanout worker, no CDN config lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "fan-out trap"), not a full social platform. The current path is hybrid push/pull on MySQL and Memcached. That path is a known anti-pattern once the follow graph is this skewed. The replacement is three words — **hybrid push/pull** — and a pile of honest cost that those three words usually leave out: a celebrity threshold that will be wrong, two write paths that must stay consistent, approximate counters, and a multi-quarter migration off Memcached.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the write-amplification arithmetic, what to check first, and the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, and why celebrity posts leave the per-follower write path.
3. Read [System Design](./_docs/03_system_design.md) for the tiering algorithm, the merge-at-read path, fanout workers, and decoupled counters.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what those three words actually cost.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is measure, not rewrite.
