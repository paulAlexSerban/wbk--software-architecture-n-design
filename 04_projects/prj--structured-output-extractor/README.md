# prj--structured-output-extractor

Architecture and system design documentation for the interview scenario: take unstructured text (resumes, invoices, support tickets) and extract structured JSON reliably — then someone says the design is "just ask for JSON and retry until it parses." You have to say what the validation/retry contract actually is, and what retry cannot save.

Documentation-only project: no extractor client, no Pydantic/Zod schemas, no retry loop, and no review-queue service lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "retry-until-it-parses trap"), not a general document-AI platform. Scope is three document types with frozen schemas, a layered validator, a bounded repair-retry, and an explicit terminal fallback. OCR, layout models, and fine-tuning are out.

The defining fact is contractual, not prompt-quality. Schema-valid JSON is not a correct extraction. Retry can repair **shape** (malformed JSON, missing keys, wrong types). It cannot repair **content** (a well-formed invoice whose total was invented). Treating those as one problem produces a loop that spends tokens to launder a hallucination into a parseable object. The architecture is therefore not a better prompt. It is **validate in layers, retry only what retry can move, fail loud when it cannot**: Extract → Validate (parse / schema / semantic) → Repair-retry (bounded) → Accept or route to human review.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the 2-minute answer, the shape-vs-content split, and why "retry until it parses" is the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built — a validation/retry contract with a human-review dead letter, not a JSON prompt — and the anti-pattern it exists to kill.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": request/result records, which failures retry, what changes between attempts, and the sequences where retry helps, where it cannot, and where the budget expires.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for when a one-shot script is enough, what this system cannot promise, and the permanent cost of retries that "succeed" on invented values.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is one frozen schema and a labeled failure sample, not a retry client.
