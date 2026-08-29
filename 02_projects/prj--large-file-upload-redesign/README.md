# prj--large-file-upload-redesign

Architecture and system design documentation for a file-upload path that fails for large files, for some people, some of the time — and for the redesign that makes that class of failure largely stop happening.

Documentation-only project: no PHP handler, no nginx config, no client uploader lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "pre-signed URL trap"), not a general media platform. The current path is browser → nginx → PHP-FPM → object storage. That path is a known anti-pattern for large files. The replacement is three words — **S3 pre-signed URLs** — and a pile of honest cost that those three words usually leave out.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the problem, the layer-by-layer fault tree, what to check first, and the trap.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* the system is after the redesign, and why nginx/PHP-FPM leave the data path.
3. Read [System Design](./_docs/03_system_design.md) for the two upload flows (single PUT vs multipart), the session model, and post-upload verification.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what those three words actually cost.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is diagnose, not rewrite.
