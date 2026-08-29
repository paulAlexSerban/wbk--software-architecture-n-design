# Embeddings Explorer: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a **retrieval-only** embeddings explorer over a folder of markdown and PDF documents. Chunk the files, embed the chunks, store the vectors, search them from a simple UI — and **benchmark chunking strategies** (fixed-size vs recursive vs semantic) so the comparison is a table, not a feeling.

The design must answer, concretely:

1. What "retrieval-only" forbids. Generation, reranking, hybrid BM25, agents, and a chatbot are out of scope on purpose, not because they were forgotten.
2. How chunking strategies are compared fairly — same corpus, same embedding model, same vector store, same query set — so a win is attributable to the chunker, not to a confound.
3. Where ground-truth relevance comes from. Recall@k and MRR are undefined without labeled `(query → relevant chunk or doc)` pairs. "It looked relevant" is not a metric.
4. What the search UI is for (eyeballing, demo, qualitative sanity) and what it is not (the product).
5. What this project is allowed to claim, and what it must refuse to claim, once the corpus is a personal folder rather than a production knowledge base.

This is the first embeddings project in a larger roadmap. Later projects (`docqa-basic`, hybrid + rerank, hierarchical / graph RAG, RAG-at-scale) will inherit whatever methodology — or lack of it — is established here. A pretty search box over one chunker is a tutorial. A held-constant comparison with labels, cost, and caveats is a baseline.

The correct shape is: **ingest is a batch pipeline, search is nearest-neighbor over chunks, the product is the benchmark table, and the eval set is a launch gate.** That sentence is the whole architecture. Everything else in this project is the honest cost of making the comparison real without quietly adding a generator or quietly skipping labels.

## The Trap, Stated Directly

"Chunk + embed a folder of docs" is the most copied notebook in AI engineering. The usual failure is not that the notebook crashes. It is that the author **cannot say which chunker is better, or why**, and then carries that unmeasured default into every later RAG system.

| What people hear | What the constraint actually protects |
| --- | --- |
| "Just retrieval, no LLM yet" | The system returns ranked chunks. It does not write answers. If you add generation to "make the demo nicer," you have started `docqa-basic` and abandoned this project's measurement job. |
| "Benchmark chunking strategies" | A table on a **fixed** eval set, with the embedding model and store held constant. Not: three notebooks, three different models, "recursive felt better." |
| "Simple search UI" | A query box that shows chunk text, source path, score, and which strategy produced the hit. Not: auth, sharing, collections, a product. |
| "pgvector / Chroma / FAISS" | A store that fits a laptop corpus. The store is not the architecture. Picking one and never measuring chunking is how this becomes a database demo. |
| "This becomes the baseline for later RAG" | The **method** (labels, held-constant variables, quality + cost) is what later projects reuse. The specific winner on *this* folder will not transfer. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| A vector search that "just works" | Yes, in an afternoon, on markdown. PDFs will dominate the pain, and it will look like a chunking problem when it is an extraction problem. |
| A scientifically best chunker | No. A 30–60 query hand-labeled set is directional. It is not a significance test. Report numbers with caveats or do not report a winner. |
| Results that generalize to 50M docs | No. This corpus, this embedding model, this query mix. The [RAG-at-scale](../../prj--rag-pipeline-at-scale/README.md) project exists because the capacity and latency story is a different problem. |
| Semantic chunking as the sophisticated default | Not assumed. Semantic splitting is a **second embedding pass** over sentences. It can win. It can also lose to a recursive markdown splitter at 10× the ingest cost. Measure it. |
| Production search | No HA, no freshness SLO, no multi-tenant ACL, no incremental re-embed. Batch reindex of the folder is the write path. Pretending otherwise is solving a problem this scenario does not have. |

Capitulating to "I'll add a chatbot so there's something to show" is how you skip the only hard part. Capitulating to "I'll eyeball ten queries" is how you pick a chunker you cannot defend. Capitulating to "I'll also build hybrid + rerank while I'm here" is how this stops being a foundation and becomes a worse version of later roadmap projects.

## Current State (Assumed Starting Point)

A typical first embeddings notebook looks like:

1. `glob("docs/**/*.md")`, maybe a PDF loader that returns page soup.
2. `CharacterTextSplitter(chunk_size=1000, chunk_overlap=200)` copied from a blog post, token-count never measured.
3. One embedding model (whatever the tutorial used last year), vectors dumped into Chroma in `./chroma_db`.
4. `similarity_search(query, k=4)`, print the texts.
5. The author tries two other splitters in two other cells, changes the model in one of them, and concludes "semantic chunking is better" because the one query they care about ranked a nicer paragraph.

That version will appear to work in a demo: a question, four chunks, a green notebook. It will fail the job of this project the first time:

- someone asks *how much better*, and there is no eval set,
- a PDF with two-column layout is indexed as word salad, and every chunker "fails" equally,
- the next project (`docqa-basic`) copies the splitter parameters as folklore,
- a later hybrid/rerank project cannot tell whether a quality gain came from fusion or from finally fixing chunk boundaries,
- the search UI grows filters and chat and never ships the comparison table.

This project documents the replacement: a **versioned, pluggable chunker**, one store that can hold **multiple strategy variants** of the same corpus, a **query path that returns chunks not answers**, and a **harness that is not optional**.

## Concrete Corpus Used Throughout These Docs

One product-shaped example, so the sequences are not abstract.

**Corpus: a personal technical knowledge folder.** Mix of:

- markdown notes, READMEs, architecture docs (clean structure, headings, code fences),
- exported PDFs (papers, vendor docs, slide-like reports — extraction quality varies),
- a small amount of HTML or plaintext if it is already in the folder.

Working size assumption, labeled as such until Phase 0 counts files:

| Assumption | Working value | Why it is load-bearing |
| --- | --- | --- |
| Source files | tens to low thousands (working: **~200–2,000**) | If it is 20 files, the eval set is the scarce resource, not ingest. If it is 20,000 PDFs, this is no longer a laptop project and the honesty in [Trade-offs](./05_tradeoffs_and_honest_assessment.md) changes. |
| Mean chunks / file | highly variable (~3 for a short note, ~40+ for a long PDF) | Capacity is irrelevant at this scale. **Eval labeling is not**: you label chunks or docs, and chunk-boundary changes move the labels. See [System Design §5.3](./03_system_design.md#53-label-granularity). |
| Embedding dimension | 384–1536 depending on model | Memory is not the constraint. **Comparability** is: changing dim/model mid-benchmark invalidates the table. |
| Query mix | natural-language questions a human would actually ask of *this* folder | Synthetic "what is X" queries copied from the docs overfit extractive headings and flatter recursive/markdown splitters. |

Phase 0 replaces "200–2,000 files" with a count, a format mix, and an extract-failure rate. Until then every "the corpus is small" sentence is a working assumption, not a measurement.

## Explicit Non-Goals

These are not "later." They are out. Building them here spends the calendar that should go to labels and the comparison table.

1. **No LLM generation.** No RAG prompt, no "answer with citations," no chatbot. Downstream of this project is `docqa-basic`.
2. **No hybrid retrieval (BM25 + vector) and no cross-encoder rerank.** Those are the point of later retrieval projects. Shipping them here destroys the "naive dense retrieval" baseline those projects need to beat.
3. **No incremental refresh, CDC, or freshness SLO.** The write path is "re-run ingest on the folder." If a file changes, batch reindex that strategy variant. The [RAG-at-scale](../../prj--rag-pipeline-at-scale/_docs/02_architecture_document.md) freshness plane is a different system.
4. **No multi-tenancy, ACLs, or auth on the search UI.**
5. **No HA, sharding, quantization program, or p99 SLO.** A local Postgres and a Python process. If query latency is "slow," the cause is remote embed API or a huge semantic-sentence pass — not HNSW cluster tails.
6. **No claim that the winning strategy is globally best.** The table is *this corpus, this model, this eval set.*

## Functional Requirements

- **Ingest**: accept a configured folder of markdown and PDF (and optionally `.txt`/`.html`). Persist a document record (path, content hash, parser version, extract status). Failed extraction is a coverage hole (`unsearchable`), not an empty string stuffed into the index.
- **Chunking**: split extracted text through a **pluggable, versioned strategy** (`fixed_size`, `recursive`, `semantic`) with recorded parameters (window, overlap, separators, similarity threshold). Same document must be chunkable under every strategy without the strategies sharing IDs.
- **Embed**: embed each chunk with **one named model per benchmark run**. Tag every vector with `model_id` and `strategy_id`. Do not silently mix models in one comparison.
- **Store**: persist chunks + embeddings so a query can filter by `strategy_id` (and `model_id`). Multiple variants of the corpus coexist. See [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Query**: embed the query with the same model, k-NN over the selected variant, return ranked chunks with score, source path, heading/page if known, `chunk_id`, `strategy_id`. **No generator.**
- **Search UI**: query box, strategy selector, k, result list with provenance. Sufficient to eyeball. Not a product surface.
- **Benchmark harness**: for each strategy variant, (re)index if needed, run the **same** labeled eval queries, compute recall@k / MRR (and optionally nDCG), record ingest wall time, embed call count, and estimated $. Emit a comparison table plus the caveats required in [System Design §5](./03_system_design.md#5-benchmark-harness).
- **Eval set**: a versioned set of queries with human relevance judgments. Creating it is in-scope. Shipping without it is a failed gate. See [ADR-004](./04_architecture_decision_records.md#adr-004).

## Non-Functional Requirements

**Performance:**

- Ingest is a batch job. Minutes to tens of minutes on a laptop corpus is acceptable. Semantic chunking may be several times slower; that number belongs in the table, not in a complaint that "ingest should be real-time."
- Query latency: interactive enough for a human at the UI (low hundreds of ms is fine). No p99 contract. If a remote embedding API makes query feel slow, that is a reason to **localize the embedder**, not to introduce a cache architecture.

**Reliability:**

- At-least-once ingest with idempotent upserts keyed by `chunk_id`. Re-running ingest for one strategy must replace that strategy's chunks, not duplicate them.
- Embed failures: retry a small number of times; remaining failures stay unindexed and appear in coverage. Do not index empty embeddings.
- Single process / single machine. No distributed retry fabric.

**Infrastructure constraints:**

- Stack: Python, Postgres + pgvector as the primary store, local or API embedding model, a thin UI (Streamlit or a small FastAPI + HTML page). Chroma and FAISS remain valid alternatives; they are not the default. See [ADR-001](./04_architecture_decision_records.md#adr-001).
- Hosting: developer laptop or a small VM. Docker Compose for Postgres is plenty. Kubernetes is out of scope.
- Compliance: the folder may contain personal or unpublished text. Embeddings are not anonymization. The eval set and query logs inherit that classification. Do not paste the corpus into a public notebook.

**The defining constraint:**

- **There is no ground-truth relevance until Phase 0 creates it.** Every quality number in a future build report is downstream of that set. Architecture that ships the UI first and "adds eval later" has already spent the project.

## Success Metrics

Numeric targets are **starting points to calibrate in Phase 0**, not facts about an unbuilt system.

1. **Eval set exists and is versioned**: ≥ 30 queries (aim 40–60) with at least one relevant `doc_id` (and chunk-level labels where they survive re-chunking — see [System Design §5.3](./03_system_design.md#53-label-granularity)). A set of 8 queries is not this metric.
2. **Baseline recorded**: fixed-size chunker, chosen model, recall@k and MRR on the eval set, written down before recursive and semantic are compared. Without a baseline, later numbers are decoration.
3. **Comparison table ships**: three strategies (minimum), same model, same k, quality **and** ingest time **and** embed-token/cost estimate, plus a written caveat section. A winner without caveats is a failed metric.
4. **Coverage**: `% of files with successful extract` and `% of chunks with a vector` reported per run. A strategy that "wins" by dropping failed PDFs is cheating.
5. **Scope discipline**: the running system has no generator. If a README shows a chatbot, this project did not succeed; a different project started.

What is **not** a success metric: UI polish, number of vector DBs supported, "works with any embedding provider" as a platform, sub-second p99, or beating BM25. Those belong elsewhere.

## Architecturally Significant Requirements

These drive the ADRs. Everything else is implementation detail.

1. **Isolate the chunker as the independent variable.** Embedding model, similarity metric, store, and eval queries stay fixed across the primary comparison. [ADR-002](./04_architecture_decision_records.md#adr-002).
2. **Three named strategies, including the expensive one.** Fixed-size, recursive (structure-aware fallback), semantic (embedding-based boundaries). Semantic is not assumed to win. [ADR-003](./04_architecture_decision_records.md#adr-003).
3. **Human-labeled eval set is the ground truth for this project.** Not vibes, not LLM-as-judge as the primary metric. [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **Retrieval-only boundary is load-bearing.** No generation, no hybrid, no rerank in v1. [ADR-005](./04_architecture_decision_records.md#adr-005).
5. **pgvector on Postgres as the default store**, because later roadmap projects already assume SQL + vectors, not because this corpus needs it. [ADR-001](./04_architecture_decision_records.md#adr-001).

## Pipeline Consumers

This is a lab instrument that happens to have a search box.

1. **The operator (you)**: runs ingest, maintains the eval set, reads the comparison table, decides what default chunker `docqa-basic` will inherit. If this person needs a data scientist to notice that semantic chunking cost 8× for +0.02 MRR, the table failed.
2. **The search-UI user (also you, plus anyone you demo to)**: types a query, sees chunks. This consumer will want a chatbot. The architecture must not provide one.
3. **Later RAG projects**: consume the **method and the baseline numbers**, not the index. They will re-chunk, add BM25, add a generator. They should be able to say "vs embeddings-explorer fixed-size recall@5 = X on eval-set vN" rather than "we switched to recursive because a blog said so."
