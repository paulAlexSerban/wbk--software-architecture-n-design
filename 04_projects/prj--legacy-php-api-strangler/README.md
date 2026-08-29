# prj--legacy-php-api-strangler

Architecture and system design documentation for exposing a JSON API to a mobile client over an existing framework-less PHP 8 application whose business logic is mixed into HTML templates — without breaking the existing pages and without a rewrite.

Documentation-only project: no PHP handlers, Composer files, or schema migrations live here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "strangle the templates" problem), not a greenfield API platform. The defining constraint is organizational and structural, not traffic: the web app already exists, it already works, it has **no tests**, and the logic the mobile client needs is trapped inside `echo`. The system is therefore not "add a REST layer." It is a **second, small application at the HTTP edge** that reuses extracted domain classes and the same database, while the old page dispatch is left completely alone.

The naive answer — bolt a `/api` branch into the old per-page dispatch, `include` the same templates, scrape HTML into JSON, or share PHP session cookies with a mobile client — is the failure. It couples two clients to one entanglement, makes every extraction a production incident, and pretends sessions designed for browsers are a mobile auth protocol.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the problem, the trap, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built: the two-entry-point topology, where shared logic lives, and why sessions stay on the web.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical *how*: routing, extraction procedure, token auth, error envelope, characterization tests.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what this actually costs, what is given up, and when extraction is the wrong move.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout. Phase 0 is characterization tests. Skipping it is how the first extraction breaks a page nobody noticed.
