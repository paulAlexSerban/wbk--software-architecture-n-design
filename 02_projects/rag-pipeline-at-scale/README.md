# prj--rag-pipeline-at-scale

Architecture and system design documentation for a retrieval-augmented generation pipeline that must index ~50 million source documents and answer with **sub-second p99 retrieval**, not "the LLM eventually replied."

Documentation-only project: no chunker, no embedding worker, no vector-DB config, no eval harness lives here. This is the design specification a build phase would implement against.

The defining fact is arithmetic, not a preference for a vector database. Fifty million *documents* is not fifty million *vectors*. At a conservative ~6 chunks per document the serving index is **~300 million embeddings**. Raw float32 vectors at 1536 dimensions are already **~1.8 TB** before the HNSW graph, replicas, or the BM25 index. Sub-second p99 is tight because of **rerank cost and scatter-gather tails**, not because the ANN library was the wrong brand. The design is therefore not "stand up a sharded vector DB." It is a dual-index retrieval funnel with versioned chunks, an async refresh pipeline that treats staleness as a first-class SLO, and production degradation detection that does not wait for the next offline eval.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the scale math that makes "50M docs, one vector DB" a capacity lie, and the latency ledger that makes "just retrieve faster" miss the p99 budget.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and why the system is a dual-index funnel plus a freshness pipeline, not a single ANN cluster.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": chunk IDs, dirty-chunk refresh, RRF fusion, shard hedging, the millisecond budget, and the online degradation signals.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what to build, what to give up, why "add more vector DB shards" is not a full answer, and how the design changes if 50M meant chunks rather than documents.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to size hardware off a guessed chunk count.
