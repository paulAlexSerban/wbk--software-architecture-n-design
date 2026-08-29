# prj--docqa-basic-naive-rag

Architecture and system design documentation for a **deliberately naive** RAG Document Q&A system: ingest → chunk → embed → store → retrieve → generate, over a private knowledge base (a resume/portfolio, or a small set of internal docs).

Documentation-only project: no chunker, no embedding worker, no FastAPI service, no Docker Compose lives here. This is the design specification a build phase would implement against.

The defining decision is to **name it naive and leave it naive**. There is no reranker, no BM25 leg, no query rewriting, no incremental refresh, no faithfulness check, and no eval harness in the runtime path. Those omissions are the product. This is the measured baseline the rest of the [AI engineering roadmap](../../04_challenges/ai-engineering-portfolio-roadmap.md) is supposed to beat — not a production recommendation wearing a tutorial costume. At this corpus size (tens to low hundreds of documents) the pipeline *will* often look fine in a demo. The architecture's job is to document **why that demo is lying**, and where the lie becomes expensive.

The three microservice boundaries (ingestion / retrieval / generation) are real service contracts. They are also, at this scale, operationally heavier than a monolith. That trade-off is pedagogical and is said out loud.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for why this is a baseline, not a product, and the corpus-size ceiling at which naive RAG stops being "good enough for a portfolio" and becomes malpractice.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* three services exist when one process would do.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": chunking, pgvector top-k, prompt stuffing, and the named failure modes (lost-in-the-middle, no reranking, chunk-boundary bleed) with worked examples.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what is given up on purpose, when naive RAG is actually fine, and when shipping it is the wrong answer.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout whose last phase is a written baseline report, not a "it works" screenshot.

## Related

- Source scenario: [AI Engineering Portfolio Roadmap — §0.5 Naive RAG Document Q&A](../../04_challenges/ai-engineering-portfolio-roadmap.md)
- What this becomes when the corpus is not a resume: [prj--rag-pipeline-at-scale](../prj--rag-pipeline-at-scale/)
