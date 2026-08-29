# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone wires pgvector.

RRF is not the hard part. A judged query set, a latency SLA that survives contact with a cross-encoder, and an interface that still works when Cohere is having a day: those are the hard parts.

## 1. What I would build

A **retrieval quality service**, not a chatbot and not a second copy of the 50-million-document scale design.

- **A versioned HTTP API** (`POST /v1/retrieve`) that returns ranked chunks with citations and per-stage timings. Downstream apps integrate once. See [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Three named variants** on that API: `naive_vector`, `hybrid` (BM25 + vector + RRF), `hybrid_rerank`. The first is the baseline, not a relic.
- **Postgres as the default spine**: chunk store + FTS + pgvector in one database, one transaction, one backup story. Pinecone and Elastic are adapters for when Phase 0 measures that this box will not do — not the identity of the project.
- **A reranker strategy interface** with three implementations that actually exist: no-op, local cross-encoder, Cohere. Swap is corpus config. Fail open to fused results. See [ADR-003](./04_architecture_decision_records.md#adr-003) and [ADR-005](./04_architecture_decision_records.md#adr-005).
- **An eval harness that is a job**, calling the same API, writing a precision / recall / latency table with git sha and config snapshot. This is equal priority to the pipeline. A pipeline without the table is a blog post.
- **Citations as required schema**, hydrated from the chunk store, never from object storage on the query path.
- **Docker**, then **Kubernetes in a later phase**, not as a prerequisite for measuring nDCG.

Bootstrap is judgments and an SLA number (Phase 0), then a vector-only row so the table has a denominator (Phase 1). Hybrid and rerank that skip those phases are how you spend a quarter confirming a slide.

If Phase 0 discovers the corpus is tiny, queries are FAQ-like, and vector-only already has P@5 = 0.9, this whole hybrid+rerank stack is **optional complexity**. Build the harness and the contract anyway; do not turn on BM25 and a GPU to chase a point of nDCG you cannot measure. The architecture is allowed to conclude "ship naive_vector."

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**A guarantee that hybrid+rerank wins.** The table may show hybrid losing, or rerank winning 3 points of nDCG at 4× p95. Both are valid outcomes. The second is a no-go if it misses the SLA.

**Sub-100 ms p95 once a cross-encoder or Cohere is on the path.** If someone needs typeahead, they get hybrid-without-rerank or vector-only. See [§4](#4-how-the-answer-changes-under-a-hard-low-latency-sla).

**Training.** No fine-tuned embedder, no learning-to-rank, no per-tenant reranker. Inference on published models and a hosted API. LTR is a different team with a different labeling budget.

**Generation in-process.** No "retrieve-and-answer" endpoint. Mixing them makes it impossible to tell whether the model hallucinated or the retriever missed. Downstream can RAG; this service will not.

**Async rerank / job queues on the retrieve path.** Wrong shape for a synchronous tool call.

**Fail-closed on rerank.** Cohere is not in the availability TCB.

**Linear score fusion, semantic query cache, and LLM-as-primary-judge.** All three look clever; all three rot or measure the wrong thing. Exact query cache is allowed; semantic cache is a correctness hazard and out of scope.

**Solving 50 million documents.** Sharding, HNSW RAM, ingest freshness SLOs, replica hedges — [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md). This project's default stack (one Postgres) will fall over there. Do not copy those numbers into this sizing; do not copy this project's pgvector complacency into that one.

**A library that five apps import.** The hop is the tax of having one table. See [ADR-004](./04_architecture_decision_records.md#adr-004).

**k8s-as-the-first-deliverable.** Orchestration does not label qrels.

**Raising N to hide a bad chunker.** Garbage chunks in, cited garbage out. Ingest owns that.

**Silent variant rewriting.** If rerank degrades, flags say so; `variant_used` does not pretend you ran `hybrid` when the caller asked for `hybrid_rerank`. The harness would lie otherwise.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with standing up empty indexes. A no on GPUs must not block the vector baseline. A no on judgments **does** block quality claims.

Ask downstream consumers:

1. **A latency SLA as a number** (p95 retrieve, excluding generation). "Fast" is not a number. Without it, N and Cohere vs local cannot be decided. Expected: they will not have thought about it; make them pick 150 vs 300 vs 600 ms with UX consequences attached.
2. **The actual query mix.** Logs (redacted), top intents, lexical vs semantic. Hybrid's value is not uniform.
3. **Who can label.** Names, hours, a rubric. This is the expensive ask. Expected: "can't you just use GPT to judge?" Answer: not as the v1 gate. See [ADR-006](./04_architecture_decision_records.md#adr-006).

Ask corpus owners:

4. **Source identity that can become a citation** (stable id, URI, version). If the "corpus" is a pile of PDFs with no URLs, citation is a fiction and the UI will fake it.
5. **Permission to send passages to Cohere** (or not). If not, local CE only — and someone pays for GPU or accepts CPU latency.
6. **Chunking they will live with.** This service will not fix a 2,000-token chunk that buries the answer.

Ask platform / finance:

7. **GPU vs vendor $.** A warm GPU at low QPS is mostly idle spend; Cohere is mostly per-query spend. Show both estimates. Expected: they want Cohere until the bill, or a GPU until utilization is 4%. Pick per corpus; do not run both on every query.
8. **A shared dev instance of retrieval-x** so app teams do not bypass the service.

What I would **not** ask for: a custom fine-tune, Elastic+Pinecone+Weaviate "to be vendor-neutral," a new warehouse for eval, or the scale project's hardware on a 200k-chunk corpus.

## 4. How the answer changes under a hard low-latency SLA

The hourly reranker does not get faster because the product manager said 150 ms. **Cross-encoder cost is O(N) forward passes; Cohere cost is a network round trip you do not own.**

Assume the Phase 0 SLA is **p95 retrieve < 150 ms**, including query embed, excluding generation.

| | SLA p95 ≥ 300 ms ("submit and wait") | SLA p95 < 150 ms ("search box / tool loop") |
| --- | --- | --- |
| Production default, likely | `hybrid` or `hybrid_rerank` (local GPU, N≈20) if the table agrees | `hybrid` **without** rerank, or even `naive_vector` |
| Cohere on the default path | Maybe, if p95 measured < SLA with headroom | Almost certainly **no** — vendor p95 alone can eat the budget |
| Local CE | Yes, N capped, GPU, batch | Only if a tiny model + N≤10 is measured in budget; treat as unlikely until proven |
| What rerank becomes | The quality feature you sold | An eval-only variant, a slow endpoint, or a post-click "refine" — not the hot path |
| What I would still ship | Full interface, no-op, fused fallback | Full interface, no-op, fused fallback. Do not delete the reranker because it is off; you need it the day the SLA is relaxed |
| Hybrid | Still worth measuring; BM25 is cheap vs CE | Still the first thing to A/B; it often fits 150 ms |

What I would change in the design under 150 ms:

1. **Default `variant=hybrid`**, `reranker_id=noop`. Rerank is config for a separate `hybrid_rerank` that callers opt into only on flows that can wait.
2. **N is not a quality knob.** If someone proposes N=100, that is a proposal to miss the SLA.
3. **Query embed must be local.** A remote embed API is already a 150 ms conversation.
4. **Hedge less, log more.** You do not have tail budget for heroic retries.
5. **Say no to k8s sidecars that add hops** before the table exists. Extra mesh latency is real.

What I would still not do: quantized 4-bit CE on CPU as a wish and a prayer without measuring; "rerank asynchronously and stream the answer then the citations"; dropping BM25 to save 15 ms before looking at the table (those 15 ms are often under the vector tail anyway).

### How the answer changes at very large corpora

If the corpus is tens of millions of **documents** (hundreds of millions of chunks), this project's default spine is the wrong capacity model. Memory, shard tails, ingest lag, and replica strategy are specified in [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md).

What carries over unchanged:

- Named variants and a judged table
- RRF, not linear score mash
- Reranker interface, fail-open, N as latency control
- Citations as schema
- Microservice contract

What does not carry over:

- "Postgres FTS + pgvector will be fine"
- The latency ledger in [System Design §6](./03_system_design.md#6-latency-budget) (scatter-gather and hydrate will dominate before RRF)
- Single-node assumptions in failure modes (Postgres as SPOF was acceptable here; there it is not)

Do not fork this design into a sharded ANN project by accident. Compose: scale project owns indexes and freshness; `retrieval-x` owns fusion, rerank policy, contract, and eval discipline — or fold those behaviors into the scale query service and **keep the ADRs**. Two query orchestrators is how you debug ranking twice.

## 5. Brutal summary

The clever design is not Reciprocal Rank Fusion. The clever design is **refusing to ship a reranker you have not timed, refusing to claim hybrid quality you have not judged, and refusing to take search down when the expensive stage fails.**

If the judged set says vector-only is enough and the SLA is tight, this service is a thin, well-logged ANN wrapper with citations and a table that has one row. That is a successful project. If the judged set says hybrid+local-CE wins inside 300 ms p95, you turn those stages on because the table said so, not because a reference architecture did.

Either way: label the queries first. Pin the SLA second. Ship naive_vector third. Everything else is a gated increment that the table is allowed to reject.
