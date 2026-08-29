# Naive RAG Document Q&A: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A private-knowledge-base Q&A system that answers questions over a small corpus (a resume, a portfolio, a handful of internal markdown/PDF docs) by running the textbook RAG loop once: **ingest → chunk → embed → store → retrieve → generate**.

This is not "RAG as a product." It is **naive RAG as a measured baseline**. The system is supposed to work well enough to demo, fail in documented, named ways, and leave a number that later systems (hybrid + rerank, corrective RAG, hierarchical/graph RAG, an eval platform) can beat. Calling it naive is not branding. It is a scope lock: if a later ticket "just adds a reranker," that ticket is no longer this project — it is [roadmap §1.1](../../../04_challenges/ai-engineering-portfolio-roadmap.md).

## Business Context
- **Corpus**: on the order of **tens to low hundreds of documents**. A resume plus project write-ups. A team's internal wiki export. Not 50 million documents — that problem is [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/). Heterogeneous formats (markdown, PDF, maybe HTML) but short enough that a laptop and one Postgres instance are the right hardware.
- **Consumer**: the operator themselves (portfolio demo, interview walkthrough) or a single trusted user asking questions of their own docs. There is no multi-tenant ACL story. There is no customer-facing SLA.
- **Operator**: one engineer. Ingest is a batch job they trigger. Retrieval and generation are request/response. Deploy target is Docker Compose, then Kubernetes, **for infrastructure reps** — not because this workload needs a cluster.
- **The constraint the prompt hides**: "it works" is cheap at this scale. A 40-document corpus with 400 chunks will often retrieve something vaguely related and an LLM will fluently pad it into an answer. The failure is **silent unreliability**, not a 500. Architecture that only proves "a question returned text" has not done the job. Architecture that catalogs *which* questions retrieve the wrong chunk, bury the right one, or invent a citation has.

## The Math (the actual requirement)

This is the constraint every other document in this project exists to respect. It is not a preference for pgvector. It is a **ceiling on when naive RAG is even a legitimate design**.

### Small corpus is the only reason this is allowed to be naive

| Assumption | Working value | Why it is load-bearing |
| --- | --- | --- |
| Source documents | 20–200 (working: **~50**) | Resume + portfolio write-ups, or a small internal dump. Above a few hundred, "I read the top-k" stops being a debugging strategy. |
| Mean chunks / document | ~4–12 depending on chunk size (working: **~8**) | Fixed 512-token windows on mixed markdown/PDF. A 2-page resume is 2–4 chunks; a 15-page architecture doc is 20+. |
| Serving cardinality | **~400 chunks** (range ~80–2,000) | This is why pgvector on one Postgres is correct and a dedicated ANN cluster is theatre. |
| Embedding dimension | 1536 float32 (or 768 — pick one in Phase 0 and do not mix) | `400 × 1536 × 4 ≈ 2.5 MB` of payload. Memory is not the problem. Quality is. |
| Top-k stuffed into the prompt | **k = 4–8** (working: **5**) | Naive RAG has no reranker, so k is both the recall knob and the context-pollution knob. Raising k to "get more recall" is how lost-in-the-middle starts. |
| Context tokens from retrieval | `k × ~400 tokens ≈ 2,000` plus system prompt plus question | Well inside a modern context window. **Fit is not the issue. Attention is.** Lost-in-the-middle is a quality failure at sizes that still "fit." |
| Query QPS | ≪ 1, bursty, single user | No caching, no replica set, no p99 budget that matters. Latency is "the embedding API plus the LLM," not HNSW. |

**The conclusion, which is not optional:** at ~400 chunks, every naive-RAG quality problem is already expressible. You do not need 50 million documents to observe lost-in-the-middle, chunk-boundary bleed, or cosine-similarity ≠ relevance. You need a labeled question set and the honesty to score it. Scaling the corpus without fixing those problems does not create new failure modes so much as **make them unauditable**. That is when this design becomes [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/) — or, more usefully, when you stop and build [roadmap §1.1](../../../04_challenges/ai-engineering-portfolio-roadmap.md) on the *same* corpus.

### Where the ceiling actually is

Naive RAG is a legitimate design **below** roughly a few thousand chunks, single-tenant, low-stakes, operator-in-the-loop. It stops being legitimate when any of these become true:

| Crossing | What breaks | What to do instead of patching this repo |
| --- | --- | --- |
| Corpus grows to tens of thousands of chunks | Top-k cosine returns neighbors that are topically close and factually useless; you cannot eyeball the index | Hybrid + rerank ([§1.1 `retrieval-x`](../../../04_challenges/ai-engineering-portfolio-roadmap.md)); do not add shards to pgvector and call it architecture |
| Questions are multi-hop or multi-part | One query embedding retrieves one neighborhood; the answer needed two | Query decomposition / corrective RAG ([§1.2](../../../04_challenges/ai-engineering-portfolio-roadmap.md)) |
| Docs have structure that chunk windows destroy | Tables, headings, "not" split from its clause | Structure-aware / hierarchical chunking ([§1.4](../../../04_challenges/ai-engineering-portfolio-roadmap.md)) |
| Wrong answers have cost (customers, compliance, hiring decisions about *other people*) | Fluent unfaithful generation is now harm | Faithfulness checks, citations, eval CI ([§1.5](../../../04_challenges/ai-engineering-portfolio-roadmap.md)) — and probably do not ship naive RAG at all |
| More than one trust boundary reads the index | Post-filter ACLs leak; pre-filter does not exist here | Retrieval-time authorization ([§1.3](../../../04_challenges/ai-engineering-portfolio-roadmap.md)) |
| Corpus mutates daily | Full re-embed is the only refresh; staleness is silent | Dirty-chunk pipeline — see at-scale freshness design, not a cron `DELETE FROM chunks` |

Phase 0 must write the corpus size and the stakes down. If the stakes are "customer-facing Q&A over an internal wiki," this project is the wrong project. Build the baseline on a **resume/portfolio corpus** and keep the wiki for a later tier.

## Core Value Propositions
1. **A working, deployed, three-service RAG loop** that an interviewer can trace from PDF to answer without a Jupyter notebook as the architecture.
2. **Named failure modes as first-class artifacts.** Lost-in-the-middle, no reranking, chunk-boundary bleed, no hybrid retrieval, no query rewrite, static index, unfaithful generation, no eval loop, no retrieval-time ACL. Each one is documented with an example and a pointer to the roadmap tier that fixes it. See [System Design — Known Failure Modes](./03_system_design.md#9-known-failure-modes).
3. **A scored baseline, not a vibe.** A small hand-labeled Q/A set, precision@k on retrieval, and a qualitative failure log. The number is allowed to be embarrassing. A green demo with no number is a failed project. See [Phased Implementation Plan — Phase 5](./06_phased_implementation_plan.md).
4. **Clean service boundaries** (ingestion, retrieval, generation) so later projects can replace a *service*, not a script. The split is pedagogical at this scale; [ADR-004](./04_architecture_decision_records.md#adr-004) says so.
5. **Infra reps that are honest about why they exist.** Docker Compose is the real local target. Kubernetes manifests exist so the operator can show they can ship three services, not because 400 vectors need a cluster.

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0**, not facts. None of them is RAGAS. RAGAS is [roadmap §1.5](../../../04_challenges/ai-engineering-portfolio-roadmap.md). Using it here would contaminate the baseline with a later-tier tool and make "we beat naive RAG" circular.

1. **Corpus fully indexed, with extraction failures counted.** Every source file is either in the chunk table or in an `unsearchable` log. Silent empty extracts are a failed ingest, not "zero chunks for that PDF, oh well."
2. **Retrieval precision@k on a frozen eval set** of at least ~20 labeled `(question → relevant doc_id or chunk_id)` pairs, including:
   - paraphrase questions (embeddings should win),
   - exact-token questions (names, dates, project codenames — embeddings may lose; **that loss is the baseline**),
   - questions whose answer sits at a chunk boundary (bleed probe),
   - questions whose relevant chunk is *not* the nearest neighbor (rerank probe — expected fail).
3. **End-to-end answerability, scored by a human, not an LLM-as-judge.** For each eval question: retrieved-the-right-chunk (Y/N), answer-supported-by-retrieved-text (Y/N), answer-correct-in-the-world-of-this-corpus (Y/N). Those three are different. Collapsing them into "looks good" is how this project lies.
4. **Failure catalog.** At least one real example of each named failure mode, captured in the Phase 5 baseline report, or an explicit "did not reproduce on this corpus" with the probe that was tried. Absence of a catalog is a failed gate.
5. **Deployed, not notebooked.** Three services reachable via Docker Compose; k8s manifests exist and have been applied to *some* cluster (kind/minikube/a real one — pick one). "It runs in a REPL" is not this metric.

What is **not** a success metric:

- Latency SLOs. There is no user population.
- Cost per 1k queries as a business number. The bill is a few dollars of embeddings plus whatever the LLM playground already costs.
- "The chatbot answered my resume questions." That is the demo. The metric is the score next to it.

## Business Rules
1. Retrieval is **vector-only, top-k cosine (or inner-product — pick one, never mix)**. No BM25, no hybrid fusion, no cross-encoder rerank. [ADR-003](./04_architecture_decision_records.md#adr-003).
2. Chunking is **fixed-size or recursive-character splitting with overlap**. No heading-aware splitter, no parent-child index, no semantic chunking. [ADR-001](./04_architecture_decision_records.md#adr-001).
3. The query path **embeds the raw user question once**. No rewrite, no decomposition, no HyDE. Multi-part questions are expected to degrade.
4. Ingest is **batch and full**. A corpus change is a re-run of ingestion, not a dirty-chunk queue. There is no freshness SLO because there is no incremental path to measure.
5. Generation **stuffs retrieved chunks into a prompt and calls an LLM**. There is no citation-verification step, no entailment check, no abstain-if-unfaithful gate. Unfaithful answers are in-scope failures to record, not bugs to hotfix in this project.
6. **Single tenant, single trust boundary.** The index is the operator's docs. Retrieval-time authorization is out of scope and named as a gap, not implemented as a UI checkbox.
7. Evaluation is **offline, human-scored, on a frozen set**. No production quality observer, no RAGAS CI gate. The Phase 5 report *is* the eval.
8. If the corpus, the stakes, or the user population leave the envelope in [the ceiling table](#where-the-ceiling-actually-is), **stop**. Do not "just add a reranker" inside this design. That is a different project, and pretending otherwise is how baselines get polluted.

## Pipeline Consumers
This is a small internal (or portfolio) Q&A stack. Its surface area is operational and demonstrative:

1. **API / UI caller**: a person asking a question, getting an answer. They will trust fluent text. The baseline report has to make that trust falsifiable.
2. **Ingestion operator**: the same person, dropping files into a folder and triggering a job. They own extraction failures.
3. **Later-tier projects**: `retrieval-x`, `rag-selfheal`, `rag-metrics`, and eventually `prj--rag-pipeline-at-scale`. They are the reason this exists. The contract they need is: the same corpus, the same eval set, a published naive score, and service boundaries they can replace.

## What this project is not
- Not a search engine. There is no lexical index.
- Not an evaluation platform. There is a spreadsheet and a report.
- Not a production assistant for a company wiki.
- Not a stepping-stone that quietly grows features until it is hybrid RAG with extra steps. Feature growth belongs in new projects with new ADRs.
