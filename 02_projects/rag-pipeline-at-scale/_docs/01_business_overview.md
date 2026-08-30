# RAG Pipeline at Scale: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A retrieval layer in front of a generator that can serve **~50 million source documents** with **sub-second p99 retrieval**, while source documents keep changing, embedding models get replaced, and quality is judged in production — not only on a frozen eval set.

This is not "RAG as a demo." It is a search system with an LLM sitting on top of it. The retrieval stack is the product. The generator is a consumer of whatever the retriever actually found, including the cases where it found nothing useful.

## Business Context
- **Corpus**: on the order of 50 million source documents — policies, tickets, wiki pages, PDFs, HTML, maybe product catalogs. Heterogeneous length. Heterogeneous change rate. Not a static Wikipedia dump.
- **Consumer**: an answering application (chat, search-with-citations, agent tool) that will be trusted more than it deserves. A fluent wrong answer is worse than a slow one.
- **Operator**: a platform / search / ML team that will own index freshness, embedding-model migrations, and the 3 a.m. "answers got worse" page. That team is the actual user of this design.
- **Constraint the prompt hides**: "50M documents" and "sub-second p99" are stated; document length, query QPS, freshness SLO, multi-tenancy, and whether 50M means *documents* or *chunks* are not. Those unknowns are load-bearing. Phase 0 exists to replace them with measurements. Until then every hardware number in these docs is a **working assumption labeled as such**, not a fact.

## The Math (the actual requirement)

This is the constraint every other document in this project exists to respect. It is not a preference for hybrid search. It is a capacity and latency ceiling.

### Documents are not vectors

| Assumption | Working value | Why it is load-bearing |
| --- | --- | --- |
| Source documents | 50,000,000 | The number in the prompt. Ambiguous (see [Trade-offs §5](./05_tradeoffs_and_honest_assessment.md#5-what-changes-if-50m-did-not-mean-documents)). |
| Mean chunks / document | ~6 (range ~1 for a ticket, ~50+ for a long PDF) | Naive designs index "50M vectors." Real serving cardinality is **~250–350M chunks**. Working number below: **300M**. |
| Embedding dimension | 1536 float32 (common default; 768 is the cheaper alternative) | Memory scales linearly with dim. Halving dim halves RAM, not "quality linearly." |
| Raw vector bytes | `300e6 × 1536 × 4 ≈ 1.84 TB` | This is **payload only**, one copy, no graph, no replicas, no BM25. |
| HNSW graph overhead | ~1.3–1.8× on top of payload | One in-memory float32 HNSW replica lands around **~2.4–3.3 TB RAM**. |
| Replica factor | ≥2 for read HA | Memory and disk double. This is not optional if p99 has to survive a node death. |
| int8 / PQ quantization | ~4× on the vector payload; graph still costs | The realistic way a 300M-vector ANN index fits in a cluster that is not a joke. Recall takes a hit. Measure it. |

**The conclusion, which is not optional:** one "big vector DB" of 50M rows is the wrong capacity model. The serving unit is the **chunk**. The memory unit is **replicas of a graph index**. If Phase 0 measures mean chunks/doc of 15 instead of 6, the cluster you just sized is 2.5× too small and you find out after the first full embed.

### Sub-second p99 is a budget, not a vibe

Retrieval p99 < 1000 ms is the SLO this design owns. Generation tokens are **out of that budget**. Anyone who quotes "time to first token of the LLM" as the retrieval SLO is changing the problem.

A realistic ledger for one query (targets, not promises — see [System Design §6](./03_system_design.md#6-latency-budget)):

| Stage | Budget (p99) | What actually blows it |
| --- | --- | --- |
| Query embed | 20–80 ms | Remote embedding API; cold GPU; oversized query text |
| BM25 + ANN scatter-gather | 40–150 ms | Slowest shard, GC, compaction, unhedged fan-out |
| Fusion (RRF) | < 5 ms | Almost never the problem |
| Cross-encoder rerank of top-N | 30–200 ms | **N too large**, CPU instead of batched GPU, model too big |
| Hydrate chunk text + assemble | 10–40 ms | Fetching full docs from object storage on the query path |
| **Retrieval total** | **< 1000 ms, with margin** | The sum, plus covariance of the tails |

Sub-second is tight **specifically because of rerank and scatter-gather**, not because HNSW "doesn't scale." Adding shards can make the ANN per-shard *faster* and the end-to-end p99 *worse*. That sentence is the scaling strategy. See [Architecture — Scaling](./02_architecture_document.md#scaling-strategy) and [ADR-006](./04_architecture_decision_records.md#adr-006).

### Freshness has a rate, not a flag

If 1% of 50M documents change per day, that is **500,000 documents/day ≈ 3 million chunks/day** to re-hash, and some fraction of those to re-embed and re-index. At 1,000 embeddings/s that is ~50 minutes of embed compute *if* you only touch dirty chunks and the change is uniformly cheap. At 1% of chunks actually changing content (not just parent metadata), it is still a serious daily job. A full rebuild of 300M chunks at 1,000/s is **~3.5 days of continuous embed**, plus a second index build, plus a cutover. "We will re-embed on write" is a product decision with a queue, not a function call.

## Core Value Propositions
1. **Retrieve the right chunks fast enough that generation is the remaining wait.** The SLO is retrieval p99. The architecture spends its complexity there, not on prompt templates.
2. **Hybrid retrieval as default, not as an enhancement ticket.** BM25 catches IDs, error codes, SKUs, statute numbers, and rare proper nouns that embeddings smear. Vectors catch paraphrase. Either alone is a known production failure mode.
3. **Staleness is an SLO, not an incident surprise.** When a source document changes, the time until the new text is searchable is measured, alerted, and traded against ingest cost. "Eventually consistent search" without a number is a shrug.
4. **Quality is watched online.** A golden eval set is necessary and insufficient. Production query mix, score distributions, freshness lag, and downstream abstention/citation failures are first-class signals. Shipping without them is shipping blind.
5. **Embedding-model upgrades are migrations, not config flips.** Mixed-version vectors in one graph silently destroy recall. The design pays for blue-green index generations on purpose.

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0**, not facts.

1. **Retrieval p99 < 1000 ms** at the agreed QPS, measured at the query service, excluding LLM generation. p50 is a vanity metric if p99 is the contract.
2. **Recall@k on a continuously refreshed golden set** stays inside a pre-agreed band after every index or model change. A one-time eval at launch is not this metric.
3. **Freshness lag**: p50 and p99 of (source mutation time → chunk searchable in both BM25 and vector indexes). The number itself is a product choice (minutes vs hours); having no number is a defect.
4. **Empty / low-confidence retrieval rate** does not silently climb. A rising empty-result rate or a collapsing top-1 score distribution is an incident, even if latency is green.
5. **Re-embed waste rate**: fraction of embedding calls whose output is bit-identical (or cosine-identical within epsilon) to the vector already in the index. After the dirty-chunk pipeline works, this should be near zero. If it is not, the "incremental refresh" is a full rebuild in a trench coat.
6. **Operator toil**: embedding-model upgrade and corpus-wide re-chunk are runbooks with a cutover, not a week of heroics. If every model bump is a war room, the blue-green path was not actually built.

## Business Rules
1. The query path **never** embeds, chunks, or fetches source documents from the system of record. Those are ingest-path jobs. Query reads indexes and a chunk store.
2. BM25 and vector retrieval are both required for production traffic. Vector-only is a degraded mode, not the default. See [ADR-001](./04_architecture_decision_records.md#adr-001).
3. A chunk is identified by a stable ID derived from `(doc_id, doc_version, chunker_version, chunk_index)` or by content hash of the chunk text. Re-chunking always produces new IDs; old vectors are deleted, not overwritten in place across a changed boundary. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. Two embedding-model versions **must not** share an ANN graph. Cutover is atomic at query routing, after the new generation is built and shadowed. See [ADR-005](./04_architecture_decision_records.md#adr-005).
5. Rerank candidate count `N` is a latency control, not a quality knob to turn to 200 "because we can." Raising `N` is a capacity change. See [ADR-006](./04_architecture_decision_records.md#adr-006) and the latency budget.
6. An index generation that cannot report freshness lag, coverage (% of source docs with ≥1 live chunk), and golden-set recall is **not allowed to take production traffic**. Monitoring is a launch gate, not a follow-up. See [ADR-007](./04_architecture_decision_records.md#adr-007).
7. "Just add more shards" is not an accepted scaling RFC. A scaling change must name the effect on scatter-gather p99, recall dilution, rerank cost (usually none — that is the point), and freshness. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-just-add-more-vector-db-shards-is-not-a-full-answer).

## Pipeline Consumers
This is internal retrieval infrastructure. Its surface area is operational:

1. **Answering application / generator**: receives top-k chunks (and scores, and source pointers) inside the latency SLO. This consumer will blame the LLM for retrieval misses. The metrics have to make that argument decidable.
2. **Ingest / content owners**: the systems that mutate the 50M documents. They are not in the query path. They *are* in the freshness SLO. A source that cannot emit a reliable change signal forces polling, which is a worse design we may still have to run.
3. **Retrieval operators**: own indexes, embedding jobs, cutovers, and the degradation alerts. If this team needs a data scientist to notice that recall fell 12%, the monitoring design failed.
4. **Evaluation / quality**: owns the golden set, the shadow comparisons, and the rule that a model upgrade does not ship on "it looks better on 40 hand-picked prompts."
