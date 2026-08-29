# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: pgvector on Postgres over Chroma or FAISS as the Default Store

**Status**: Accepted

**Context**: The scenario names pgvector, Chroma, or FAISS. At a few thousand to tens of thousands of chunks, all three are operationally fine. FAISS is a library, not a database: metadata, filters, and "delete this strategy variant" become your problem. Chroma is low ceremony and disappears from later roadmap projects that already assume Postgres. pgvector adds Compose/Postgres overhead that a pure toy does not need for k-NN quality.

This project is also **foundation for later work** (`docqa-basic`, hybrid retrieval, eval logging). Those want SQL, joins to documents, and one operational database rather than a vector sidecar plus a metadata sidecar.

**Decision**: Default store is **Postgres + pgvector**. Chunks, documents, ingest-run stats, and vectors live there. k-NN filters on `strategy_id` / `model_id` in SQL. Chroma and FAISS remain **documented alternatives** for a later store-sensitivity experiment; they are not dual-written in v1. See [Architecture — Data](./02_architecture_document.md#data-architecture).

**Consequences**:
- (+) One system to backup: the database. Variant delete is a `DELETE`. Later RAG projects can reuse the schema shape.
- (+) Metadata filters are real SQL, not an afterthought JSON blob.
- (–) Heavier than `pip install chromadb` for a weekend toy. Accepted: Compose is the tax for reuse.
- (–) pgvector is the wrong 300M-vector serving store. This ADR does **not** claim otherwise; [RAG-at-scale](../../prj--rag-pipeline-at-scale/_docs/04_architecture_decision_records.md) already forbids that leap.
- **Alternative rejected**: FAISS-only. Fast ANN, poor system of record for documents and eval.
- **Alternative rejected**: Chroma as default. Fine for a notebook; weaker story for "this index is also the document table later."
- **Revisit trigger**: Phase 0 corpus is tiny and Postgres is blocking getting *any* eval table in a week — then Chroma for the lab is allowed **if** the harness and labels still exist. The store is not the product.

## ADR-002: Hold Embedding Model and Store Constant Across Chunking Comparisons

**Status**: Accepted

**Context**: Tutorials change the splitter, the model, and sometimes the database in the same afternoon and then rank the splitter. Retrieval quality is a product of chunk boundaries, representation, and index. If two variables move, the table does not identify a chunker.

A second, real confound: models with `query:` / `passage:` prefixes, different dimensions, and different similarity metrics. Mixing them inside one "recursive vs semantic" ranking is incomparable by construction.

**Decision**: The **primary** comparison table uses one pinned `model_id`, one distance metric, one store, one extractor version, and the same eval-set version. The independent variable is `strategy_id` + `params_hash`. A second embedding model is an optional later phase that produces a **separate** table (or a clearly faceted report), not a blended ranking. See [System Design §5.1](./03_system_design.md#51-procedure).

**Consequences**:
- (+) A win can be attributed to the chunker (plus noise from a small n).
- (+) Harness can refuse to merge incomparable runs.
- (–) You will not learn "semantic + model B" in the same grid. That is the point; grids eat the eval set alive.
- (–) The winning chunker may be model-specific. Phase 4 exists to check that. Until it runs, the report must say so.
- **Alternative rejected**: "We'll just note the model in a footnote" while averaging runs. Footnotes do not unconfound.

## ADR-003: Compare Fixed-Size, Recursive, and Semantic — Do Not Crown Semantic

**Status**: Accepted

**Context**: The scenario names fixed-size vs semantic vs recursive. Industry chatter treats semantic chunking as the grown-up option. Semantic splitting embeds sentences to choose boundaries, then embeds chunks again. That is a second embedding job. Recursive (markdown-aware separators with token fallback) is usually cheaper and often better on well-headed notes. Fixed-size is the control; without it you cannot say the fancy methods paid rent.

**Decision**: v1 implements all three as specified in [System Design §2](./03_system_design.md#2-chunking). Semantic uses the same `model_id` for sentence and chunk embeddings, counts sentence embeds in cost, and has a documented cut rule (percentile-based adjacent cosine). The comparison report **must** include ingest time and embed-call counts. No strategy is the default winner in the architecture. The default *candidate* for later naive RAG is "whatever the table says on this corpus," with recursive as the engineering prior if the table is a tie.

**Consequences**:
- (+) The expensive method has to justify itself in public.
- (+) Fixed-size keeps everyone honest when recursive is just "512-token windows with extra steps."
- (–) Semantic implementation details (percentile vs absolute threshold, sentence tokenizer) can dominate. Freeze one method; do not search the hyperparameter space until the eval set is larger.
- (–) Three full ingests. Still cheap. Do them.
- **Alternative rejected**: skip fixed-size because it is "too naive." Then you have no control.
- **Alternative rejected**: skip semantic because it is slow. Then you have not run the experiment the scenario asked for.
- **Alternative rejected**: LLM-proposed splits. Out of retrieval-only budget and another model in the loop.

## ADR-004: Human-Labeled Eval Set over Vibes or LLM-as-Judge as Primary Ground Truth

**Status**: Accepted

**Context**: Recall@k / MRR / nDCG require relevance labels. The usual substitutes: (1) the author looks at ten queries and picks a favorite splitter; (2) an LLM judges whether a chunk "answers" the query. (1) is not a measurement. (2) is a second model with its own biases, cost, and a tendency to agree with fluent chunks — correlated with the embedding model in hard-to-debug ways. For a 40-query set, a human afternoon is cheaper than a judge pipeline and more trustworthy.

**Decision**: Primary ground truth is a **versioned, human-labeled** eval set of ≥ 30 queries (target 40–60) with document-level (optionally passage-overlap) judgments. The harness will not produce a comparison table without it. LLM-as-judge is out of v1 as a *scoring* method. Side-by-side UI inspection is allowed as **error analysis**, not as the published ranking. Keyword/SQL full-text Success@k is a **baseline row** in the report, not a replacement for labels. Mechanics: [System Design §5](./03_system_design.md#5-benchmark-harness).

**Consequences**:
- (+) The table is about retrieval of documents a human marked, not about a judge's taste.
- (+) Labels live in git and can be argued with.
- (–) n is small; gaps of a few points are noise. The report must say this. [Trade-offs](./05_tradeoffs_and_honest_assessment.md) exists so nobody launders 0.02 MRR into a platform decision.
- (–) Labels rot if the corpus changes. Freeze or re-label.
- (–) Human labels are biased toward the author's questions. Better than no labels; not a user study.
- **Alternative rejected**: ship UI first, "add eval later." Later does not come. Phase 0 is the eval set.
- **Alternative rejected**: LLM-as-judge as the SLO. Revisit when `prompt-lab` / `rag-metrics` exist and the judge is calibrated; still not v1 for this project.

## ADR-005: Retrieval-Only Boundary — No Generation, No Hybrid, No Rerank

**Status**: Accepted

**Context**: A search box invites a chatbot. A dense-only miss on an error code invites BM25. A messy top-10 invites a cross-encoder. Each of those is a later roadmap project (`docqa-basic`, `retrieval-x`). Putting them in *this* repo destroys the **naive dense baseline** those projects are supposed to beat, and it spends the calendar that should go to labels and the three chunkers.

This boundary is also what the scenario text asked for: first embeddings project, **no LLM generation yet**, just retrieval quality.

**Decision**: Query service returns ranked chunks only. No prompt, no generator, no BM25 in the serving path, no rerank. Keyword search may appear **only** as a harness baseline row. The search UI must not grow an "answer" control. See [Scenario — Non-Goals](./01_scenario_and_requirements.md#explicit-non-goals).

**Consequences**:
- (+) Later projects have a cited dense-only number to beat.
- (+) Scope stays a week-scale lab, not a stealth RAG platform.
- (–) Demos look less impressive than a chatbot. Accepted. The impressive artifact is the table.
- (–) ID/code queries will look bad. Document that with eval queries; do not "fix" it here.
- **Alternative rejected**: "just a small generate button for the README GIF." That button is the project next door.
- **Revisit trigger**: never inside this project. Fork or start `docqa-basic`.
