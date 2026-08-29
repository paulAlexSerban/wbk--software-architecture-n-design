# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Hybrid BM25 + Vector over Vector-Only

**Status**: Accepted

**Context**: The default RAG sketch is "embed documents, embed query, nearest neighbors, stuff prompt." At 50M heterogeneous documents the query mix will include SKUs, ticket IDs, error codes, statute numbers, class names, and rare proper nouns. Dense embeddings smear those tokens. They also struggle with negation and exact phrases. A vector-only production default systematically fails a class of queries that BM25 (or any inverted index with a sane analyzer) answers in milliseconds. The opposite failure — BM25-only — misses paraphrase and vocabulary mismatch. Neither failure is theoretical; both show up the first week real users arrive.

**Decision**: Production retrieval always queries a sparse inverted index and a dense ANN index, then fuses ([ADR-002](#adr-002)). Vector-only is a degraded mode when BM25 is down, not the happy path. BM25-only is the degraded mode when the ANN generation is down.

**Consequences**:
- (+) Exact-token recall and semantic recall coexist; the ID-must-win golden probes in [System Design §7](./03_system_design.md#7-production-retrieval-degradation-detection) are actually satisfiable.
- (+) ANN outages degrade quality instead of taking search to zero (and vice versa).
- (–) Two systems to size, staff, and debug. Hybrid is a bill, not a checkbox. See [Architecture — Cost](./02_architecture_document.md#cost-analysis).
- (–) Filters/ACLs must be implemented correctly in *both* backends; one leak is a security incident.
- **Alternative rejected**: "vectors will get good enough." They might, on some corpora, on some models. Betting the v1 architecture on that is how you explain to a support org why ticket `INC-184422` is unfindable.
- **Revisit trigger**: a learned sparse or late-interaction model is measured to dominate *both* legs on this corpus inside the p99 budget. Then it can *replace* a leg, not skip the measurement.

## ADR-002: Reciprocal Rank Fusion over Weighted Score Blending

**Status**: Accepted

**Context**: BM25 scores and ANN inner-products are not in the same units, not stable across corpus growth, not stable across quantization, and not stable across query-length. Teams still write `0.7 * cosine + 0.3 * min_max(bm25)` because it looks like a decision. The weights become folk knowledge and then a production incident when a new embedding model rescales IP.

**Decision**: Fuse with Reciprocal Rank Fusion, `k = 60` unless a gated experiment says otherwise. Do not blend raw or min-max-normalized scores in v1. A learned ranker is a later generation with its own eval, not a YAML coefficient. Mechanics and a worked example: [System Design §4](./03_system_design.md#4-hybrid-retrieval-and-fusion).

**Consequences**:
- (+) Incomparable magnitudes cannot leak into ranking.
- (+) Lexical-only hits still appear in the fused list.
- (–) RRF throws away score calibration; you cannot treat RRF as a probability of relevance. Downstream "confidence" must use rerank scores or an explicit abstain rule, not RRF magnitude.
- (–) Rank-only fusion is slightly worse than a well-trained LTR model *once you have labels*. v1 does not have those labels.
- **Alternative rejected**: per-query min-max then weighted sum. Fragile to outliers; still needs a weight nobody can defend after a model swap.

## ADR-003: Structure-Aware Versioned Chunking over Naive Fixed-Size-Only

**Status**: Accepted

**Context**: Fixed token windows are simple and will still exist as a fallback. Used alone they bisect tables, split "not" from the clause it negates, and orphan a heading from its section. At 50M documents you will not hand-repair chunks. Re-chunking later is a full index migration (new IDs, re-embed, dual-write). The chunker is therefore as load-bearing as the embedding model, and must be versioned like one. Semantic chunking (embed to decide splits) at this scale is a second embedding pipeline used as a preprocessor — unaffordable as v1 default.

**Decision**: v1 chunker is structure-aware (headings, tables, code blocks) with token-window fallback, breadcrumb prefix, and IDs derived from `(doc_id, chunker_version, chunk_index, text_hash)`. Unchanged text hashes skip re-embed; removed IDs are deleted from both indexes. Semantic chunking is out of v1. Details: [System Design §2](./03_system_design.md#2-chunking).

**Consequences**:
- (+) Targeted incremental refresh is possible; a one-paragraph edit is not a 40-chunk re-embed by default.
- (+) Deletes have a precise key. Stale-neighbor incidents become testable.
- (–) A `chunker_version` bump is a migration, not a deploy checkbox. Treat it like [ADR-005](#adr-005).
- (–) Structure-aware logic is corpus-specific (PDF vs HTML vs tickets). Phase 0 must sample extract quality; the chunker cannot save a broken extractor.
- **Alternative rejected**: one global 512-token slide with 0 overlap "to save cost." Saves embed dollars; spends quality forever.
- **Alternative rejected**: semantic chunking as default. Pays embed cost twice; couples split decisions to a model you will also want to change.

## ADR-004: Async Dirty-Chunk Re-embed over Synchronous Write-Path Embedding

**Status**: Accepted

**Context**: Embedding on the document-write path makes ingest latency equal to model latency and makes source connectors stall when the GPU fleet is busy. Embedding on the query path ("retrieve, if stale re-embed") makes p99 a function of the embed model and turns a cache miss into an SLO miss. Both are common demo patterns. Neither survives 50M documents with a freshness SLO and a sub-second retrieval SLO.

**Decision**: Mutations enqueue dirty chunk IDs. Embedding workers drain the queue asynchronously. Query serving reads indexes only. Freshness lag is the SLO that admits the asynchrony is real. See [System Design §3](./03_system_design.md#3-embedding-refresh).

**Consequences**:
- (+) Query p99 is isolated from embed throughput.
- (+) Incremental cost tracks change rate, not corpus size, *if* hashing works ([ADR-003](#adr-003)).
- (–) Answers can be stale. This is disclosed as an SLO, not a surprise. If the product needed "searchable in 100 ms after save," this ADR is the wrong one — and the hardware bill would be different.
- (–) Queue backpressure policy becomes a product decision (incremental vs generation-build priority).
- **Alternative rejected**: synchronous embed-on-write. Turns every source burst into an ingest outage.
- **Alternative rejected**: embed-on-read if hash mismatches. Turns p99 into a lottery.

## ADR-005: Blue-Green Index Generations, Never Mixed-Version Graphs

**Status**: Accepted

**Context**: Upgrading an embedding model (or dimension, or similarity, or sometimes even pooling) changes the geometry. HNSW will still return neighbors for a query vector from the new model against old-document vectors. Those neighbors are **not** "slightly worse." They are a different space. In-place upserts of a new model into an old graph are a silent recall collapse — latency green, golden set maybe still partly green if some lucky lexical overlap remains via BM25, users reporting "the AI got dumb."

**Decision**: Every embedding model (and any incompatible index build) is a named `IndexGeneration`. Build N+1 to completion beside N; shadow; cut query routing atomically; keep N for rollback; destroy N. Mixing vectors from two models in one ANN graph is forbidden. Query embedder `model_id` must match `active_generation`. Mechanics: [System Design §3.5](./03_system_design.md#35-blue-green-generation-swap).

**Consequences**:
- (+) Model upgrades become a runbook with a rollback, not a hope.
- (+) Shadow comparison is possible because N still serves.
- (–) Peak RAM/disk is roughly **another full ANN replica set** during the window. Finance must see this; otherwise the team will try in-place swaps to "save money" and will ship ADR-005's failure mode.
- (–) Full re-embed calendar (days) is on the critical path of every model change. Choose models less often; measure more before the rebuild.
- **Alternative rejected**: dual-model query-time averaging. Doubles query embed cost and still needs two indexes to be coherent.
- **Alternative rejected**: "rebuild in place, take a maintenance window." At this scale the window is days. Blue-green exists so production stays up.

## ADR-006: Quantized ANN + Hedged Scatter-Gather with Bounded Fan-Out over "Add More Shards"

**Status**: Accepted

**Context**: The amateur scaling move at 300M vectors is to increase shard count until each graph fits and assume p99 follows per-shard latency down. Scatter-gather waits on the slowest shard; p99 of `max(L_1..L_S)` grows with S. Shards also do not reduce rerank cost, do not drain a stale embed queue, and dilute recall if per-shard K is not retuned. Memory pressure has better first responses: quantization, then replicas for QPS, then shards until a replica *fits*, with deadlines and hedges. See [Architecture — Scaling](./02_architecture_document.md#scaling-strategy) and [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-just-add-more-vector-db-shards-is-not-a-full-answer).

**Decision**:
- Fit working set with **quantization** first (measure recall).
- Scale **replicas** for QPS and hedging targets.
- **Shard** only to keep a replica's graph comfortably in RAM / off-heap, with a cap on S justified by the [latency budget](./03_system_design.md#6-latency-budget).
- Query plane: per-attempt deadlines, hedges, optional partial results. Hash sharding in v1; no semantic routing.
- Rerank N is a separate capacity lever; shard count must not be used as a proxy for it.

**Consequences**:
- (+) p99 has a chance of surviving growth.
- (+) Recall impact of quantization is explicit and measured, unlike the implicit recall damage of oversharding + tiny per-shard K.
- (–) Quantization costs some recall@k. We accept that over an unbounded shard farm.
- (–) Hedging costs extra QPS. Provision replicas for it.
- **Alternative rejected**: "just add more vector DB shards" as the scaling RFC. Incomplete. Sometimes actively harmful.
- **Alternative rejected**: semantic shard routing in v1. A mis-routed query is a silent miss at 50M-doc scale you will not debug from a single example.

## ADR-007: Continuous Production Degradation Monitoring over Eval-Time-Only Gates

**Status**: Accepted

**Context**: Offline eval is necessary. It is also a snapshot of a corpus and a query set that started dying the day after they were frozen. Retrieval at this scale fails in ways eval will not see: embed queue stuck (stale policies still ranking), missed deletes, query-embedder/model mismatch, BM25 analyzer change, one tenant's filter, score-distribution shift after compaction, query-mix drift. The scenario specifically asks how degradation is detected **in production**. "We have an eval set" is not an answer. An index generation that cannot report freshness lag, coverage, and golden-hit against **prod** is not allowed to take traffic. See [System Design §7](./03_system_design.md#7-production-retrieval-degradation-detection).

**Decision**: Quality observer is a launch gate. Required online signals: freshness lag, coverage / embed holes, empty and low-score rates, score-distribution drift, continuous golden probes (including ID-must-win and recently-edited docs) through the production query service, shadow comparison on cutover, downstream proxies as corroboration only. Eval notebooks do not replace these.

**Consequences**:
- (+) "Answers got worse" becomes a diff across metrics instead of a war room of opinions.
- (+) Cutover has a rollback criterion other than Twitter.
- (–) Golden sets rot; they must be curated. A stale golden set that stays green while users churn is itself a failure mode — include living queries.
- (–) Logging and probing touch production queries and corpus slices; treat observability as sensitive as the data.
- **Alternative rejected**: quarterly offline nDCG as the quality SLO. Latency will still page. Quality will not, until a VP is in the thread.
- **Alternative rejected**: LLM-as-judge on 100% of traffic as the SLO. Cost, lag, and judge drift. Sample it.
