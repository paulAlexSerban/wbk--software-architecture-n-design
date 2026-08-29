# RAG Pipeline at Scale — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not documentation theater** — sizing ANN memory off a guessed chunks/doc is how you buy a cluster that OOMs at 12% corpus and then "add shards" in a war room.

Phases 0–4 are sequential. Phase 5 is ongoing operations after serving production traffic. A later phase must not start because a calendar slide said so if the previous gate is yellow.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never take production traffic without freshness lag, coverage, and golden probes on the serving path.** That is not a follow-up ticket.

Calendar is *not* "two sprints." Phase 0 might be a week. A first correct single-shard hybrid on a **sample** might be weeks. A full 50M-doc backfill is a function of embed throughput and extract rate — **days to months** — and is an exit gate of Phase 4, not a promise of Phase 1. Anyone who schedules "50M in prod, sub-second p99" at the end of month one has not read [Business Overview — The Math](./01_business_overview.md#the-math-the-actual-requirement).

## Phase 0 — Measure the Corpus, the Queries, and the SLO (before hardware)

**Objective**: Replace the load-bearing guesses (chunks/doc, dim, change rate, QPS, extract quality, what "50M" counts) with measurements and a written SLO. Refuse to size the serving cluster until this gate is green.

**Deliverables:**
- **Unit of 50M named in writing**: documents vs chunks vs tenants. See [Trade-offs §5](./05_tradeoffs_and_honest_assessment.md#5-what-changes-if-50m-did-not-mean-documents).
- **Stratified sample** of real documents (PDF/HTML/ticket/code if they exist): run the candidate extractor + chunker; report tokens/doc, chunks/doc (p50/p95/p99), extract failure rate, table/layout salvage rate.
- **Extrapolated working set**: `estimated_chunks = f(sample)`, with error bars, not a single heroic 300M.
- **Change-rate sample**: % of corpus mutating per day/week if logs exist; otherwise an honest "unknown, assume X and list how we will measure in Phase 4."
- **Query sample**: volume, latency SLO confirmation (retrieval vs time-to-first-token), mix of ID-like vs natural language, tenancy/ACL requirements.
- **Golden v0**: ≥ a few dozen labeled `(query → doc_id or chunk)` including ID-must-win cases. Living-set process agreed (who curates).
- **Embedding-model shortlist** with a *downsampled* retrieval bake-off (not 50M). Quote $ and days for a full corpus pass per candidate.
- **Freshness SLO proposal** (p99 mutation → searchable) agreed with the product owner as a number, not "near real time."
- One-page unknowns log: each item `measured` or `open, fallback assumption is X`. Open items that kill feasibility (e.g. 50M long PDFs, 40 chunks mean, 1000 ms p99, remote-only embed, no budget for RAM) are flagged immediately.

**Exit Gate:**
- [ ] Chunk-count estimate exists from a real sample, with p95, not only a mean.
- [ ] "50M" unit is unambiguous in the design doc header.
- [ ] Retrieval SLO is explicitly **excluding generation**, with a p99 number.
- [ ] Freshness p99 number is written down (or "no freshness SLO" is explicitly accepted — do not leave it implied).
- [ ] ACL/tenancy model is named (filter-in-index vs separate indexes).
- [ ] Feasibility call: **estimated working set + quantization plan fits a fundable cluster and the latency ledger still has slack → proceed.** **B-billion-vector extrapolation + 1000 ms p99 + no dim reduction + no corpus split → kill/escalate**, do not quietly enter Phase 1 as if RAM will appear.

Do not buy the full ANN fleet in Phase 0. Buy enough to run the sample bake-off.

## Phase 1 — Ingest, Chunk, Single-Shard Dual Index on a Sample (correctness)

**Objective**: Prove the data path: extract → versioned chunks → BM25 + ANN → query by ID and by paraphrase. No rerank. No sharding. Correctness and delete behavior over scale.

**Deliverables:**
- Document lake + extractor pinned by version; failed extracts marked `unsearchable`, never indexed as empty.
- Chunker per [System Design §2](./03_system_design.md#2-chunking) with `chunker_version` and `text_hash`.
- Chunk store; BM25 index; one ANN collection for `generation_0` (full precision or int8 — pick one and record it).
- Ingest of a **representative sample** (order: 10k–100k docs, or 1% — pick a number that still finishes in days).
- Query service: query embed, BM25 top-K, ANN top-K, return lists separately *and* a fused RRF list (rerank off).
- Tests: edit a doc → old chunks gone, new present; delete a doc → zero hits; ACL filter cannot return another tenant on the sample.
- Golden v0 run against this index; numbers recorded as the baseline, not as a marketing slide.

**Exit Gate:**
- [ ] Sample fully indexed in **both** backends; coverage metric implemented (even if only on the sample).
- [ ] Delete/edit drill passed; stale chunk_id is not retrievable.
- [ ] ID-must-win queries succeed on BM25 (and on fused). If they only succeed on ANN, the analyzer or chunk breadcrumbs are wrong — fix here, not in Phase 2 rerank.
- [ ] Vector-only vs hybrid comparison on golden v0 is written down (expect hybrid to win the ID slice).
- [ ] No production traffic. This gate is not a launch.

If extract quality on PDFs is catastrophic, **stop and fix extraction** or narrow corpus scope. Do not "make up for it with a better embedding model."

## Phase 2 — Funnel: Fusion, Rerank, Instrumented Latency Budget

**Objective**: Put the production query shape on the sample (or a larger slice): RRF + bounded rerank, per-stage tracing, deadline. Prove p99 *shape* before multiplying shards.

**Deliverables:**
- Rerank service, N configurable, skip-on-deadline with `rerank_skipped` metric.
- Query-embed cache keyed by generation.
- Hydrate from chunk store only (explicit test: no object-storage GET on query path).
- Tracing: embed, BM25, ANN, fuse, rerank, hydrate histograms.
- Load test at **target QPS of the sample cluster**, not of 50M. Record p50/p95/p99 vs the [ledger](./03_system_design.md#6-latency-budget).
- Experiment log: N=16/32/50 vs golden and vs p99. Pick a default N; changing it later is a capacity change.

**Exit Gate:**
- [ ] p99 on this cluster is **explained by stages**, not a single number. If p99 is over budget on a sample, adding shards will not save you — fix embed locality / N / hydrate first.
- [ ] Rerank skip path is tested and metriced.
- [ ] Golden set not worse than Phase 1 fused (or a documented, accepted trade for latency).
- [ ] Still no "we will make N=200 in prod" in the config without a failed gate on purpose.

## Phase 3 — Scale-Out: Quantization, Replicas, Bounded Shards, Hedges

**Objective**: Make the working set fit and keep tails honest. Validate **p99 under scatter-gather**, not only QPS.

**Deliverables:**
- Quantized ANN build from the same vectors; golden recall@k delta recorded ([ADR-006](./04_architecture_decision_records.md#adr-006)).
- Replica set; hedge policy; per-attempt deadlines; `queries_partial_shard`.
- Hash sharding with an **S justified by replica memory**, not by "more is more." Re-run load test at S=1, S=chosen, and S=2×chosen to **show the tail getting worse**.
- BM25 cluster sized for the same cardinality as ANN (do not "leave BM25 for later" at 300M).
- Capacity model: RAM × replicas × (1 + extra generation during cutover).

**Exit Gate:**
- [ ] Quantization recall hit is accepted in writing (or quantization rolled back).
- [ ] Load test p99 at chosen S **with hedges** meets the SLO *or* the SLO is renegotiated before more corpus is poured in.
- [ ] The 2×S experiment exists; the team can explain why they did not pick it.
- [ ] Kill criterion: if the only way to meet memory is S so large that p99 dies even with hedges, **do not proceed to full corpus** — reduce dim, split corpus, or change the SLO.

Do not start the 50M backfill until this gate is green on a scaled **slice** (e.g. 5–10% if affordable). Pouring 100% into an unbounded shard farm is irreversible calendar burn.

## Phase 4 — Full Refresh Plane, Backfill, Blue-Green Path

**Objective**: Production-shaped ingest: incremental dirty-chunk pipeline plus a rehearsed generation cutover, then fill the index to the real corpus without blocking query serving on a sample cluster you then throw away (or grow in place if that was the plan).

**Deliverables:**
- Change detector (CDC/webhook/poll) with `source_mutated_at`.
- Incremental diff path ([System Design §3](./03_system_design.md#3-embedding-refresh)); priority queues; dead-letter; `chunks_not_searchable` / `chunks_sparse_only`.
- Freshness-lag metric on **injected** edits (synthetic canaries: edit a probe doc every N minutes, assert it becomes searchable).
- Full (or remaining) corpus backfill with checkpointing; estimated completion date from measured embeds/s, revisited daily.
- Index controller: build `generation_1` on a **subset** first; shadow; cut over; rollback drill; then use the same path for the corpus-wide model or the first real model upgrade.
- Destroy-after-drain runbook (RAM recovery).

**Exit Gate:**
- [ ] Canary edit is searchable within the freshness SLO on both BM25 and ANN; a deliberately stuck embed worker pages on lag, not on CPU.
- [ ] Delete of a canary doc produces zero hits within SLO.
- [ ] Rollback drill: traffic returned to previous generation in minutes, not hours.
- [ ] Coverage for the backfill is reported daily; holes are explained (extract fail vs embed fail vs not-yet-reached).
- [ ] Mixed-version write into one graph is impossible in config (review + test).
- [ ] Backfill complete **or** a labeled partial corpus is an accepted product state with coverage printed to the answering app. Silent 12% coverage is a failed gate.

## Phase 5 — Production Degradation Monitoring (ongoing)

**Objective**: Make "retrieval got worse" detectable without a quarterly eval. Entry requires Phase 2 tracing and Phase 4 freshness canaries; this phase is the rest of [ADR-007](./04_architecture_decision_records.md#adr-007).

**Entry Gate:** Serving real users, even if corpus coverage is still climbing. Monitoring is not delayed until 100% backfill.

**Deliverables:**
- Dashboards + pages: freshness lag, coverage, embed holes, empty/low-score rate, score-distribution drift, `partial_shard`, `rerank_skipped`.
- Golden runner on a clock **through prod** query service: frozen regression + ID probes + recent-edit probes + sampled living queries.
- Shadow comparison required on every generation cutover (checklist, not tribal knowledge).
- Downstream proxies wired as corroboration (abstention, thumbs, re-query) — not sole page reason.
- Curator rotation for golden-set rot (named humans, not "the platform team").
- Quarterly (or cheaper) downsampled offline eval still exists as a **release** gate for chunker/model — in addition to, not instead of, online signals.

**Exit Gate** (re-checked continuously; never "done"):
- [ ] A staged quality regression (wrong query model, paused deletes, paused embeds) is **detected by the intended signal** in a game day.
- [ ] Cutover without shadow numbers is blocked by policy.
- [ ] Golden living-set has been updated in the last 30 days.
- [ ] Logging/probe retention reviewed against corpus classification.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the indexes green" — if any of the following hold:

1. **Working-set miss**: sampled chunks/doc makes RAM × replicas × generations unfundable, and dim-reduction / corpus-split / SLO change is refused. Honest output: "this requirement is not feasible as stated." Adding shards until p99 dies is not a workaround. See [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-just-add-more-vector-db-shards-is-not-a-full-answer).
2. **Sharding before funnel correctness**: S>1 in production while Phase 2 stage latency is unexplained or N is unbounded. Roll back to S=1 (or the last justified S) and fix the ledger.
3. **Launch without online quality**: no freshness lag, no coverage, no prod golden probes. Block traffic. This is not a P3.
4. **Mixed embedding versions in one graph**, or query embedder `model_id` ≠ active generation. Immediate rollback of routing; treat as a SEV-level quality incident even if latency is green.
5. **ACL fail-open** (unfiltered search on filter subsystem error, or post-filter-only top-K). Kill the deploy.
6. **Stale-chunk / missed-delete** reproduced on a canary and not fixed before more corpus ingest. Stop backfill; deletes are correctness, not eventual GC.
7. **pgvector-or-equivalent leftover as the 300M serving store** after Phase 0 estimated a dedicated-ANN working set. Prototype debt becoming prod is a kill criterion, not a shortcut.
8. **Pressure to ship vector-only** to hit a date. Degraded mode is for outages, not for roadmaps. Hybrid can launch on a *sample corpus*; it cannot launch missing a backend because the cluster order is late — then wait.

Rollback is always to the last phase whose exit gate was honestly green (including the previous index generation). After a kill, stakeholders still get the measured chunk count, the latency ledger, the coverage of whatever is indexed, and a recommendation: reduce scope, change SLO, fund RAM, or split the corpus. They do not get a confident sub-second 50M-doc RAG we never had.
