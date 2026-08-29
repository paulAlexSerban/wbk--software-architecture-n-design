# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone buys a 3 TB RAM fleet or promises "sub-second RAG over 50 million docs."

The math, once: **50 million documents are not 50 million vectors.** At ~6 chunks/doc the serving index is ~300 million embeddings. Raw 1536-d float32 is ~1.84 TB *before* the HNSW graph, replicas, a second generation for model upgrades, and the BM25 cluster. Sub-second p99 is a **budget** that rerank and scatter-gather will spend. Designing "a sharded vector DB plus an LLM" is refusing to do that arithmetic.

## 1. What I would build

A **dual-index retrieval funnel with an async freshness plane**, not a chatbot with a plugin.

- **Versioned, structure-aware chunker** writing a chunk store keyed so edits and deletes are diffs, not full-document re-embeds by default. Extraction quality is in front of this; I would spend unfashionable time on PDFs/tables because no ANN recovers soup.
- **BM25 and ANN both in the query path**, fused with RRF, filters applied inside both backends. Vector-only is a weekend demo and a weekday incident.
- **Dirty-chunk embed queue** off the query path. Freshness lag is an SLO with a number (product choice; I would start the conversation at "tens of minutes p99," not "real-time," unless they fund a different fleet).
- **Quantized, replicated ANN** sized for **chunks × dim × replicas × generations**, with hash sharding only as far as a replica must shrink. Hedged scatter-gather. Bounded rerank N on a GPU batcher. Query embed local or aggressively cached — a remote embed API in the p99 path is how you miss 1000 ms without ever touching HNSW.
- **Index generations** for every embedding-model (and chunker) change: build beside, shadow, cut over, keep rollback, then destroy because RAM is the bill.
- **Quality observer from day one of serving**: freshness, coverage, holes, score drift, golden probes on **prod** (ID-must-win + recently-edited docs + a living slice of real queries), shadow diffs. This is not a v2 dashboard.

If Phase 0 discovers the corpus is 50M *short* documents at ~1.2 chunks and 200 QPS of easy FAQ traffic, this looks slightly heavy. Build the *seams* anyway (chunk IDs, generations, hybrid, metrics). Shrink the cluster. Do not shrink the design into "one pgvector table" and spend the next incident re-adding everything the seams were for.

## 2. What I would give up

Be explicit. These are not "later" disguised as principles. Some are never in this design.

**Perfect real-time freshness.** Async re-embed means a document can be wrong in search for minutes (or hours, if the queue is on fire). Query-time re-embed would steal the p99 SLO. Pick one; this design picks retrieval latency and *observes* staleness.

**Guaranteed 100% recall.** ANN is approximate. Quantization makes it more so. Chunking drops context. Sharding + deadlines will omit a slow shard. Hybrid + rerank recovers a lot; it does not recover "the answer was in a footnote the extractor skipped." Anyone selling 100% recall at 300M vectors is selling a full scan.

**Rerank of large candidate lists.** N=200 cross-encoder is a quality fantasy and a latency fact. Quality work after N≈32–50 belongs in chunking, hybrid, and the model, not in N.

**One index forever.** Model upgrades and chunker upgrades are migrations that temporarily **double** ANN footprint. If that cost is unacceptable, the honest product constraint is "we rarely change models," not "we will swap in place."

**Semantic shard routing in v1.** It is a recall foot-gun. I would give up the theoretical fan-out win.

**Semantic chunking in v1.** I would give up the paper. I will not pay a second full embed to decide splits until structure-aware + windows are proven insufficient.

**pgvector (or "the existing Postgres") as the 300M serving store.** Prototype yes. Production working set of quantized HNSW replicas no. Giving this up is how the first OOM is avoided.

**Eval-set-only quality.** A green notebook is a gate, not a SLO.

**Unfiltered "just retrieve then filter ACL in the app."** Giving this up is non-negotiable. Post-filtering top-K is a data leak and a recall hole.

**The fantasy that more shards fix quality.** If the chunker is wrong, S=256 copies of wrong.

**Cheap embedding-model experiments in prod.** Each serious candidate is days of embed + build + shadow. Lab on a downsampled corpus; promote a winner with a generation, not with five concurrent models.

## 3. Cost, in the units that actually hurt

**RAM, not API invoices, is the scary number.**

- One full-precision HNSW replica of ~300M×1536-d is multi-TB. Quantization brings a replica into a "large cluster" shape; **two replicas × two generations** during cutover is the check you write. Teams that only quote 1.84 TB of payload are lying by omission.

**Embed dollars are often smaller than the narrative, and still easy to waste.**

- A full 300M-chunk pass at ~400 tokens on a cheap embedding API can be thousands of dollars, not millions. Self-hosted GPU is a calendar-time and ops bill. The expensive part is **doing it twice** because chunker_version was wrong, or doing it continuously because `text_hash` is unstable (PDF jitter). Waste rate is the metric; the list price is not.

**Rerank is the recurring *latency* tax.**

- Cost ≈ `QPS × N × pair_cost`. At hundreds of QPS and N=50 this is a dedicated GPU service. At thousands of QPS you will skip rerank under load or you will miss p99. There is no clever shard count that changes this formula.

**BM25 is not free.**

- 300M inverted-index documents is its own cluster, its own JVM/GC tails, its own on-call. Hybrid means paying twice. Unifying on one product is only a win if Phase 0 p99 and memory pass — not because procurement wants one vendor.

**Engineering time dominates year one.**

- Extraction, ACLs, delete correctness, cutover, online eval. Not the ANN SDK bake-off. A two-week "we picked Qdrant vs Milvus" exercise that skips Phase 0 chunk-count measurement is how you buy the wrong size of the right database.

## 4. Why "just add more vector DB shards" is not a full answer

This is the bar the scenario sets for a serious design. Sharding is a **memory-fit** tool. It is not a strategy.

**Tail latency gets worse, then you pretend the dashboard is lying.** Each query waits on the slowest shard. p99 of the max of S i.i.d. latencies grows with S. Hedging and deadlines are mandatory *because* of sharding, not in spite of it. Unbounded S is how a healthy p50 and a dead p99 coexist.

**Recall dilutes unless you retune K.** Global top-K is assembled from per-shard top-K. Too small K-per-shard and the true neighbor never left its shard. Raising K-per-shard raises CPU, network, and fusion noise. Sharding moved the knob; it did not remove it.

**Rerank cost is unchanged.** The expensive model runs on the fused N, once. S=8 and S=128 pay the same rerank bill. If p99 is rerank, shards are entertainment.

**Staleness is unchanged.** A stuck embed queue is equally stuck on 4 shards or 64. Sharding the ANN does not shard the extractor, the hash diff, or the delete path. Stale neighbors in more, smaller graphs are still stale.

**Fusion and filters get harder.** More partial lists, more places to forget an ACL filter, more partial-query modes. Heterogeneous shard health (one compacting, one GC'ing) is the steady state, not an edge case.

**Quality bugs replicate.** Bad chunker, mixed embedding versions, broken analyzer: sharding multiplies operational objects without touching the bug.

What I would do instead, in order: measure working set in **chunks**; quantize and measure recall; replicate for QPS and hedges; shard until a replica fits **and stop**; cap S against the latency ledger; treat rerank N, query-embed locality, and hydrate path as first-class p99 work; treat freshness as a queue SLO. That list is [ADR-006](./04_architecture_decision_records.md#adr-006). A scaling RFC that only contains a new shard count is incomplete and I would send it back.

## 5. What changes if "50M" did not mean documents

The prompt is ambiguous. The architecture is the same shape; the **cluster and the panic** are not. Name the unit in Phase 0 or every hardware meeting is fiction.

| If 50M means… | Working set (order of) | What I would actually do |
| --- | --- | --- |
| **50M source documents**, ~6 chunks (this design's default) | ~300M vectors, multi-TB ANN story | Full design as written. Dedicated ANN, quantization, generations, hybrid, online eval. pgvector is a lab. |
| **50M chunks** (short docs, ~1 chunk each) | ~50M vectors, ~0.3 TB raw at 1536-d | Same seams. Smaller cluster; a well-tuned single-product search engine might pass Phase 1 p99. Still hybrid. Still generations. Still do not mix models in one graph. |
| **50M long PDFs**, ~20–50 chunks | **1–2.5B vectors** | The prompt's sub-second p99 is now a research program plus a budget conversation. Aggressive quantization, smaller dim, possibly Matryoshka/dim reduction, much larger S *with* the tail-latency story funded, maybe corpus partitioning by product line (tenancy), and a frank "not all PDFs in one hot index." I would not promise 1000 ms p99 until Phase 0 chunk-count and a 1% scale benchmark exist. |
| **50M tenants × small corpora** | many tiny indexes | The problem *becomes* routing, noisy neighbors, and per-tenant ACLs. A single 300M-shared HNSW may be the wrong primitive; per-tenant indexes or tenant-prefixed filters with strong isolation might dominate. Hybrid still holds. Sharding *by tenant* is then a product requirement, not an ANN-memory trick. |

If the business will not fund Phase 0 measurement, I would refuse to size the ANN cluster. Guessing 6 chunks/doc to two significant figures is already a professional risk; buying hardware on it without sampling the corpus is malpractice.

## 6. Brutal summary

The clever design is not a bigger vector database. The clever design is **treating retrieval as search**: lexical plus dense, a funnel that keeps the expensive model small, chunks as versioned data, staleness as an SLO, model changes as blue-green migrations, and quality as something you watch on the serving path.

Sub-second p99 at this scale is feasible **if** query embed is local, hydrate is not S3, N is small, shard fan-out is bounded and hedged, and you did not lie about chunk count. It is not feasible if rerank is a 200-pair CPU loop, embed is a cross-region API, or "scale" means S++.

If they wanted a chatbot demo, this document is too long. If they wanted 50 million documents in production, it is the minimum honesty.
