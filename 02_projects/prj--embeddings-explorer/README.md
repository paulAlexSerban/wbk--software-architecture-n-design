# prj--embeddings-explorer

Architecture and system design documentation for a **retrieval-only** embeddings explorer: chunk a folder of markdown/PDF docs, embed the chunks, store them in a vector index, search them, and **benchmark chunking strategies** against a labeled eval set.

Documentation-only project: no chunker, no embedder, no pgvector schema, no Streamlit app lives here. This is the design specification a build phase would implement against.

The defining fact is not infrastructure. A personal folder of documents fits on a laptop. pgvector, Chroma, and FAISS will all "work." The thing this project can get wrong — and the only thing later RAG projects will inherit if it does — is treating **eyeballing a few search results** as a chunking-strategy decision. Without a held-constant embedding model, a labeled `(query → relevant chunk)` set, and a table that reports quality *and* cost, "recursive beat fixed-size" is a vibe. This design is therefore not "stand up a vector DB with a search box." It is a **controlled experiment** whose independent variable is the chunker, whose dependent variables are recall@k / MRR plus ingest time and embed dollars, and whose output is a baseline every later RAG project in the roadmap is measured against.

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for what "retrieval-only" actually forbids, why a folder of docs is not a corpus until it has labels, and which problems this project is **not** allowed to solve.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built: a linear ingest pipeline, a query path with no generator, and an offline benchmark harness that is the actual product.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": the three chunkers, chunk IDs that let variants coexist, the eval metrics, and why semantic chunking is a second embedding job.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what to build, what to give up, why a 40-query winner is not a law of nature, and why this toy is still the right first embeddings project.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to declare a "best chunker" before the eval set exists.
