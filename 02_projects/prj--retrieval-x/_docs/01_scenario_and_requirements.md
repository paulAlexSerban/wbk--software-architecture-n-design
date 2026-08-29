# retrieval-x: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A standalone retrieval microservice that downstream apps call instead of each rolling their own "embed the query, hit a vector DB, stuff top-k into a prompt." It returns ranked chunks **with source citations**, from a pipeline that can be A/B'd stage-by-stage — naive vector, hybrid (BM25 + vector fused with Reciprocal Rank Fusion), hybrid + rerank — and that **publishes a precision / recall / latency table** so nobody has to take "hybrid is better" on faith.

This is not a chatbot. It is not a generator. It does not train models. It retrieves, reranks, cites, and measures. The generator, if any, lives downstream and is a consumer of whatever this service actually returned, including the cases where it returned nothing useful.

## Business Context
- **Consumers**: any internal app that currently does naive top-k vector search and then pretends the LLM will "figure it out." Support bots, internal search, agent tools, RAG chat. They want a contract they can plug into, not a notebook they have to copy.
- **Corpus owners**: teams that own the documents being searched. They will not agree on chunking, they will not keep metadata clean, and they will ask why a SKU search returned a semantically similar but wrong product. That last complaint is why BM25 is in the default path.
- **Operator**: a small platform / search / ML team that now owns a shared service, two indexes that can silently diverge, a reranker that is either a GPU or a vendor invoice, and an eval set that goes stale the week after it is labeled.
- **Organizational reality**: every team currently believes their vector search is "fine." There are no shared relevance judgments. There is no agreed latency SLA. "Add a reranker" will be proposed as a one-sprint ticket. It is not.

This project is adjacent to, and deliberately narrower than, [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md). That design is about serving ~50 million documents under a sub-second p99 with freshness and shard-tail physics. This design is about **retrieval quality tuning** as a product: hybrid fusion, a swappable reranker, citations, and an honest ablation table. If you need both, compose them. If you only need one, pick the constraint you actually have.

## The Defining Constraints

Two constraints, neither of which is the RRF formula.

### 1. Rerank is O(top-N) and will blow the latency budget if N and the model are vibes

A bi-encoder (the embedding model used for vector search) encodes query and document independently. A cross-encoder jointly encodes `(query, document)` and produces a relevance score. That joint pass is why rerankers work, and why they are expensive.

| Choice | What you pay | Typical failure mode |
| --- | --- | --- |
| Local cross-encoder, CPU, N=50 | Hundreds of ms to multiple seconds | "We added rerank and p95 exploded" |
| Local cross-encoder, GPU, N=20–50 | Tens to low hundreds of ms, plus a GPU that must stay warm | Cold-start after scale-to-zero; batching under-utilization at low QPS |
| Cohere `/rerank` (or equivalent hosted) | Network RTT + vendor latency + **per-query $** | Timeout, 429, regional outage, bill surprise; the request cannot wait for a job queue |
| No-op reranker (fused-only) | ~0 ms | The A/B control. If hybrid+rerank cannot beat this on quality *and* stay inside the SLA, the reranker does not ship |

"Just add a reranker" is not an architecture decision until **N**, **model**, and **p95 budget** are numbers. See [System Design — Latency Budget](./03_system_design.md#6-latency-budget) and [ADR-005](./04_architecture_decision_records.md#adr-005).

### 2. A published A/B table requires labeled relevance judgments, which do not exist yet

Precision, recall, MRR, nDCG are not properties of a pipeline. They are properties of a pipeline **against a judged query set**. Without judgments, the "table" is latency-only, which is useful and insufficient: you can prove hybrid+rerank is slower, and you cannot prove it is better.

| Asset | Who produces it | Honest cost |
| --- | --- | --- |
| Query set (50–200 real queries, not synthetic) | Operators + downstream app owners, sampled from production or from the actual product FAQ | Days of collection, not an afternoon |
| Relevance judgments (binary or 0–3 graded, per query × candidate) | Domain experts, not the engineer who built the index | The actual long pole. Expect disagreement. Expect "it depends." |
| Pooling (union of candidates from each variant so the judge is not scoring only what vector-only already found) | The eval harness | If you only judge the vector-only top-k, hybrid cannot "win" on documents the baseline never surfaced |
| Re-judgment after corpus or product drift | Same experts, on a cadence | A frozen 2026-Q1 set will lie about 2026-Q3 quality |

**The conclusion, which is not optional:** Phase 0 is judgments and an SLA number, not Docker. Shipping hybrid+rerank before a baseline row exists is how you spend a quarter proving a story you already believed. See [Phased Implementation Plan — Phase 0](./06_phased_implementation_plan.md#phase-0--judgments-contract-sla-before-pipeline-theater).

## Functional Requirements

- **Naive vector retrieval**: the service must expose a vector-only path. This is the baseline in the table, not a deprecated mode to hide. Downstream A/B and the eval harness both need it.
- **Hybrid retrieval**: the service must run BM25 (keyword / full-text) and vector search, fuse with Reciprocal Rank Fusion, and return a fused ranking. Hybrid is the default production path only after the table says it earns that status on the actual corpus. See [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Rerank (optional, swappable)**: after fusion, take top-N and pass them through a reranker. The reranker sits behind an interface. At least three implementations must exist so the interface is not a fiction: **no-op**, **local cross-encoder**, **hosted (Cohere or equivalent)**. Swap is a config change, not a caller change. See [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Citations**: every returned chunk carries source identity sufficient for a downstream UI or a generator to show "this came from X, section Y, version Z." A chunk without a citation is a defect, not a partial result.
- **Published API contract**: versioned HTTP API (illustrative stack: FastAPI). Request names the corpus, the query, `k`, and optionally the pipeline variant. Response is ranked hits + citations + per-stage timing. This is a microservice, not an imported Python package. See [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Offline A/B / ablation harness**: a separately runnable job that executes the judged query set against named pipeline variants and emits the precision / recall / latency table. The table is an artifact, stored and diffable, not a screenshot from a notebook. See [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Degraded rerank**: if the reranker times out, 429s, or is unavailable, the request **returns fused-but-unreranked results** with a flag, rather than 5xx. Retrieval that fails closed on the optional expensive stage is how you take the whole company down for a Cohere blip. See [ADR-005](./04_architecture_decision_records.md#adr-005).
- **No generation**: the service does not call an LLM to answer. If a caller wants RAG, they retrieve here and generate elsewhere. Mixing the two makes latency, cost, and quality undebuggable.

## Non-Functional Requirements

**Latency (starting points, calibrated in Phase 0, not facts):**

| Stage | p50 target | p95 target | Notes |
| --- | --- | --- | --- |
| BM25 | 10–30 ms | 50 ms | Postgres FTS on a corpus that fits; Elastic if it does not. See stack notes. |
| Vector | 15–40 ms | 80 ms | pgvector HNSW on the same "fits in one Postgres" assumption; Pinecone (or equivalent) if it does not. |
| RRF fusion | < 2 ms | < 5 ms | Never the problem. |
| Rerank, local GPU, N=20 | 20–60 ms | 120 ms | Dominated by N and model size. |
| Rerank, Cohere | 80–200 ms | 400 ms | Network + vendor. This number is why Cohere is a quality option, not a latency option. |
| Citation hydrate | 5–15 ms | 30 ms | Must not fetch source blobs from object storage on the query path. |
| **End-to-end, hybrid, no rerank** | **< 80 ms** | **< 150 ms** | The number you can actually sell to a search box. |
| **End-to-end, hybrid + local rerank** | **< 150 ms** | **< 300 ms** | Requires the Phase 0 SLA to permit this. |
| **End-to-end, hybrid + Cohere rerank** | **< 250 ms** | **< 600 ms** | Likely too slow for typeahead; maybe acceptable for "submit question, wait." |

If the consumer's SLA is "p95 < 150 ms including retrieval," hybrid+rerank is probably **out**, or N collapses to something a linear/cheap model can do. That is a product decision made with the table, not a surprise on launch week. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-how-the-answer-changes-under-a-hard-low-latency-sla).

**Reliability:**
- Stateless API processes. Horizontal scale is adding replicas. State lives in the indexes and the chunk store.
- Reranker failure is degraded success, not request failure.
- One index (BM25 or vector) down: serve the other, flag `degraded_retriever`, do not 5xx if the surviving retriever returned hits. Both down: 503. See [System Design — Failure Modes](./03_system_design.md#8-failure-modes).
- Eval harness failure does not page the on-call for serving. It fails the "we may change production ranking" gate.

**Multi-tenancy / multi-corpus:**
- This is a shared microservice from day one. Request names a `corpus_id` (or tenant + corpus). Indexes are isolated per corpus. There is no "search everything we host" default — that is how you leak tenant A into tenant B's prompt.
- Authn/authz: the caller is a service, not a human. Corpus access is an allow-list, not "if you know the id." Details belong in a later security pass; the architecture assumes isolation is a requirement, not a follow-up. See [Risks](./02_architecture_document.md#risks-and-mitigation).

**Inference-only:**
- No training of embedding models, no learning-to-rank, no per-tenant fine-tunes in v1. Rerank is inference against a published cross-encoder or a hosted API. Fine-tuning is a different project with a different data problem.

**Infrastructure (illustrative, not a shopping list):**
- API: FastAPI (sync request/response).
- BM25: Postgres full-text search (`tsvector` / `tsrank_cd`) **or** Elasticsearch/OpenSearch if the corpus outgrows one Postgres. Default assumption: Postgres FTS, because the quality-tuning project should not start by standing up a second search cluster. Revisit when Phase 0 measures corpus size.
- Vectors: pgvector in the same Postgres **or** Pinecone (or equivalent hosted ANN) if recall/latency/size demand it. Default assumption: pgvector, same reason. Pinecone is the escape hatch, not the identity of the service.
- Rerank: sentence-transformers (or equivalent) cross-encoder locally; Cohere rerank as the hosted implementation of the same interface.
- Packaging: Docker. Orchestration: Kubernetes. These are deployment facts, not architecture. They do not appear in the query path diagram as "the clever part."

**What this project is not sized for:**
- 50M documents, sharded HNSW, hedge-the-slow-shard, daily re-embed of 3M chunks. That is the other project. If the corpus is that large, `retrieval-x` is still the *quality* layer; the *capacity* layer is [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md). Pretending pgvector-on-one-node will do 300M vectors is how you confuse the two.

## Core Value Propositions
1. **A contract, not a copy-pasted notebook.** Downstream apps integrate once. Ranking changes behind the interface.
2. **Quality claims are rows in a table.** Naive vs hybrid vs hybrid+rerank, with precision, recall, and latency. A stage that does not earn its keep is not "part of the architecture"; it is a failed experiment that the table is allowed to report.
3. **Reranker is a plugin.** Local GPU vs Cohere vs no-op is an operator choice per corpus, constrained by the SLA, not a rewrite.
4. **Citations are schema, not prompt instructions.** If the chunk cannot name its source, it does not ship.
5. **Degradation over drama.** A slow reranker returns fused results. A down BM25 returns vector-only. The response says so.

## Success Metrics
All numeric targets below are **starting points to be calibrated once the judged set and the SLA exist** (Phase 0), not facts.

1. **A published ablation table exists** with at least the three named variants, on a judged set reviewed by someone who is not the author, with latency measured on the same hardware the service will run on. A table with only latency, or only quality, is incomplete.
2. **Hybrid earns default, or it doesn't.** If hybrid loses to naive vector on the actual corpus (this happens — short, homogeneous, already-semantic corpora), vector-only remains default and hybrid stays a variant. The architecture must survive that outcome. See [ADR-001](./04_architecture_decision_records.md#adr-001).
3. **Rerank go/no-go is explicit.** p95 with rerank is measured against the Phase 0 SLA. If it misses, rerank stays off in production even if nDCG went up. Quality that users abandon because search feels broken is not quality.
4. **Swap drill passes.** Changing reranker implementation is config + a canary, not a pull request that touches the FastAPI handlers. If the "interface" requires a code change in the caller or the query orchestrator, it was not an interface.
5. **Citation completeness = 100%** of returned hits. Hits missing `source_id` / URI / version are counted as defects, not as "metadata TBD."
6. **Eval harness is unattended.** A CI job or a scheduled run produces the table. A notebook that only the author can run is not the harness.

## Business Rules
1. The query path **never** embeds documents, chunks documents, or trains anything. Those are ingest-path jobs (owned by corpus pipelines, possibly the scale project's ingest, not this service's request handler). Query embeds the *query* (or receives a precomputed query vector) and reads indexes.
2. Pipeline variant is an explicit request field or a per-corpus config, never inferred from "whatever is imported this week."
3. Rerank `N` is a capacity and latency control. Raising it is a change that must re-run the table. See [ADR-005](./04_architecture_decision_records.md#adr-005).
4. Scores from BM25 and from cosine/IP **are not comparable** and **are not linearly combined**. Fusion is rank-based (RRF). See [ADR-002](./04_architecture_decision_records.md#adr-002).
5. A production ranking change that was not eval-harnessed against the current judged set is a defect, even if latency improved.
6. Tenant A's chunks are not visible to tenant B, including in eval runs. The eval harness is a client of the same isolation rules.
7. The service does not "fix" a bad chunker. Garbage chunks in, cited garbage out. Chunk quality is an ingest problem; this design will not hide it with a bigger reranker.
