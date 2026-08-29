# prj--multi-source-rag-access-control

Architecture and system design documentation for a multi-source RAG system that answers over a SQL database, a document store, and Slack/Notion exports, with **per-user permission filtering applied at retrieval time**, not at the UI layer and not as a prompt instruction.

Documentation-only project: no chunker, no connector code, no vector-DB config, no LLM client lives here. This is the design specification a build phase would implement against. Retrieval quality itself is assumed to come from a Tier 1.1 hybrid retrieval service (`retrieval-x` / [prj--rag-pipeline-at-scale](../prj--rag-pipeline-at-scale/README.md)) as a backend. This project is the **authorization and federation layer** on top of that backend — not a second vector database with a nicer README.

The defining constraint is not "add a permission filter." **ACL models differ per source**, permission checks must survive **chunking, reranking, caching, and multi-hop retrieval**, and **ACL revocation lag is a security SLA**, not an ops nicety. Post-filtering top-k is a leak. Per-user metadata on every chunk does not scale. Telling the model "only use documents the user may see" is not a control. The design exists because a knowledge assistant that is useful is, by construction, a system that can leak every document it can retrieve.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Security and Access Control](./_docs/04_security_and_access_control.md)
- [Architecture Decision Records](./_docs/05_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for why UI-layer filtering and post-filter RAG are the same bug with different costumes, and what "permission" even means across SQL, Drive-class docs, Slack, and Notion.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and why identity/group resolution, ACL sync, and federated retrieval are three subsystems, not one middleware function.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": the normalized ACL model, group-fanout pre-filters, cache keys that include resolved groups, RRF across sources, and SQL that executes under the caller's RLS role.
4. Read [Security and Access Control](./_docs/04_security_and_access_control.md) before arguing for post-filter, live-per-source ACL checks, or a semantic cache keyed only on the question.
5. Read [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md) before deciding to build this instead of buying Glean/Copilot, and before promising "real-time ACL."
6. [Architecture Decision Records](./_docs/05_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to index real company data until a leakage red-team gate passes.
