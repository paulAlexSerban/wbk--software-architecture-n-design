# prj--coding-agent-harness

Architecture and system design documentation for a coding agent harness that takes a GitHub issue and opens a pull request against a mid-sized repository (real CI, real test suite, multiple packages, existing conventions, often-ambiguous issues).

Documentation-only project: no orchestrator code, tool implementations, or sandbox infrastructure lives here. This is the design specification a build phase would implement against.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Security Architecture](./_docs/05_security_architecture.md)
- [Evaluation Framework](./_docs/06_evaluation_framework.md)
- [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md)
- [Operations Runbook](./_docs/08_operations_runbook.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) and [Architecture Document](./_docs/02_architecture_document.md) for *what* this is and *why* it is shaped this way.
2. Read [System Design](./_docs/03_system_design.md) for the control loop, tool contracts, context-window management, error handling, and stop conditions — the mechanical "how."
3. Read [Security Architecture](./_docs/05_security_architecture.md) before reading anything else operationally — this harness executes instructions found inside text written by strangers (issue bodies, comments, file contents), and the whole design is shaped around that threat.
4. Read [Evaluation Framework](./_docs/06_evaluation_framework.md) for the brutally honest answer to "how do we know this is actually useful, not just impressive in a demo."
5. [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md) and [Operations Runbook](./_docs/08_operations_runbook.md) cover rollout gating and day-2 operation.
