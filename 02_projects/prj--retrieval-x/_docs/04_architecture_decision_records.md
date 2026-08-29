# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Hybrid as Candidate Default, Proven Per Corpus, not Assumed

**Status**: Accepted

**Context**: Vector-only top-k is the status quo in most internal RAG apps. It fails in predictable ways: SKUs, error codes, names, statute numbers, and rare tokens get smeared; lexical queries look "semantically close" to the wrong document. Hybrid (BM25 + vector) is the industry default recommendation for that reason. It is also **not a free win**. On short, already-semantic corpora (e.g. one product's FAQ written in the same voice as the queries), BM25 can add noise, extra latency, and an extra index to keep in sync. Shipping hybrid as "the architecture" without a baseline row is how you add a Postgres FTS column and never know whether it helped.

**Decision**: Implement three named variants (`naive_vector`, `hybrid`, `hybrid_rerank`). Measure all three on the judged set. **Production default is whichever variant the eval split supports under the Phase 0 SLA** — expected to be `hybrid` on corpora with identifiers and mixed lexical/semantic traffic, but **vector-only remaining default is an allowed, reportable outcome**. Hybrid is never silently on without a table, and never un-measurable.

**Consequences:**
- (+) The interesting claim ("hybrid is better") is falsifiable.
- (+) Vector-only remains a first-class path for A/B, for degradation, and for corpora where BM25 did not earn its keep.
- (–) Two indexes to ingest, monitor, and delete from, even during the period hybrid is only a candidate.
- (–) Extra retrieve latency vs vector-only (parallel, so usually hidden under the slower of the two legs — until one of them tails).
- **Alternative rejected**: vector-only forever, "add BM25 later." Later never has judgments either, and the lexical failure mode is already showing up in user complaints.
- **Alternative rejected**: hybrid-only, delete the vector-only path. Then you have no baseline and no degradation when FTS is sick.
- **Revisit trigger**: a corpus's eval table shows hybrid losing on P@k and R@k with no operational reason (index bug, analyzer, stopword list). Default that corpus to `naive_vector`. Do not keep BM25 "because the architecture document said hybrid."

## ADR-002: Reciprocal Rank Fusion over Linear Score Fusion

**Status**: Accepted

**Context**: BM25 scores and cosine/IP similarities are not on the same scale. They shift when k1/b, the analyzer, the embedding model, or collection size changes. Weighted sums (`α * z(bm25) + (1-α) * z(cosine)`) require a calibration that will silently rot. Reciprocal Rank Fusion uses only ranks: `Σ 1/(k_rrf + rank)`. It is crude. It is also stable across heterogeneous retrievers and is the default in a large fraction of production hybrid systems for that reason.

**Decision**: Fuse BM25 and vector lists with RRF. Default `k_rrf = 60`. Tune `k_rrf` only on the **dev** split, promote with an eval-split harness run. Do not linearly combine raw or min-max-normalized scores in v1.

**Consequences:**
- (+) No score calibration pipeline. Retriever upgrades do not require re-fitting α.
- (+) Documents that appear in only one list still participate (lexical-only or semantic-only wins survive).
- (–) RRF cannot express "this BM25 score is extremely high." A rank-1 BM25 hit that the vector list missed is treated like any other rank-1. Usually acceptable; not always.
- (–) `k_rrf` is a hyperparameter people will want to sweep forever. Cap the sweep; the eval split is not a playground. See [ADR-006](#adr-006).
- **Alternative rejected**: learned fusion / LTR in v1. Needs more judgments than this project will have. Revisit only with a judgment budget that looks like a ranking-team budget, not a side project.
- **Alternative rejected**: "just use the vector score if both returned the id." That throws away the lexical ranking among dual-hits.

## ADR-003: Reranker Behind a Strategy Interface, with No-op as a Real Implementation

**Status**: Accepted

**Context**: The prompt asks for a swappable reranker (local cross-encoder or Cohere) via dependency inversion. The failure mode of "we have an interface" is that Cohere's SDK types leak into the orchestrator, the no-op path is an `if skip_rerank` in the handler, and swapping models is a pull request that touches timeouts, payloads, and metrics. Then you do not have an interface. You have a comment.

**Decision**: The query orchestrator depends only on `Reranker.rerank(query, hits, n, deadline) → ordered hits | error`. Three implementations ship: **no-op** (identity), **local cross-encoder**, **Cohere (or equivalent hosted)**. Callers select `variant=hybrid_rerank`; operators select `reranker_id` in corpus config. Swap is config + canary, not a caller change. No-op is what the orchestrator uses when the circuit breaker is open or the deadline has no time left — the same code path as "rerank disabled," not a second special case.

**Consequences:**
- (+) Vendor lock-in is an adapter rewrite, not a product rewrite.
- (+) Local vs hosted is a data-boundary and latency choice per corpus (PII that cannot go to Cohere uses local).
- (+) The ablation table can have two `hybrid_rerank` rows without forking the service.
- (–) You must actually build two adapters and run the Phase 4 swap drill, or this ADR is fiction. An interface with one implementation is cheaper to fake than to prove.
- (–) Lowest-common-denominator contract: features unique to Cohere (or to a given CE) do not leak upward. That is the point; it will annoy whoever wanted a vendor-specific flag on day two.
- **Alternative rejected**: only Cohere, "it's just an HTTP call." It is also a bill, a DPA, a timeout, and a 429 storm. The local adapter exists for isolation and for when the vendor is down — even if production mostly uses one.
- **Alternative rejected**: caller-supplied reranker URL. That makes every app a rerank platform and destroys the table's comparability.

## ADR-004: Standalone Versioned Microservice, not an Embedded Library

**Status**: Accepted

**Context**: The cheapest way to share retrieval is `pip install retrieval-x` and call `hybrid_retrieve()` from five FastAPI apps. That produces five deploy cadences, five timeout bugs, no central table, and a "quick" Cohere key in five environment files. The prompt asks for a standalone microservice with its own API contract, pluggable into any downstream app. That is operationally heavier. It is also the only shape that makes "we A/B'd the pipeline" a single experiment.

**Decision**: `retrieval-x` is an HTTP service (`/v1/retrieve`). Downstream apps are clients. Rank, indexes, reranker choice, and eval live with the service. A client SDK is allowed as a thin generated/typed wrapper around the HTTP contract; it must not contain ranking logic.

**Consequences:**
- (+) One place to measure, one place to roll back ranking, one table.
- (+) Non-Python callers can exist without a rewrite.
- (–) A network hop on every retrieve (usually small vs rerank; not small vs an in-process pgvector call in the same app).
- (–) On-call surface: this is now a production service. Library bugs were "that app's problem."
- (–) Local dev for app teams needs a running retrieval-x (shared dev instance or docker-compose). Treat that as a product requirement, not an afterthought, or they will bypass you with a vector call.
- **Alternative rejected**: library first, "extract a service later." Later, five apps have forked the library.
- **Revisit trigger**: a single app, no sharing, no table needed — then a library is honest. That is not this scenario.

## ADR-005: Synchronous Rerank with Hard Timeout and Fused-only Fallback

**Status**: Accepted

**Context**: Cross-encoder rerank is the quality win and the p95 killer. Two tempting designs: (1) enqueue rerank, return a job id, let the app wait — destroys interactive RAG; (2) fail the request when Cohere is slow — correlates your availability with a vendor. A third temptation: retry 429s inside the request until quality is saved. That converts a timeout into a longer timeout.

**Decision**: Rerank is synchronous on the retrieve path, bounded by a deadline derived from the caller timeout. On timeout, 429, 5xx, circuit-open, or insufficient remaining time: **return fused-but-unreranked hits** with `degraded_rerank`. Do not 5xx. Do not retry vendor errors inside the request. N is a latency control; raising N requires a new latency measurement against the Phase 0 SLA, not a config edit "because quality."

**Consequences:**
- (+) Availability of retrieve is independent of Cohere and of GPU queueing, as long as fusion succeeded.
- (+) p95 has a hard cap: rerank cannot steal time past T.
- (–) Under load or vendor pain, production quality **silently** matches the hybrid-without-rerank row. Operators must alert on `degraded_rerank` rate or they will believe they are running a reranked system they are not.
- (–) Users can see ranking flicker (reranked vs fused) across retries. Acceptable; document it. Do not try to sticky-session quality.
- **Alternative rejected**: async job queue rerank. Wrong product (this is a retrieve API, not a batch scorer).
- **Alternative rejected**: fail-closed. One Cohere incident becomes a company-wide search outage.
- **Alternative rejected**: always wait for rerank "because citations need the best order." Citations do not need the best order; they need source metadata on whatever you returned.

## ADR-006: Eval Harness as a First-class, Separately Runnable Artifact

**Status**: Accepted

**Context**: RAG quality in practice is a notebook, a few queries the author likes, and a screenshot in a PR. That cannot support "publish a table" or "gated ranking changes." LLM-as-judge is not a substitute for relevance judgments in v1: it measures a different thing, it is expensive, and it tends to agree with fluent retrievers whether or not they found the right policy.

**Decision**: A batch harness, not a notebook, calls the **public** `/v1/retrieve` API for named variants against a versioned judged set (`dev` vs frozen `eval`). It writes a diffable artifact (P@k, R@k, MRR, nDCG if graded, latency percentiles). Production ranking changes (default variant, `k_rrf`, M, N, `reranker_id`, analyzer, embedding model) require a harness run on `eval`. The judged set is reviewed by someone other than the author. Pooling is required for judgment campaigns.

**Consequences:**
- (+) The table is reproducible and attributable (git sha + config snapshot).
- (+) In-process cheats cannot inflate the numbers relative to what callers see.
- (–) Judgments are the long pole and the recurring cost. Without them this ADR is a JSON printer of latencies.
- (–) Frozen `eval` will go stale. Stale-set is a kill criterion for ranking changes, not a reason to start tuning on production vibes.
- **Alternative rejected**: LLM-as-primary-judge. Optional later, secondary, on a frozen generator. Not the v1 gate.
- **Alternative rejected**: only online A/B (click, dwell, thumbs). Valuable when traffic exists; cold start still needs an offline set, and clicks are not relevance (users click the wrong policy too).
- **Revisit trigger**: judgment budget goes to zero and nobody will label. Then you do not ship hybrid+rerank as a quality feature; you may still ship hybrid as a latency-acceptable lexical safety net **without claiming P/R gains**. Honesty over a fake table.
