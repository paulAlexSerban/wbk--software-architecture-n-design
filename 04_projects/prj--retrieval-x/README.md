# prj--retrieval-x

Architecture and system design documentation for `retrieval-x`, a standalone hybrid + reranked RAG microservice: BM25 (keyword) and vector search fused via Reciprocal Rank Fusion, then a swappable cross-encoder (or Cohere) reranker on top-N, with source citations on every returned chunk.

Documentation-only project: no FastAPI routes, no chunker, no embedding worker, no Dockerfiles, no eval notebook lives here. This is the design specification a build phase would implement against.

The defining constraint is not the fusion formula. RRF is a few lines of arithmetic. The load-bearing work is **proving that each added stage is worth its latency**, on a labeled query set that does not yet exist, behind a reranker interface that must actually swap without touching callers, under a latency SLA that "just add a reranker" will silently blow. This is therefore not "stand up hybrid RAG." It is a **retrieval quality service with an ablation table as a first-class artifact**, and a degradation path that returns fused-but-unreranked results rather than failing the request when the expensive stage times out.

This project is about retrieval *quality* as a pluggable microservice. It is not about serving 50 million documents at sub-second p99; that is [prj--rag-pipeline-at-scale](../prj--rag-pipeline-at-scale/README.md). Do not import that project's sharding, freshness, or RAM math into this one. The two designs compose; they do not substitute.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for why naive vector search is the baseline that must be beaten *in numbers*, why labeled judgments are the actual bottleneck, and why rerank cost is the latency ceiling.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is a staged pipeline behind a versioned API, not a library imported into every downstream app.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": parallel retrieve, RRF, the reranker interface, citation assembly, the latency budget, and the eval harness that publishes the table.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what to build, what to give up, what to ask for (the judgments, not the GPUs), and how a hard low-latency SLA changes the pipeline.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to ship hybrid+rerank before the baseline row exists.
