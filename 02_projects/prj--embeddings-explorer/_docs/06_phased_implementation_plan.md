# Embeddings Explorer — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not documentation theater** — ranking chunkers without a labeled eval set is how you spend a week building UI on top of a vibe.

Phases 0–3 are sequential. Phase 4 is optional. A later phase must not start because a calendar slide said so if the previous gate is yellow.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never publish a "winning chunker" without the eval-set version, model_id, and caveat block.** That is not a follow-up ticket.

Calendar is *not* "stand up RAG this sprint." Phase 0 might be a day of counting files and two days of labeling. A correct fixed-size pipeline on this folder might be a few days. Semantic chunking plus a honest table might be a week. Anyone who schedules "production semantic search with a beautiful app" at the end of month one has not read [Scenario — Non-Goals](./01_scenario_and_requirements.md#explicit-non-goals).

## Phase 0 — Corpus Snapshot and Eval Set (before any "winner")

**Objective**: Replace "a folder of docs" with a counted corpus, a pinned extractor experiment, and a versioned labeled query set. Refuse to compare chunkers until this gate is green.

**Deliverables:**
- **Corpus inventory**: file count, extension mix (md / pdf / other), total bytes, p50/p95 file size. Working 200–2,000 is a guess until this exists.
- **Extractor spike**: one pinned PDF library + markdown path; **unsearchable rate** on the real folder; 5–10 hand-inspected PDF extracts (readable vs soup). If soup is the majority of PDFs, write that down — chunker comparison on those files is mostly noise.
- **Corpus freeze rule**: git-lfs, a tarball hash, or a `MANIFEST` of `path + raw_hash`. The published table points at this snapshot.
- **Eval set v0**: ≥ 30 queries (aim 40–60), human judgments at **doc-level** (optional quoted passage). Mix paraphrase, keyword/ID, "which document." ≤ ~20% verbatim headings. See [System Design §5.3](./03_system_design.md#53-label-granularity).
- **Metric definitions in writing**: Success@k (at least one relevant doc in top k) and MRR; k ∈ {5, 10}. Do not say "recall" if you mean Success@k.
- **Lexical sanity**: run a trivial keyword / Postgres FTS / ripgrep-style check on the eval set. Record Success@k. If keyword already gets 0.95, the set is too extractive — rewrite queries before building embeddings.
- **Model shortlist of one (or two, with a default)**: local model preferred; record dim, metric (cosine vs IP), query/document prefixes.
- Unknowns log: each item `measured` or `open, fallback is X`.

**Exit Gate:**
- [ ] File counts and format mix exist.
- [ ] Extract unsearchable rate is known; catastrophic PDF extract is either accepted (and sliced in later reports) or the corpus is narrowed.
- [ ] Eval set ≥ 30 labeled queries, versioned, with the freeze rule.
- [ ] Keyword baseline is **not** ~perfect; the set has room for dense retrieval to matter.
- [ ] No comparison table yet. This gate is not a launch.

Do not implement semantic chunking in Phase 0. Do not design the UI.

## Phase 1 — Baseline Pipeline (fixed-size only)

**Objective**: Prove the data path: extract → fixed-size chunks → embed → pgvector → query by vector. Record **baseline** Success@k / MRR. No UI required. No other chunkers.

**Deliverables:**
- Compose (or local) Postgres + pgvector; schema for documents, chunks, ingest runs as in [Architecture — Data](./02_architecture_document.md#data-architecture).
- Loader + extractor pinned by version; empty extracts not indexed.
- Fixed-size chunker with recorded params (working 512 / 64) and `chunk_id` scheme from [System Design §2.4](./03_system_design.md#24-identifiers).
- Embedding client with pinned `model_id`; prefix policy implemented if needed.
- Query library/CLI: embed query, k-NN filtered by variant, print path + score + text.
- Ingest of the **frozen** corpus; coverage numbers stored on the run.
- Harness v0: eval set against this **one** variant; baseline metrics written down.
- Tests: re-ingest does not duplicate rows; delete/rebuild variant leaves no orphans.

**Exit Gate:**
- [ ] Coverage reported; unsearchable files explained (extract vs skip).
- [ ] Baseline Success@5 / Success@10 / MRR recorded against eval set v0.
- [ ] Keyword vs dense baseline compared in writing (expect keyword to win some ID queries).
- [ ] Query path never calls a generator.
- [ ] No production, no public deploy. This gate is not a demo day.

If extract quality is catastrophic, **stop and fix extraction or drop PDFs from the comparison slice**. Do not "make up for it with semantic chunking."

## Phase 2 — Strategy Comparison (the product)

**Objective**: Add recursive and semantic chunkers, ingest all three variants with the **same** model and extractor, run the harness, emit the comparison table with cost columns and the caveat block.

**Deliverables:**
- Recursive splitter with recorded separator list and max tokens. [System Design §2.2](./03_system_design.md#22-recursive-structure-aware-with-fallback).
- Semantic splitter with frozen cut rule; **sentence embed calls counted separately**. Silent fallback to recursive on a doc must be flagged, not hidden. [System Design §2.3](./03_system_design.md#23-semantic).
- Three ingest runs; chunk-count differences sanity-checked (identical counts ⇒ a splitter probably no-op'd).
- Harness completes: one table, one `model_id`, eval_set_version, ingest seconds, embed calls, estimated $, unsearchable (should match across strategies if extract is shared).
- Caveat block from [System Design §5.4](./03_system_design.md#54-what-the-numbers-are-allowed-to-mean) in the report.
- Short error analysis: 5–10 queries where strategies disagree, inspected by a human (UI still optional; CLI dumps suffice).
- **No declared winner** without the caveats. If numbers are within a few points, say "tie within noise" and pick an engineering default (usually recursive) explicitly as a **prior**, not as a scientific result.

**Exit Gate:**
- [ ] Three variants indexed; harness table exists in the repo (`_reports/` or equivalent in a later build; at docs-only time this is the *required shape*).
- [ ] Cost/time columns present; semantic's sentence-embed tax is visible.
- [ ] Harness refused (or would refuse) to merge runs with different `model_id`.
- [ ] Winner language, if any, is scoped to corpus + model + eval-set version.
- [ ] Still no generator.

Do not start a React UI here. Do not add BM25 to "fix" the ID queries — leave them in the error analysis for `retrieval-x`.

## Phase 3 — Thin Search UI (flashlight)

**Objective**: Let a human run an ad-hoc query and see ranked chunks with provenance, for demo and qualitative checks. Must not become the project.

**Entry Gate:** Phase 2 table exists. If it does not, this phase is blocked — the UI would be the tutorial this project was meant to replace.

**Deliverables:**
- Query box, strategy/run selector, k, result cards (text, path, score, heading/page if any, `chunk_id`).
- Footer: `model_id`, strategy params, pointer to eval-set version / report.
- Optional: side-by-side two strategies for one query.
- Same query service/library as the harness. No second retriever.
- Explicit absence of chat, generate, upload-to-SaaS, auth.

**Exit Gate:**
- [ ] A human who is not the author can retrieve chunks for a typed query without reading code.
- [ ] Screenshot/demo cannot be mistaken for a chatbot (no answer paragraph).
- [ ] Time spent after "good enough" is not spent on CSS. If polish remains, it is leftover, not a gate.

## Phase 4 — Optional: Embedding-Model Sensitivity

**Objective**: Test whether the Phase 2 ranking is an artifact of one model. Separate table, not a blended leaderboard.

**Entry Gate:** Phase 2 complete. Only run this if you still have calendar **and** the first table's caveats already say the result may be model-specific. Do not use this phase to avoid publishing Phase 2.

**Deliverables:**
- Second pinned `model_id`; full re-ingest of all three strategies (or at least winner + baseline).
- Second report table; a short note: ranking **held** / **reordered** / **inconclusive**.
- Prefix/metric differences documented so you do not compare cosine-384 to IP-1536 in one ranking.

**Exit Gate:**
- [ ] Written sensitivity note exists.
- [ ] No average of the two models presented as "the" score.
- [ ] If rankings conflict, later `docqa-basic` default is chosen explicitly (e.g. recursive + model A) with the conflict cited.

Skip this phase without guilt if labels were the scarce resource. A clean Phase 2 beats a messy two-model grid.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the index green" — if any of the following hold:

1. **No labels**: UI or extra chunkers proceed without eval set v0. Roll back to Phase 0. This is the actual kill.
2. **Confounded table**: model, extractor, or k differs across rows of a published comparison. Retract the table; re-run. [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Generator creep**: a chat box, RAG prompt, or "summarize hits" lands in this repo. Revert. That work belongs in `docqa-basic`. [ADR-005](./04_architecture_decision_records.md#adr-005).
4. **Semantic p-hacking**: percentile/threshold searched until the 40-query set says win, without reporting the search. Invalid experiment; freeze params from a **pre-registered** default and re-run once.
5. **Silent fallback**: semantic path falls back to recursive without flags, then "semantic" takes credit. Kill the run.
6. **Soup attributed to chunkers**: Phase 0 extract check skipped, PDFs unreadable, table still published as a chunking result. Split the table or drop PDFs; do not ship the lie.
7. **Scope inflation**: hybrid, rerank, k8s, freshness queues, multi-tenant ACL. Remove them. They are not this scenario.
8. **Global-best language** in a README ("we proved semantic chunking is better"). Rewrite to scoped claims or delete the sentence.
9. **Secrets in a cloud embed API** without a decision. Prefer local; if API, the corpus classification must allow it. Stop ingest if it does not.
10. **Phase 0 corpus is actually huge** (tens of thousands of PDFs, hours-long semantic sentence passes as the *happy* path). Re-scope the folder. Do not quietly become RAG-at-scale without that project's gates.

Rollback is always to the last phase whose exit gate was honestly green. After a kill, the operator still has: file counts, extract failure rate, eval-set size, any baseline Success@k actually measured, and a recommendation — shrink corpus, fix PDF extract, finish labels, or stop calling it a benchmark. They do not get a confident "best chunker" nobody measured.
