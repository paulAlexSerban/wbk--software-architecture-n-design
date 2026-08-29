# prj--rag-selfheal

Architecture and system design documentation for a **multi-query & corrective RAG pipeline** modeled as a **state machine**, not a linear retrieve-then-generate chain. Query rewriting and decomposition into sub-queries, retrieval fan-out, Reciprocal Rank Fusion (RRF), plus a corrective self-check: grade retrieved docs for relevance and re-retrieve (or fall back to broader/web search) if the LLM judges context insufficient.

Documentation-only project: no LangGraph graph, no retriever, no grader prompt, no RAGAS harness lives here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "open-loop retrieval trap"), not a general RAG platform and not a serving-scale index. Indexing 50 million documents and hitting sub-second p99 retrieval is a different project — see [`prj--rag-pipeline-at-scale`](../prj--rag-pipeline-at-scale/). This one assumes a retriever exists. The defining fact is control flow: a chain has no branch for "the retrieved context does not actually answer this question." Raising top-k is not that branch. A reranker is not that branch. An unbounded agent that keeps calling search until it feels done is that branch with the budget removed. The documented answer is a **bounded state machine**: decompose, fan out, fuse, grade, correct at most once, then generate or give up honestly.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the open-loop trap, the three failure modes a chain cannot see, and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* it is a state machine over decompose / retrieve / fuse / grade / correct, not a longer chain.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": sub-query fan-out, RRF, the three-way grade, the iteration bound, the web-search fallback, and the forbidden "generate anyway" terminal.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what the correction loop costs in latency and tokens, when it is worth paying, and what CRAG will never fix (bad chunking, a stale index, a miscalibrated grader).
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a labeled eval of today's single-pass RAG, not a LangGraph demo.
