# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

These decisions lock **naive** as a property of the system, not as a synonym for "unfinished." Reversing any of ADR-001, ADR-003, or ADR-006 inside this repo ends the baseline and starts a different project.

## ADR-001: Fixed / Recursive-Size Chunking over Structure-Aware or Semantic Chunking

**Status**: Accepted

**Context**: Production RAG quality is often decided at split time. Headings, tables, and negations that sit on a window boundary become unrecoverable by a better embedding model. The at-scale design ([prj--rag-pipeline-at-scale ADR-003](../../prj--rag-pipeline-at-scale/_docs/04_architecture_decision_records.md#adr-003)) therefore treats the chunker as a versioned compiler. This project is the opposite number: a baseline whose documented defect is **chunk-boundary bleed**. Building the good chunker here would make later "structure-aware beats naive" tables circular.

Semantic chunking (embed sentences, split on similarity) is a second embedding pipeline used as a preprocessor. At ~400 chunks the dollar cost is small; the conceptual cost is large: the baseline would depend on the same model family it is trying to measure.

**Decision**: v1 uses a **fixed-size window or a recursive-character splitter with overlap**, parameters frozen in Phase 0 and recorded on `ingest_batch`. No heading walker, no parent-child index, no semantic splits. A filename prefix on each chunk is the maximum metadata decoration allowed. Mechanics: [System Design §2](./03_system_design.md#2-chunking).

**Consequences**:
- (+) The baseline is actually naive. Bleed probes in the eval set can fail for a real reason.
- (+) Ingest is explainable in an interview in one minute.
- (–) Tables, code blocks, and "not X" constructions will split. Some eval questions will be unanswerable even with perfect retrieval of the fragments.
- (–) Changing `chunk_size` after Phase 5 invalidates the baseline; it is a new experiment, not a tweak.
- **Alternative rejected**: Structure-aware splitting "just for PDFs." That is §1.4 leaking in through the format that needs it most. If PDFs are unusable, **narrow the corpus** in Phase 0 (markdown-only) rather than quietly upgrading the chunker.
- **Alternative rejected**: Semantic chunking as default. Couples splits to a model you will also want to swap; contaminates the retrieval baseline.
- **Revisit trigger**: none inside this project. Revisit in `rag-hierarchy` / `graph-rag` on the **same** corpus.

## ADR-002: pgvector on Postgres over a Managed Vector DB (Pinecone et al.)

**Status**: Accepted

**Context**: The roadmap stack lists pgvector/Pinecone. At ~400 vectors, a dedicated ANN SaaS is an extra network hop, an extra bill, an extra ACL surface, and a way to pretend the problem is "which vendor" instead of "which retrieval algorithm." The at-scale project **rejects** pgvector as a 300M-vector serving store. Both rejections are the same principle: **match the store to the working set**.

HNSW tuning, namespaces, and serverless vector SKUs do not fix cosine ≠ relevance.

**Decision**: **Postgres + pgvector** is the only data store. Documents, chunks, vectors, ingest batches, and query logs live there. Pinecone (or Qdrant/Weaviate) is an allowed *mental* alternative for "what would I swap Retrieval's backend to," not the v1 default. Sequential scan is an acceptable query plan. An HNSW index is optional infra-rep decoration, not a quality lever.

**Consequences**:
- (+) One database to run in Compose and in k8s. Transactions can flip `active` ingest batch atomically.
- (+) Query logs and chunks join without a second product.
- (+) The later conversation "why not pgvector at 300M" is stronger because this project used pgvector *when it was right*.
- (–) Operators who wanted "I used Pinecone" on a resume get a less fashionable line. The architecture story is better.
- (–) pgvector skills do not transfer 1:1 to a sharded ANN ops job. That is fine; this is not that job.
- **Alternative rejected**: Pinecone (or equivalent) as default "because the prompt mentioned it." Adds a vendor to a laptop-scale problem. Use it in a later swap experiment if you need a vendor-agnostic Retrieval interface — behind the **same** chunk-list contract, as a Phase-optional spike, not as v1.
- **Alternative rejected**: FAISS/Chroma files on disk as the system of record. Fine for a notebook; hostile to three services and a query_log join.
- **Revisit trigger**: working set leaves the [ceiling](./01_business_overview.md#where-the-ceiling-actually-is). Then this whole project is the wrong project, not "time to add Pinecone to naive RAG."

## ADR-003: Vector-Only Top-k, No Hybrid Search, No Rerank

**Status**: Accepted

**Context**: The default blog RAG is embed-query, nearest neighbors, stuff prompt. That *is* this system. Hybrid BM25+vector and a cross-encoder reranker are the first things a serious retrieval design adds — and the first things that would make this baseline dishonest. The failure modes "exact tokens smear" and "cosine ≠ relevance" only exist as measured facts if we refuse those features.

A similarity cutoff (`score > 0.75`) is a one-line reranker with an uncalibrated threshold. It is also rejected.

**Decision**: Retrieval is **one query embedding, one pgvector top-k, rank order as returned**. No BM25, no RRF, no cross-encoder, no keyword prefilter, no score threshold. k is a frozen config with a small cap. [System Design §3](./03_system_design.md#3-embedding-and-store) and [§4.3](./03_system_design.md#43-empty-retrieval).

**Consequences**:
- (+) Phase 5 precision@k is a real naive number. §1.1 can publish a delta.
- (+) Retrieval service internals stay small enough that the contract (chunk list) is the interesting part.
- (–) Exact-token eval probes are expected to fail. The demo will look worse than a grep.
- (–) Distractor-heavy corpora (many architecture docs sharing vocabulary) will look especially bad. That is representative, not unlucky.
- **Alternative rejected**: "Add BM25 but don't call it hybrid." It is hybrid. It belongs in `retrieval-x`.
- **Alternative rejected**: A tiny reranker "just for the demo question." Overfits the demo; destroys the baseline.
- **Revisit trigger**: none here. §1.1 is the revisit.

## ADR-004: Three Microservices over a Monolith (Pedagogical Boundary Cut)

**Status**: Accepted

**Context**: At ~50 documents and one user, a single process (ingest functions + retrieve functions + generate functions + one Postgres) is the operationally cheaper system: one deploy, one set of logs, no intra-cluster HTTP, no version skew between Retrieval's embedder and Ingestion's embedder. The roadmap nevertheless asks for **clean microservice boundaries** (ingestion / retrieval / generation) and Docker/k8s reps.

Pretending the split is required by load is a lie. Pretending a monolith is "not architecture" is also a lie. The honest move is to **cut the services on replaceability**, pay the ops tax, and write the tax down.

**Decision**: **Three deployable services** with the contracts in [System Design §5](./03_system_design.md#5-service-contracts-logical): Ingestion writes the index; Retrieval is the only vector reader; Generation is the only LLM caller and owns `POST /ask`. No fourth BFF, no queue, no service mesh. Compose and k8s run exactly these three plus Postgres.

The split exists so later tiers can **replace Retrieval** (hybrid/rerank) or **wrap Generation** (faithfulness) without forking a ball of scripts. It does **not** exist to independently autoscale them.

**Consequences**:
- (+) Replaceable seams. Interview diagram is honest: three boxes, one database.
- (+) Failure domains match the APIs (embed outage vs LLM outage vs extract bugs).
- (–) **Ops cost is strictly worse than a monolith at this scale.** Three health checks, three image builds, embed-model config that must match across Ingestion and Retrieval, more ways to bind a public Service by accident.
- (–) Latency: one extra hop (Generation → Retrieval). Irrelevant next to LLM time; still a hop to debug.
- **Alternative rejected**: Monolith "until we need to scale." This project's consumer is the roadmap, which needs the seam now. A monolith is the right *product* choice and the wrong *portfolio-baseline* choice. If building this for a real internal 50-doc tool with no later tiers, **choose the monolith** and ignore this ADR.
- **Alternative rejected**: One microservice per file type, per embed provider, or a separate "orchestrator" service. Sprawl without a replaceability story.
- **Revisit trigger**: if even Compose is too much to operate while iterating on eval questions, develop against a single process **with the same module boundaries**, then split at Phase 4. Module cuts must precede container cuts. Phase 4 still ships three services.

## ADR-005: Synchronous Request/Response Generation over Streaming

**Status**: Accepted

**Context**: Streaming tokens is the expected UX for chat. It also complicates timeouts, query logging (the answer does not exist until the stream ends), k8s ingress idle timeouts, and any future faithfulness check that needs the full completion. This is a Document Q&A baseline, not a ChatGPT clone. Wait-for-full-answer is acceptable for a demo of retrieval quality.

**Decision**: `POST /ask` **blocks until the completion is finished** (or fails). No SSE, no websocket, no token iterator to the client. Time-to-first-token is not a metric.

**Consequences**:
- (+) Logging, error handling, and the canned empty-retrieval path stay simple.
- (+) Ingress and service timeouts are ordinary request timeouts.
- (–) A 20-second generation looks like a hung UI unless the client shows a spinner. That is a UI problem, not a reason to stream in v1.
- (–) Cannot cancel mid-generation from the client in a first-class way (the HTTP client can disconnect; whether the LLM call is aborted is provider-specific and out of scope).
- **Alternative rejected**: Stream because "all LLM apps stream." Contaminates the baseline with a UX feature that does not change retrieval quality.
- **Revisit trigger**: a UI-heavy follow-on. Streaming can be added **behind the same** Generation contract without changing Ingestion/Retrieval. It is still not a v1 requirement.

## ADR-006: Short-Circuit on Empty Retrieval; No Similarity Cutoff on Non-Empty Top-k

**Status**: Accepted

**Context**: Two failure modes fight. (1) Empty index or failed retrieval: calling the LLM anyway produces ungrounded answers with RAG branding. (2) Non-empty top-k of *irrelevant* neighbors: this is the normal naive-RAG case; skipping the LLM would hide the unfaithful-generation failure mode we need to measure.

A cosine threshold tries to distinguish (2) from "good enough" and becomes an uncalibrated policy.

**Decision**:
- **Zero hits** (no active batch, empty table, or degenerate failure): **do not call the LLM**; return a canned "not in the knowledge base."
- **k hits**, regardless of scores: **call the LLM** with stuffed context. No cutoff.

**Consequences**:
- (+) Empty-index demos cannot silently become ChatGPT-with-a-logo.
- (+) Phase 5 still sees unfaithful answers when retrieval is non-empty but wrong — the interesting case.
- (–) There is no "I'm not confident" retrieval abstain. Low scores still generate. That is naive.
- **Alternative rejected**: Always call the LLM. Makes RAG vs parametric memory unauditable.
- **Alternative rejected**: `if max_score < τ then abstain`. A hidden reranker. If Phase 5 *studies* τ, it is an appendix experiment, not production config in this project.
- **Revisit trigger**: §1.2 corrective RAG, which is allowed to abstain or re-retrieve after a relevance grade.

## ADR-007: Full-Folder Re-ingest over Incremental Dirty-Chunk Updates

**Status**: Accepted

**Context**: Incremental refresh is the load-bearing path at 50M documents. At 50 documents it is extra state (watermarks, hash diffs, tombstones) to save a few dollars of embeddings and a few minutes. Implementing it here would either be toy-incorrect (miss deletes) or a copy of the at-scale design, which again contaminates the baseline.

**Decision**: The only write path is **walk the corpus root, build a new ingest batch, flip `active`**. "I changed one file" means re-run ingest. No filesystem watcher required. A checksum *log* at start is allowed; a daemon is not.

**Consequences**:
- (+) Delete/replace semantics are obvious. Previous batch is a rollback.
- (+) No false claim of a freshness SLO.
- (–) Operator must remember to re-ingest. Stale answers are a named failure mode ([§9.6](./03_system_design.md#96-static-index--no-incremental-refresh)).
- (–) Habit does not transfer to production refresh engineering — by design; that engineering lives in the at-scale project.
- **Alternative rejected**: Upsert-by-filename on each drop. Easy to get delete-misses (removed files stay in the index forever).
- **Alternative rejected**: Cron re-embed every N minutes. Hides staleness behind spend; still not incremental correctness.
- **Revisit trigger**: corpus or change-rate leaves the envelope. Then stop this design; do not grow a toy CDC into it.
