# prj--rag-hierarchy-graph-rag

Architecture and system design documentation for a **comparison study**: hierarchical RAG and graph RAG against a naive/hybrid baseline, over one bounded corpus of SEC 10-K filings. Index topology is the architectural decision. The product is not "the winning pipeline." The product is a **published evaluation table** on the same questions, plus an honest account of which query shapes each topology can and cannot answer.

Documentation-only project: no LlamaIndex graph, no Neo4j dump, no RAGAS notebook, no EDGAR crawler lives here. This is the design specification a build phase would implement against.

The defining fact is that **vector similarity is a one-hop neighborhood**, and some questions are not one-hop. "Which subsidiaries of X's named competitors are located in Y?" asks the system to walk `X → competitor → subsidiary → location`. A flat chunk index can retrieve prose that *mentions* one of those entities. It cannot, by construction, compose a path it never stored. Hierarchical retrieval can recover the *right section* of a long filing when the answer lives at a coarser grain than a 512-token chunk. It still cannot walk a relation that was never indexed as a relation. Graph retrieval can walk that path — **if and only if** the extraction step actually wrote the edges, and **if and only if** the query maps onto a schema the graph anticipated.

The roadmap's example query ("which suppliers of X's competitors are based in Y?") is the interview bait. A 10-K almost never names suppliers. Treating that query as the eval set without reading the filings is how you ship a graph that "wins" on questions the corpus cannot answer. Phase 0 exists to kill or reframe that query against what Item 1A, Item 2, and Exhibit 21 actually disclose. See [Scenario and Requirements](./_docs/01_scenario_and_requirements.md).

This is not a serving-scale index. Indexing 50 million documents is [`prj--rag-pipeline-at-scale`](../prj--rag-pipeline-at-scale/). This is not hybrid+rerank quality tuning; that is [`prj--retrieval-x`](../prj--retrieval-x/). This is not a correction loop; that is [`prj--rag-selfheal`](../prj--rag-selfheal/). Those compose. They do not substitute. The scarce resource here is **index topology matched to query topology**, measured, not asserted.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the corpus, the supplier-disclosure reality check, and why three parallel indices exist instead of one clever retriever.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* comparison-as-product is the architecture, not a bake-off you throw away after picking a winner.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": parent-child chunking, auto-merging, section-scoped extraction, the Neo4j schema, Cypher templates, and the eval harness.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for what graph RAG actually buys, what extraction precision costs, and when hierarchical RAG is the grown-up answer.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a filing-reading exercise, not a Neo4j demo.

## Related

- Source scenario: [AI Engineering Portfolio Roadmap — §1.4 Hierarchical / Graph RAG](../../04_challenges/ai-engineering-portfolio-roadmap.md)
- Naive baseline this study must beat *and* not silently replace on easy questions: [`prj--docqa-basic-naive-rag`](../prj--docqa-basic-naive-rag/)
- Hybrid + rerank microservice that can sit under the baseline leg: [`prj--retrieval-x`](../prj--retrieval-x/)
- Eval-as-discipline this study should eventually plug into: roadmap item 1.5 `rag-metrics` (not yet a sibling project in this workbook)
