# Naive RAG Document Q&A — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not documentation theater** — an eval set written after the prompt was tuned is a vanity number, and a corpus chosen after Retrieval "looked bad" is overfitting.

Phases 0–5 are sequential. This is **not** the multi-month backfill of [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/_docs/06_phased_implementation_plan.md). Calendar is on the order of **days to a couple of weeks**, dominated by eval-question writing, PDF extract checks, and k8s reps — not by embedding time. Anyone who schedules "naive RAG plus hybrid plus RAGAS" as one phase has not read [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-why-not-just-build-the-good-version).

Rollback/kill criteria at the bottom apply at every phase. In particular: **do not add a reranker, BM25, or RAGAS to pass a gate.** That is a failed gate, not a shortcut.

## Phase 0 — Corpus, Eval Set, and Model Pins (before services)

**Objective**: Freeze the knowledge base, the questions you will be scored on, and the model IDs. Refuse to implement Retrieval until the eval set exists.

**Deliverables:**
- **Corpus named in writing**: path, file types, document count, whether PDFs are in or markdown-only. Confirm it sits inside the [ceiling](./01_business_overview.md#where-the-ceiling-actually-is) (tens to low hundreds of docs, single trust boundary, low stakes). Resume/portfolio or a *personal* notes dump. Not "the company wiki."
- **Spot-checked extracts**: at least one file per type (especially one PDF if PDFs are in). Human reads the extract. If it is soup, drop PDFs from v1 or fix the extractor *choice* — do not plan to "make up for it with embeddings."
- **Eval set v0**, frozen: **≥ 20** items of the form `{id, question, relevant_doc_id(s), optional relevant_span, notes}`. Must include:
  - paraphrase questions (dense retrieval should have a chance),
  - **≥ 3 exact-token probes** (slugs, names, dates),
  - **≥ 1 chunk-boundary probe** (answer sits across a likely split),
  - **≥ 1 multi-part / compare question**,
  - **≥ 2 distractor questions** where another document shares vocabulary.
- **Scoring rubric** written down: retrieved-right-chunk (Y/N at given k), answer-supported-by-retrieved-text (Y/N), answer-correct-in-corpus (Y/N). Not a 1–5 vibe score as the primary metric.
- **Pins**: `embed_model_id` + dimension + metric; `llm_model_id`; working `chunk_size` / `overlap` / splitter name; working `k` (default 5) and `k_max`.
- **Data-handling note**: remote APIs will see chunk text. If that is unacceptable, switch to local models *now* or shrink the corpus to public files.
- One-page unknowns log: extractor quality, token vs character chunking, whether Compose-only is enough for the k8s gate (it is not — Phase 4 still needs manifests applied somewhere).

**Exit Gate:**
- [ ] Document count and types recorded; ceiling check passed (or project killed — see standing criteria).
- [ ] Eval set ≥ 20 with the probe categories above, **committed or otherwise frozen** before Phase 1 prompt/template work.
- [ ] At least one extract per file type has been read by a human.
- [ ] Model IDs and chunker params written; changing them later requires a new Phase 5, acknowledged.
- [ ] Explicit **not in corpus** list (no extra wiki dump "for later").

Do not implement services in Phase 0. Do not peek at embeddings to rewrite questions.

## Phase 1 — Ingestion Service

**Objective**: Files become rows. Failures are counted. No Ask path.

**Deliverables:**
- Ingestion service per [Architecture](./02_architecture_document.md#1-ingestion-service) and [System Design §2–3](./03_system_design.md#2-chunking).
- `document` / `chunk` / `ingest_batch` in Postgres+pgvector. Active-pointer flip in a transaction ([ADR-007](./04_architecture_decision_records.md#adr-007)).
- Unsearchable log for empty/unsupported extracts. No empty placeholder chunks.
- Output of `POST /ingest` (or CLI): counts that an operator can reconcile with `ls`.
- Second ingest run proves replace/rollback: new batch becomes active; old chunks not mixed into queries once Retrieval exists. Can be verified with SQL in this phase.

**Exit Gate:**
- [ ] Every corpus file is `indexed` or `unsearchable`; counts match.
- [ ] `chunk_count` is sane vs document lengths (order-of-magnitude check against Phase 0 guesses). If mean chunks/doc is 40 on "short markdown," the splitter is wrong — fix params **and** note that eval boundary probes may need a re-look, still before scoring answers.
- [ ] Re-ingest is idempotent at the batch level (one active batch).
- [ ] No LLM calls exist in this service.
- [ ] Failed embedding of a chunk does not mark the document indexed without a log.

If extract quality is catastrophic on a type you refused to drop in Phase 0, **stop** and drop the type. Do not proceed to Retrieval over soup.

## Phase 2 — Retrieval Service

**Objective**: `POST /retrieve` returns top-k with text and scores. Still no generator.

**Deliverables:**
- Retrieval service; same `embed_model_id` as the active batch; fail closed on mismatch ([ADR-003](./04_architecture_decision_records.md#adr-003)).
- Manual spot check: for 5 eval questions, print top-k filenames/scores. Not scored yet — that is Phase 5 — but sanity ("all zeros," "wrong dimension," "inactive batch") is caught here.
- k honored; k_max enforced.
- No similarity cutoff shipped.

**Exit Gate:**
- [ ] Retrieve against a missing active batch is 4xx, not an empty LLM-shaped response.
- [ ] Model mismatch is an error, not silent search.
- [ ] Top-k hydrates **text**, not ids only.
- [ ] Spot check recorded (notes, not a marketing table). If every question returns the same boilerplate chunk, fix ingest/chunker **without** adding BM25. If that cannot be fixed, the corpus may be too homogeneous — strengthen eval notes, do not silently add lexical search.

No production users. No UI required.

## Phase 3 — Generation Service and Ask Path

**Objective**: End-to-end `POST /ask` for every eval question, right or wrong. Failures logged, not hidden.

**Deliverables:**
- Generation service; calls Retrieval; prompt template with `prompt_template_id`; [ADR-005](./04_architecture_decision_records.md#adr-005) synchronous; [ADR-006](./04_architecture_decision_records.md#adr-006) empty short-circuit.
- `query_log` with question, chunk ids, scores, stuffed text (or equivalent), answer, model IDs, empty_retrieval flag.
- Run **all** eval questions once. Store logs. **Do not** iterate the prompt to maximize correctness before the first full dump. A single obvious bug (template dropped context, wrong variable) may be fixed; then re-run **all**. Gold-plating one question is a kill-adjacent smell.
- Canned empty path tested by pointing at an empty database or a throwaway batch.

**Exit Gate:**
- [ ] One log row per eval question (plus empty-path test).
- [ ] Empty retrieval did not call the LLM (verify via logs/metrics/provider dashboard).
- [ ] Prompt forbids outside knowledge; template id recorded.
- [ ] No streaming, no chat history, no retry-on-I-don't-know.

Scoring is **not** this gate. This gate is "the system produced artifacts to score."

## Phase 4 — Docker Compose and Kubernetes

**Objective**: Three services + Postgres run as containers, then as k8s workloads. Infra reps. Not HA.

**Deliverables:**
- Docker Compose: Postgres with volume, three app services, env for secrets, documented `up` → ingest → ask.
- Kubernetes manifests: three Deployments (1 replica), Services (**ClusterIP**), Postgres (StatefulSet or a known dev database), ConfigMaps/Secrets, PVC. Applied to kind, minikube, or an existing cluster.
- Notes: how embed/LLM keys enter the cluster; no LoadBalancer/Ingress "for convenience" on a public IP without auth ([System Design §11](./03_system_design.md#11-security-brief)).
- Image build in CI is optional; locally built images are enough if documented.

**Exit Gate:**
- [ ] Compose path: ingest + ask succeed against composed Postgres.
- [ ] k8s path: all three Deployments ready; ask succeeds in-cluster (port-forward or a Job).
- [ ] Services are not accidentally public.
- [ ] Replicas = 1; no HPA.
- [ ] Rollback story for Postgres PVC loss is "re-ingest," documented, not a pretend HA cluster.

If k8s access is truly unavailable, **kind is the fallback**, not "skip Phase 4." Skipping Phase 4 is skipping a stated goal of the scenario (infra reps). Compose-only is a partial credit that should be labeled as such — it is not the gate.

## Phase 5 — Baseline Capture (the actual done state)

**Objective**: Publish the number later tiers must beat, plus a failure-mode catalog with real examples. This phase is the product.

**Entry Gate:** Phases 1–4 green. Eval set still the Phase 0 freeze (or a documented v1 with reason — adding questions is allowed; **removing ones that failed is not**).

**Deliverables:**
- Scored table for all eval items: retrieved-right @k, supported-by-context, correct-in-corpus. Include precision@k summary.
- **Failure-mode catalog** matching [System Design §9](./03_system_design.md#9-known-failure-modes): for each of the nine modes, a real eval example **or** "probe attempted, did not fire, here's the question." Empty catalog = failed gate.
- Pins dump: chunker params, k, model IDs, prompt_template_id, corpus checksum/file list, chunk_count.
- Short narrative: what naive RAG got right on this corpus (often paraphrase FAQs) and what it got wrong (often slugs, bleed, mash-ups).
- Explicit statement: **no rerank/hybrid/RAGAS was used.**

**Exit Gate:**
- [ ] Table complete; no dropped failing questions.
- [ ] Catalog complete.
- [ ] Pins dump complete so a later project can re-run naive as a control.
- [ ] Baseline report lives next to the docs (or in this `_docs/` tree as a dated artifact once code exists). This documentation project treats the *template* of that report as the gate; a code build fills the numbers.

After Phase 5, **stop this project.** Next work is a new repo/project (§1.1 `retrieval-x` on the same corpus), not a v1.1 of naive RAG.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "make naive RAG nicer" — if any of the following hold:

1. **Ceiling breach**: corpus, user count, or stakes leave the envelope in [Business Overview](./01_business_overview.md#where-the-ceiling-actually-is). Honest output: this is the wrong design. Redirect to §1.1 / §1.3 / [prj--rag-pipeline-at-scale](../../prj--rag-pipeline-at-scale/). Do not add Pinecone and ACLs here.
2. **Baseline contamination**: BM25, rerank, query rewrite, semantic chunking, similarity cutoff, RAGAS-in-runtime, or streaming "because the demo." Revert the feature; if already scored, discard the score and re-run naive.
3. **Eval set rot / overfitting**: questions rewritten to match retrieved chunks; failing items deleted; prompt iterated on the full set until green. Restore the freeze; Phase 5 from a clean first dump.
4. **Mixed embedding models** in one active batch, or Retrieval embedder ≠ ingest. Fail closed; full re-ingest.
5. **Public unauthenticated Ask** on a cluster with a non-public corpus. Kill the Service exposure. Treat as a data incident if traffic was possible.
6. **Placeholder chunks** for failed extracts, or zero-vectors, to make counts look complete. Delete; mark unsearchable.
7. **Scope creep into a platform**: queues, API gateway, semantic cache, multi-tenant tables, conversation memory. Those are other projects (`llm-gateway`, `context-forge`, §1.3).
8. **Phase 5 skipped** in favor of a screenshot. The project is not done. A demo without a table is a lab.

Rollback is always to the last phase whose exit gate was honestly green (including the previous ingest batch). After a kill, stakeholders still get: corpus size, eval-set draft, extract notes, and a recommendation — shrink scope, change project, or accept a monolith toy. They do not get a "production RAG" this design never was.
