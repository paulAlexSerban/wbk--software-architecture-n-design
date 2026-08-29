# prj--batch-enrichment-pipeline

Architecture and system design documentation for a batch job that reads 200,000 rows from a CSV, calls an external HTTP API once per row, and writes each result to Postgres — currently taking about six hours.

Documentation-only project: no pipeline code, HTTP client, or database writer lives here. This is the design specification a build phase would implement against.

The defining fact is arithmetic, not a preference for async or queues. 200,000 rows in six hours is **~108 ms per row, ~9.26 requests per second**. That is the signature of a fully serial, blocking HTTP call per row with almost nothing overlapped. The 10 requests-per-second hard limit then pins the theoretical floor at `200,000 ÷ 10 = 20,000` seconds ≈ **5 hours 33 minutes**. The current job is already running almost at that ceiling. The design is therefore not "make it 10× faster." It is: measure first, strip incidental waste, sustain the allowed rate without burning it on retries, and make a ~5.5-hour run safe to fail and resume.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the arithmetic that makes most "just add threads" answers dishonest.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and why one pipeline shape covers both the unconstrained case and the 10 req/s case.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": instrumentation, the token-bucket limiter, the fetch/write queue, batching, retries, and checkpoints.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the four answers this scenario actually asks for: where the time is going before you measure, what to change and in what order, how to confirm each change helped, and what the 10 req/s limit changes versus what stays the same.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout.
