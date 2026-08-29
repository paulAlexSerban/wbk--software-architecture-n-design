# retrieval-x — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–4 are sequential. **Phase 0 is not optional and is not documentation theater** — building hybrid+rerank against zero judgments is how you get a dashboard of latencies and a story about quality. Phase 5 is ongoing operations after a production default is chosen.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never promote a pipeline stage to default to make a gate look green.**

Calendar assumptions: one small team (1–3 engineers) plus borrowed labeling time. Phase 0 is dominated by other people's calendars. Phases 1–3 are the first real serving path. Phase 4 is the interface proof. Do not schedule k8s before a table with at least two rows exists.

## Phase 0 — Judgments, Contract, SLA (before pipeline theater)

**Objective**: Replace the load-bearing guesses — "hybrid will win," "rerank fits the UX," "we can label later" — with a frozen eval set, a written SLA, and a pinned API sketch. A reranker built before this phase is a science fair.

**Deliverables:**
- **API contract draft** for `POST /v1/retrieve` as in [System Design §4](./03_system_design.md#4-api-contract), reviewed by at least one downstream caller. Breaking changes after Phase 1 are expensive; argue now.
- **Latency SLA in writing**: retrieve p95 (and p50 if they care), excluding generation, with the UX it implies (typeahead vs submit-and-wait). See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-how-the-answer-changes-under-a-hard-low-latency-sla).
- **Corpus facts**: approximate chunk count, document types, whether citations (URI, version) exist, whether passages may leave the VPC (Cohere yes/no).
- **Judged query set v0**: target ≥50 queries (100–200 if the corpus matters to a product). Sample from real traffic or real FAQs, not from the author's imagination. **Pooling plan** written (you will run a first retrieve pass in Phase 1 to pool; v0 may start with known-relevant docs if they exist).
- **Rubric + a named reviewer who is not the author.** Binary grades are enough. A subset double-annotated if you can steal the hours.
- `dev` vs `eval` split declared. Eval is frozen.
- Stack call for v1: Postgres FTS + pgvector **unless** corpus facts already rule it out. Write the escape hatch, do not build it.
- Written ask for labeling hours and for GPU vs Cohere budget. Do not wait for yes to start Phase 1 **code**, but quality *claims* wait on labels.

**Exit Gate:**
- [ ] SLA number exists in a document a product owner signed (email counts). "As fast as possible" does not pass.
- [ ] API contract reviewed by a caller. Open questions listed, not shrugged.
- [ ] Eval split has a reviewed query list. If labels are still in progress, remaining unlabeled items are tracked; **a path to ≥50 fully judged eval queries is dated**. If that path does not exist, the project proceeds as **latency-and-citation only** and must not claim P/R — see kill criterion 1.
- [ ] Reviewer ≠ author has looked at the rubric and a sample of queries.
- [ ] Cohere data-boundary decision recorded per corpus (allowed / forbidden).
- [ ] Feasibility call: SLA < 150 ms ⇒ rerank is **off** the default-path plan unless a measured tiny-N CE exists later. Do not enter Phase 3 pretending 150 ms and Cohere will reconcile.

## Phase 1 — Naive Vector Baseline + Harness Skeleton

**Objective**: Put the contract on the air with the dumbest ranking that could possibly work, and **make the harness produce a one-row table** against it. Without this row, later rows are marketing.

**Deliverables:**
- FastAPI `/v1/retrieve` with `variant=naive_vector` only (other variant values 400). Authz on `corpus_id`. Citation hydrate from chunk store.
- Ingest path sufficient for one corpus: chunk rows, embeddings, pgvector index, citation fields. Perfect ingest is not the goal; **aligned `chunk_id`s** are.
- Query embed using the same model id as the index; mismatch refuses to search.
- Eval harness v0: reads the judged set, calls the HTTP API, writes JSON + markdown table with P@k, R@k, MRR, latency p50/p95. Config snapshot + git sha on the artifact.
- Per-stage timings in the response (`query_embed`, `vector`, `citation`, `total`).
- Docker Compose (API + Postgres). Not k8s.

**Exit Gate:**
- [ ] A caller (or a script pretending to be one) retrieves hits with **100% citation completeness** on a fixture corpus.
- [ ] Harness runs unattended (CI or one command in CI-like conditions) and produces the naive_vector row on the eval split — even if quality is embarrassing.
- [ ] Latency p95 for naive_vector is measured on hardware in the same class you will serve from, not only on a laptop.
- [ ] Empty query / unknown corpus / authz miss behave as in the contract.
- [ ] `chunk_id` alignment: a known ingested chunk is retrievable and cites the right URI.

Do not start BM25 until the harness is boring. The long pole of Phase 2 is not the `tsvector` column; it is discovering the harness cannot be rerun.

## Phase 2 — BM25 + RRF; Publish Naive vs Hybrid

**Objective**: Add lexical retrieval and fusion. Publish the second row. **Hybrid is allowed to lose.**

**Deliverables:**
- FTS column / index on the same Postgres; BM25 retriever adapter; parallel fan-out with per-leg timeout.
- RRF with `k_rrf=60`, documented tie-break, M vs k as in [System Design §2](./03_system_design.md#2-rrf-fusion).
- `variant=hybrid` on the API. Degenerate lists and one-leg failure per the [failure table](./03_system_design.md#8-failure-modes) (`degraded_bm25` / `degraded_vector` / empty-vs-503 distinction).
- Analyzer / tokenization notes (language, identifiers, punctuation). A SKU query is a test fixture, not an afterthought.
- Harness: two rows. Same eval split, same k, same machine class.
- Optional: first pooling pass — dump union of naive_vector + hybrid ids for queries with thin judgments; send to reviewers. **Do not retune on eval.**

**Exit Gate:**
- [ ] Table contains naive_vector **and** hybrid, with quality **and** latency. A hybrid-only table does not pass.
- [ ] If hybrid loses on P@k and R@k: recorded as the outcome; default variant remains naive_vector. This **passes** the gate. Forcing hybrid on because "we built it" fails the honesty bar, not the compiler.
- [ ] Forced BM25 failure (kill FTS, or a fault injection) returns vector hits with `degraded_bm25`, not 5xx.
- [ ] Forced vector failure returns BM25 hits with `degraded_vector` when variant is hybrid.
- [ ] RRF is deterministic on a fixture (same ranks on repeat).

If hybrid wins on recall and fits the SLA, it becomes the **candidate** production default, still not including rerank.

## Phase 3 — Reranker Interface + Local Cross-encoder; Go/No-go vs SLA

**Objective**: Put rerank behind the interface, implement **no-op** and **local cross-encoder**, measure hybrid_rerank as a third row **including p95**, and make an explicit go/no-go against the Phase 0 SLA. Quality without a latency number is an incomplete row.

**Deliverables:**
- `Reranker` interface as in [System Design §3](./03_system_design.md#3-reranker-interface). No-op implementation used for `hybrid` (or when `reranker_id=noop`).
- Local CE implementation: pinned model id, batched forward pass, truncation policy, deadline observance.
- `variant=hybrid_rerank` on the API. `reranker_id` in corpus config.
- Deadline split: skip rerank with `degraded_rerank=no_time` rather than overrunning.
- Harness: third row (local CE). N recorded in the snapshot. Latency from the API.
- N chosen **before** looking at eval nDCG on a grid that includes the SLA. Suggested start: N=20. A sweep on **dev** only; one eval run for the chosen N.

**Exit Gate:**
- [ ] Table has three rows: naive_vector, hybrid, hybrid_rerank (local).
- [ ] p95 hybrid_rerank is measured, not estimated from model cards.
- [ ] **Go/no-go written:**
  - **Go:** hybrid_rerank beats hybrid on the agreed quality metric(s) **and** p95 ≤ SLA with documented headroom (do not land exactly on the SLA).
  - **No-go:** keep `hybrid_rerank` available, default remains hybrid or naive_vector. Interface stays. GPU need not be in the serving path.
- [ ] Deadline miss / killed CE call returns fused hits with `degraded_rerank`, not 5xx or empty.
- [ ] Orchestrator code does not import CE/GPU libraries — only the adapter does.

A no-go **passes** Phase 3. Deleting the interface because rerank missed the SLA fails the point of Phase 4.

## Phase 4 — Second Reranker Implementation + Degradation Drill

**Objective**: Prove the interface is not a comment. Add Cohere (or equivalent hosted) as an adapter. Prove swap is config. Prove fail-open under forced vendor failure. Skip Cohere **implementation** if Phase 0 forbade data egress; then the "second implementation" is a **stub hosted adapter against a fake endpoint** plus the drill — still required, still a code path, no production traffic to a vendor.

**Deliverables:**
- Cohere (or stub) adapter mapping to the same interface. Timeouts = remaining deadline. No in-request 429 retries.
- Circuit breaker per [System Design §3](./03_system_design.md#circuit-breaker).
- Corpus config swap: `local:<model>` → `cohere:<model>` without changing `/v1/retrieve` handlers or callers.
- Harness: optional fourth row if Cohere is allowed and budgeted; **subsample if cost is an issue**, and record the subsample. A missing Cohere quality row is acceptable if Phase 3 no-go'd rerank; the drill is not optional.
- Forced-failure drill: timeout, 429, 5xx, circuit-open → 200 fused hits + flags. Ready probe does **not** depend on Cohere.

**Exit Gate:**
- [ ] Swap is a config change + deploy/canary of config, not a PR that edits the orchestrator.
- [ ] Forced-timeout drill passed and is written as a runbook step.
- [ ] 429 drill does not amplify (no retry storm).
- [ ] Callers did not change.
- [ ] If Cohere is production-eligible: unit-cost estimate (`QPS × price`) in the same doc as the table, before defaulting any corpus to it.

## Phase 5 — Production Default, k8s, Retune-on-harness-only

**Objective**: Run the service as a shared platform: choose defaults from the table, put it on Kubernetes, and make ranking changes gated. This phase has no calendar end date.

**Entry Gate:** Phase 3 go/no-go exists (even if no-go). Phase 4 drill passed. Eval set is not marked stale.

**Deliverables:**
- Production default `variant` / `reranker_id` per corpus, copied from the latest honest table + SLA decision — not from a demo.
- Kubernetes Deployment for API; separate Deployment for local CE if it is on the path (GPU node pool). HPA independently. Postgres (or managed) is still the data plane.
- Exact query cache optional, keyed by `(corpus_id, model ids, variant, query)`.
- Scheduled harness (e.g. weekly) + alert on failure or on metric drop vs last run.
- Operator runbook: degrade flags, circuit, index divergence (`vector_lag_count` if dual-writing), how to roll back `reranker_id` to noop.
- Retuning `k_rrf`, M, N, analyzer: **dev split only**, then one eval run, then config change. No "I poked prod."

**Exit Gate** (re-checked periodically):
- [ ] On-call can explain, from metrics, whether rerank is actually happening (`degraded_rerank` rate).
- [ ] A rollback of reranker to no-op is a config revert exercised once in a drill.
- [ ] Eval job age is within the chosen cadence; stale set is flagged.
- [ ] Multi-corpus isolation: a test that caller A cannot retrieve corpus B.
- [ ] k8s readiness does not depend on Cohere.

This phase may be where you finally add Pinecone/Elastic **because Phase 0/5 measurements say Postgres p95 is the SLA problem**, not because the original prompt listed them. Adapters were the plan; buying them on day 1 was not.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the pipeline green" — if any of the following hold:

1. **No judgments and no dated path to them.** You may ship naive_vector as a citation-bearing retrieve API. You may **not** publish P/R tables, claim hybrid quality, or default hybrid_rerank. A latency-only table must be labeled latency-only.
2. **Eval set contamination or staleness.** Ranking changes against a stale or author-tuned eval split are a kill for that change. Freeze a new eval set; do not keep fitting `k_rrf` to the test queries.
3. **Rerank p95 misses SLA with no mitigation** (N already at a floor, local already tried, Cohere worse). Default rerank stays off. Do not "ship it for quality" and apologize to the p95 dashboard.
4. **Interface leak / swap requires orchestrator edits.** Fail Phase 4; do not paper over it with a facade that still imports the SDK.
5. **Fail-closed rerank in production.** If a Cohere blip 5xxs retrieve, roll back to fail-open immediately. That regression is an incident.
6. **Tenant leak** (wrong `corpus_id`, cache key missing corpus, hosted rerank sent another tenant's passages). Kill traffic to the affected corpus; this is not a quality issue.
7. **Index divergence ignored** (FTS and vectors disagree as a steady state). Repair or stop claiming hybrid.
8. **Pressure to omit flags** so the API "looks clean." Same class of request as unlabeled incomplete reports in other projects: refuse.
9. **Scope creep into 50M-doc sharding** inside this repo. That work belongs in [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/README.md). Killing the *confusion* is in-scope; building that cluster here is not.

Rollback is always to the last phase whose exit gate was honestly green — typically: rerank off, or hybrid off, or back to naive_vector, with the table still published. After a kill of quality claims, callers still get a retrieve contract and citations. They do not get a fake ablation.
