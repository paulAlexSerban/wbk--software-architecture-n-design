# prj--llm-schema-drift-forensics

Architecture and system design documentation for finding **what JSON keys an LLM API silently changed, and when**, a week after the fact — using only the request/response data that already exists — and for making the next occurrence a same-day detection instead of another forensic exercise.

Documentation-only project: no log parser, no bisection script, no schema monitor lives here. This is the design specification a build phase would implement against.

The defining constraint is epistemic, not engineering taste. You cannot collect last week's evidence this week. There is no vendor changelog, no deploy event in *your* logs, and no clean answer if the bodies were never kept. "Diff the payloads" is the wrong unit: values change on every call. The right unit is a **schema fingerprint** (key paths + types, not values) plotted over time. Binary search through a replay log is the right algorithm **only if** the change is a monotonic step function; a staged/canary/per-region vendor rollout falsifies that assumption, and the honest fallback is a time-bucketed histogram, not a tighter binary search. This project tests investigative reasoning under incomplete information. The architecture's job is to **name the tightest bound the existing evidence can support**, and to refuse to invent a timestamp the evidence cannot carry.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for why "ask the vendor" and "add logging now" do not answer the question that was asked, and why precision is capped by evidence that already existed before anyone knew to look.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is two subsystems: a one-shot forensic toolkit for this incident, and a permanent schema-contract monitor for the next one.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": fingerprinting, the monotonicity check that licenses (or kills) bisection, structural diff, degraded-evidence paths, and the monitor's probe cadence.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what is knowable exactly, what is only boundable, and what is unrecoverable.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — including the kill criterion that Phase 2 must settle for a window instead of a date.
