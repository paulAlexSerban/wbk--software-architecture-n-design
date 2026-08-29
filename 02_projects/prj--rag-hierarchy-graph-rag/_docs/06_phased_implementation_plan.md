# Hierarchical vs Graph RAG — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases are sequential. **Phase 0 is not optional and is not "documentation theater"** — extracting `COMPETITOR_OF` from a sector that never names competitors is how you spend a week on a graph of noise. Phase 4 is the only "done." A running Neo4j without the table is an unfinished lab.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never drop unanswerable items or rewrite gold from graph output to make a gate look green.**

Calendar assumptions: one operator, documentation already exists (this folder). Implementation calendar is **study-scale**, not production-launch: on the order of 2–4 weeks of focused work if Phase 0 cooperates, longer if EDGAR HTML and competitor-naming fight back. Extraction and eval LLM time is wall-clock as well as money. The backfill-the-graph job is the long pole only after the inventory says the graph is worth building.

## Phase 0 — Corpus and Relation Inventory (before any "smart" index)

**Objective**: Replace the load-bearing guesses — "10-Ks contain a competitive graph," "Exhibit 21 is parseable," "the supplier query is in-scope" — with a written inventory. A wrong sector discovered after Neo4j is a failed week that looked like AI engineering.

**Deliverables**:
- **Issuer list** (8–12), sector rationale, and a matrix: for each pair, did A's Item 1/1A **name** B? Mark in-corpus vs mention-only competitors.
- **Filing manifest**: CIK, accession, fiscal year, SHA, EDGAR URL. Polite download (`User-Agent` per SEC fair access). Completeness check: every manifest row has bytes.
- **Section-split spike** on 2–3 filings: can Item 1 / 1A / 2 / Ex21 be isolated? Notes on HTML horrors. Ex21 missing/incorporated-by-reference called out per issuer.
- **Relation inventory** (citations, not vibes):
  - Named competitors: count per issuer, example excerpts.
  - Exhibit 21: row counts, jurisdiction vocabulary (Delaware vs country vs country+state).
  - Item 2 locations: whether they are usable as `LOCATED_IN` or too messy.
  - **Supplier names: expected ~zero.** Any exception logged. Schema still has no `SUPPLIES` unless a new ADR is opened — default is still no.
- **Flagship query decision**, written:
  - Keep T3 (`competitors_subsidiaries_in_jurisdiction`) **if** ≥ N in-corpus competitor pairs exist (operator sets N in this phase, working: **at least 3 pairs**, else T3 eval slice will be a toy).
  - If N is 0: **kill graph as a comparison column** or shrink graph claims to T2 (subsidiaries of the issuer only) — which hierarchy/table-parse may already win. Do not proceed to Phase 3 "to have Neo4j."
- Gazetteer draft for jurisdictions that actually appear.
- Feasibility call logged (proceed / proceed-without-T3 / kill-graph-column / kill-project).

**Exit Gate**:
- [ ] Manifest SHA-complete; fair-access download documented.
- [ ] Relation inventory exists with **citations** into real excerpts, not "semiconductors are competitive."
- [ ] Supplier-query disposition: unanswerable bait, not gold.
- [ ] T3 feasibility: pair-count recorded; if below threshold, graph scope explicitly reduced or skipped — **written**, not hoped.
- [ ] Parser spike: at least two filings fully split; one Ex21 parse sketched by hand/rules.
- [ ] Alias list started (legal names + obvious abbreviations for the issuer set).

Do not start hierarchical summaries or LLM extraction in this phase except a **tiny** prompt experiment on one Item 1A to see if competitor JSON is plausible. That experiment does not load Neo4j.

## Phase 1 — Baseline Index, Frozen Eval Set, Harness Skeleton

**Objective**: Create the **control row** and the **questions**, in that spirit: questions are authored against filings, not against a graph. The harness can score baseline before any other topology exists.

**Deliverables**:
- Section parser v0 good enough for all manifest filings (or filings that fail are dropped from the manifest **with a note**, not silently).
- Baseline chunk + embed + retrieve + shared generator + citations.
- **Eval set v1** written and frozen: slice mix per [System Design §10.1](./03_system_design.md#101-question-set-schema). Gold lists for T2/T3-shaped questions built from **reading Ex21 and Item 1A**, stored as canonical names.
- Tiny **dev split** (≤10 q) separated if any threshold tuning will happen later.
- Harness: run `qid × baseline`, persist cells, compute RAGAS + list-F1 + refuse scoring **even if** hierarchical/graph stubs error.
- Baseline **row 1** numbers recorded (may be ugly). Cost/latency recorded.

**Exit Gate**:
- [ ] Eval set versioned; hash of questions file recorded. After this gate, edits are v1.1+ with changelog — **not** silent.
- [ ] Gold for multi-hop was not produced by a model reading the graph (the graph does not exist yet).
- [ ] Unanswerable slice includes at least one supplier-bait item and at least one out-of-corpus fact.
- [ ] Baseline cells complete for all qids (or errors listed). RAGAS runs are pinned to a model id.
- [ ] A reviewer (or future-you after a night) can answer "what would T3 gold look like" from the gold file without opening Neo4j.

Do not implement auto-merge or Cypher in this phase beyond interfaces/stubs.

## Phase 2 — Hierarchical RAG vs Baseline

**Objective**: Test the **grain** hypothesis. If hierarchy does not move the long-section slice, say so and still keep the column — a tie is data.

**Deliverables**:
- Tree build: filing → section → children (same child grain as baseline).
- Auto-merge retrieve (Mode A default) + stuff budget + truncation traces.
- Section summaries for optional Mode B; **default generate does not stuff summaries**.
- Harness run `qid × hierarchical`. Same generator settings as baseline.
- Short qualitative traces on 5 long-section questions: did merge fire? did truncation fire? wrong issuer?

**Exit Gate**:
- [ ] Hierarchical cells complete.
- [ ] Table draft has two rows (baseline, hierarchical) with slice breakdowns — not only a micro-average.
- [ ] Stuff budget equals baseline's generate budget (or difference labeled).
- [ ] No CRAG, no reranker unique to this column.
- [ ] Decision recorded: Mode A vs Mode B as the **frozen hierarchical default** for Phase 4. Further tweaking uses only the dev split.

If hierarchical is strictly worse everywhere, **keep it in the table**. Deleting a losing column is how the report starts lying. You may add a sentence "would not ship this."

## Phase 3 — Graph Build, Precision Gate, Graph Eval

**Objective**: Build the join index **only if Phase 0 left graph in scope**. Make extraction quality **visible** before anyone reads graph RAGAS.

**Entry Gate**: Phase 0 T3 (or reduced-graph) decision is "proceed." If Phase 0 killed the graph column, **skip to Phase 4** with two rows and a written why. Do not "just load RELATED_TO" to have a screenshot.

**Deliverables**:
- Alias table complete enough for issuers + high-frequency legal variants.
- Exhibit 21 deterministic loader; row-level fail = review queue, not guess.
- LLM extractor on Item 1/1A/2; closed schema; provenance excerpts; `build_id`.
- Neo4j constraints, undirected-pair `COMPETITOR_OF` policy, `in_corpus` flag.
- Template library T1–T4 + T5 none; classifier; param-only Cypher; verbalizer.
- **Spot-check sheet** per [System Design §7.4](./03_system_design.md#74-spot-check-protocol-the-phase-3-gate), thresholds written **before** scoring the sample (write the numbers at the start of this phase if not already in System Design).
- Harness run `qid × graph` **only if** spot-check passes. If it fails: fix extract/parse, new `build_id`, re-check. If it fails twice: `DQ-FAIL` column rules apply.
- Router diagnostics: template accuracy vs `template_id_expected`.

**Exit Gate**:
- [ ] Spot-check pass **or** explicit `DQ-FAIL` (no publishing a win).
- [ ] T3 Cypher includes `c.in_corpus = true`.
- [ ] Empty template / bind fail / empty path → refuse, not generate-from-zero.
- [ ] Graph cells complete if not DQ-FAIL.
- [ ] Extraction token cost recorded on the build card.
- [ ] No NL-to-Cypher on this column; no silent hierarchical fallback.

If competitor precision is the failure, **do not** "fix" it by adding web search. That is a different corpus.

## Phase 4 — Comparison Report (the product)

**Objective**: Publish the table and the narrative. This phase has no new topology.

**Entry Gate**: Phase 1 complete. Phase 2 complete. Phase 3 complete **or** skipped/DQ-FAIL with paperwork. Missing baseline is an automatic fail of Phase 4.

**Deliverables**:
- Final markdown (or equivalent) report in the implementation repo (this workbook's docs may **link**; they do not pretend the numbers exist before the build). Columns per [System Design §10.3](./03_system_design.md#103-the-table-minimum-columns). Header pins: corpus SHA, eval set version, model ids, three `build_id`s, RAGAS version.
- Narrative, required sections:
  1. Phase 0 inventory outcome (including supplier reality check).
  2. Where hierarchical won/lost/tied and whether auto-merge fired on the wins.
  3. Where graph won/lost/tied; extraction precision; how many T3 questions were even possible.
  4. Unanswerable slice: who hallucinated suppliers.
  5. Cost: build vs query; whether you would pay extraction again for this query mix.
  6. What you would ship: baseline only / +hierarchy / +graph-for-templates / none of it as a product.
- Traces bundle (or a sampled 10 qids × 3) for a skeptical reader.
- Explicit **non-claims**: not Microsoft GraphRAG, not live EDGAR, not investment research.

**Exit Gate**:
- [ ] Table has baseline row. Hierarchical row. Graph row or DQ-FAIL/skipped with reason.
- [ ] Slice-level numbers exist; a single micro-average is not sufficient.
- [ ] Footnote on RAGAS context-recall incomparability (chunks vs verbalized triples).
- [ ] Narrative states a negative result if that is the truth.
- [ ] No screenshot-only appendix pretending to be this gate.

After this gate, optional work (agentic tool routing, a fourth ablation row) is a **new** eval version, not a quiet edit of v1 numbers.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not "keep the notebook green" — if any of the following hold:

1. **Feasibility miss**: Phase 0 finds no extractable typed relations worth a graph **and** no long-section problem worth hierarchy. The honest output is "naive RAG is enough on this corpus," plus the inventory. Building Neo4j anyway is vanity.
2. **Gold contamination**: questions or list-gold updated from graph/hierarchical output without a version bump and changelog. Invalidate the table; restore v1.
3. **Precision gate fail published as a win**: rewrite the report to DQ-FAIL or re-extract. Do not lower the threshold after seeing F1.
4. **Confounded columns**: CRAG/rerank/fallback/summary-generate applied to one topology. Roll back the confound or split a labeled extra row **and** re-run the clean three.
5. **NL-to-Cypher (or string-interpolated Cypher) on the published graph path.** Roll back to templates.
6. **Supplier (or other undisclosed) relations added to the schema** to "make the roadmap query work." Delete the type; restore bait items as unanswerable.
7. **EDGAR fair-access violation** / ban. Stop crawl. Incomplete corpus cannot support Phase 1+.
8. **Pressure to omit the unanswerable slice** so averages "look like graph RAG works." That request is a kill criterion for quality.

Rollback is always to the last phase whose exit gate was honestly green. After a kill, the artifact is still the inventory, the baseline numbers if they exist, and a recommendation: shrink claims, change sector, or stop. The reviewer does not get a confident multi-hop system you never had.
