# prj--cross-system-report-pipeline

Architecture and system design documentation for a weekly (or daily) report that must join a nightly FTP CSV from System A with ~50,000 records from System B's rate-limited HTTP API — with no budget, no cooperation from either source team, and a first report due in a week.

Documentation-only project: no pipeline code, no FTP client, no report generator lives here. This is the design specification a build phase would implement against.

The defining constraint is arithmetic, not engineering taste. System B allows 100 requests per hour. A week has 168 hours. `100 × 168 = 16,800` requests. Fetching 50,000 records one-at-a-time is **mathematically impossible** in a week, and worse on a daily cadence. The system is therefore not "a job that pulls both sources and joins them." It is a **stateful local mirror of System B**, populated slowly, kept current via deltas, joined against System A's cheap nightly drop, and shipped with an honest completeness label.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the constraints and the math that makes a naive full-pull design fail before it starts.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is a warehouse-of-one rather than a stateless join job.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": rate limiting, watermarks, FTP ingest, join semantics, and failure modes.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the four answers this scenario actually asks for: what to build, what to give up, what to ask for expecting a no, and how the daily variant changes the answer.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated, one-week rollout.
