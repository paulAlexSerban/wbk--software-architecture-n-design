# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Three Parallel Topologies; the Comparison Report Is the Product

**Status**: Accepted

**Context**: The roadmap asks to build hierarchical RAG *and* a knowledge-graph variant and compare both against hybrid/naive on the same corpus. The failure mode in portfolios is to pick a winner early (usually the graph, because it photographs well), delete the baseline, and narrate a win. A second failure mode is to ship three demos with three different question sets. Neither is a comparison.

**Decision**: Maintain three retrieve-then-generate paths over **one** corpus SHA and **one** frozen question-set version, with a **shared generator family**. The independent variable is index topology. The deliverable that marks the project done is the [comparison table and narrative](./06_phased_implementation_plan.md) (Phase 4), not a running Neo4j. Automatic topology selection (an agent picking the tool) is out of v1 — it confounds the table. Ablations (hybrid baseline, rerank, silent graph→hierarchical fallback, summary-stuffed generate) are extra **labeled rows**, not silent mutations of the three columns.

**Consequences**:
- (+) Isolates the claim "graph makes multi-hop tractable" from "we also added a better prompt and a reranker."
- (+) Allows a negative result (graph loses, hierarchy ties baseline) to still be a successful architecture artifact.
- (–) Triple index build and triple eval cost. Accepted; that cost *is* the study.
- (–) No "smart router" demo in v1. Reviewers who want agentic RAG should look at roadmap 2.3 after this table exists.
- **Alternative rejected**: one unified pipeline that "uses the graph when needed." Without a pinned baseline row, "when needed" is unfalsifiable.
- **Revisit trigger**: Phase 4 table exists. Then a router *informed by the table* is a new project, not a hotfix.

## ADR-002: Offline, Section-Scoped Extraction — Not Whole-Document IE

**Status**: Accepted

**Context**: A 10-K is mostly MD&A, financials, and boilerplate. Generic NER over the whole submission produces auditors, law firms, exchange names, and "the Company," then a graph that looks dense and means little. Extraction LLM cost scales with tokens; most tokens cannot support `COMPETITOR_OF` / `SUBSIDIARY_OF` / location edges. Exhibit 21 is a list, not prose.

**Decision**: Extract only Item 1, Item 1A, Item 2, and Exhibit 21. Exhibit 21 is **deterministic parse first**. Prose items use a **closed JSON schema** with no `suppliers` field. Extraction is a **batch, offline** job keyed by `section_id` and `build_id`. Query time never calls the extractor. Out-of-scope text is not in the study indices. See [System Design §7](./03_system_design.md#7-extraction-pipeline).

**Consequences**:
- (+) Cost stays proportional to the sections that can actually grow the schema.
- (+) Exhibit 21 precision can be high without a frontier model.
- (+) Re-extraction is a rebuild, reviewable, not a side effect of traffic.
- (–) Facts that live only in MD&A or 8-Ks are invisible. If Phase 0 needs them, **widen scope in a new corpus version**, do not quietly index "the rest."
- (–) Section parser bugs starve the graph. Parser quality becomes load-bearing.
- **Alternative rejected**: "extract everything, filter later." Later never comes; the graph fills with junk that templates will happily walk.
- **Alternative rejected**: query-time extraction ("read the retrieved 10-K and pull triples now"). That is RAG with extra latency, not a graph index.

## ADR-003: Template-Selected Cypher as the Primary Graph Path; No NL-to-Cypher Serving

**Status**: Accepted

**Context**: Text-to-Cypher demos fail in three correlated ways: hallucinated relationship types, unbounded variable-length paths (`[*1..5]`) that explode, and string-concatenated queries (injection). They also make eval non-reproducible: the same question can compile to different graphs of work. The study needs a **closed** query surface so "graph retrieval" means something.

**Decision**: A classifier binds the question to a **closed template library** (v1: competitors-of, subsidiaries-in-jurisdiction, competitors'-subsidiaries-in-jurisdiction, properties-in-jurisdiction, plus an explicit cannot-answer class). Slot values are parameters, never interpolated. Issuer and jurisdiction must bind via alias table / gazetteer or the path refuses. Unconstrained NL-to-Cypher is not on the published `graph` column. A lab notebook experimenting with it, if it exists, is labeled experimental and off the main table.

**Consequences**:
- (+) Bounded latency and bounded blast radius; injection surface is the template author, not the user string.
- (+) Router accuracy is measurable (`template_id_expected`).
- (–) Questions that *could* be answered with a clever ad-hoc Cypher but are not in the library will refuse. That is honest: v1 graph RAG is **schema-shaped QA**, not general graph QA.
- (–) Marketing "the system understands the knowledge graph" overclaims. The system understands five templates.
- **Alternative rejected**: LLM writes Cypher against the full schema, with a linter. Linters do not catch a semantically wrong but valid `MATCH`. Not good enough for a published comparison column.
- **Revisit trigger**: after Phase 4, if a large slice of `none` classifications are clearly one missing template, add **one** template, bump eval version, re-run all three columns.

## ADR-004: Hierarchical RAG Means Parent-Child + Summary Index + Auto-Merge, Not Recursive Splitting Alone

**Status**: Accepted

**Context**: LlamaIndex tutorials often label "recursive character split" as hierarchical. It is still a flat list of chunks with a genealogy nobody retrieves. The failure mode on 10-Ks is **wrong grain**: the answer is the Item 1A section, the index returns three 512-token windows that each miss a clause. A second failure: stuffing **summaries** into the generator as if they were the filing, inventing numbers that were never in the 10-K.

**Decision**: Build an explicit tree `filing → section → child chunks`. Default query path is **child retrieval + auto-merge to section parent** when child-hit density crosses a threshold, under a shared token stuff budget with baseline. Section (and optional filing) **summaries are retrieval-selection nodes**, not default generate context. Generate from `node_role=source` (children and merged parents). Summary-stuffed generation, if tried, is a labeled ablation. See [System Design §4](./03_system_design.md#4-hierarchical-index-mechanics).

**Consequences**:
- (+) Targets chunk-boundary bleed and long-item questions inside **one** filing.
- (+) Keeps hierarchical comparable to baseline (same child grain, same generate budget).
- (–) Merged parents can still blow the budget; truncation must be traced or "hierarchy lost" is uninterpretable.
- (–) Does **not** implement cross-filing joins. Anyone who expected hierarchy to solve the flagship multi-hop is disappointed by construction — that disappointment is documented, not a bug.
- **Alternative rejected**: only a summary index over whole 10-Ks. That is map-reduce summarization, not hierarchical retrieval of source text.

## ADR-005: Bounded Issuer Set and a Curated Alias Table; Not General Entity Resolution

**Status**: Accepted

**Context**: The same issuer appears as a CIK, a legal name, a d/b/a, and "the Company." Competitors are named inconsistently. General ER (clustering embeddings of names, Wikidata linking) is a research program. Silently treating string equality as identity splits the graph; silently treating embedding similarity as identity **merges competitors with their customers**.

**Decision**: Cap the corpus at a **named** 8–12 issuers in one sector, chosen in Phase 0 so that at least some **named competitors are also in-corpus issuers** (otherwise T3 multi-hop is empty by construction). Identity is `canonical_id` (CIK for in-corpus). An operator-maintained **alias table** maps normalized strings to ids. `"the Company"` resolves using **section issuer context**. Unresolved orgs are non-traversable by multi-hop templates. Growing past the cap requires a new ER story and a new project, not a bigger CSV.

**Consequences**:
- (+) ER is reviewable in an afternoon.
- (+) `in_corpus=false` mention nodes cannot sprout fake Exhibit 21 subsidiaries.
- (–) The study does not prove graph RAG on "all of EDGAR." Claiming that is a lie.
- (–) Alias table rot if names are added carelessly. Mitigation: corpus versioning.
- **Alternative rejected**: skip aliases and hope the LLM extractor emits canonical names. It will not.

## ADR-006: RAGAS Plus a Custom Multi-Hop Judge; Freeze the Question Set Before Clever Pipelines

**Status**: Accepted

**Context**: RAGAS faithfulness/relevancy/context precision/recall are the shared language with the rest of this workbook. They do **not** score "did you traverse two hops and return the right subsidiary list?" Faithfulness can be high against **wrong retrieved graph facts**. Writing the eval set after browsing Neo4j is p-hacking. Using different questions per topology is not a comparison.

**Decision**: Phase 1 authors a versioned question set (slices: single-hop, long-section, multi-hop, out-of-schema, unanswerable/supplier-bait) **before** hierarchical and graph retrievers exist. Gold list questions are built from **filings** (Exhibit 21, Item 1A names). Scoring: RAGAS on all cells **and** set-F1 vs gold on list/multi-hop **and** refuse-credit on unanswerable. Graph context for RAGAS is the verbalized facts+excerpts. Do not retune merge thresholds or templates on the frozen set; use a tiny dev split or freeze defaults. See [System Design §10](./03_system_design.md#10-eval-harness-mechanics).

**Consequences**:
- (+) The table can show graph winning multi-hop F1 while tying or losing RAGAS on single-hop — the interesting, honest pattern.
- (+) Unanswerable items punish fluent hallucination regardless of topology.
- (–) LLM-as-judge (RAGAS) is noisy and costly. Pin model ids; do not cherry-pick retries.
- (–) Context-recall numbers are not strictly comparable across chunk vs graph context without a footnote. The report must carry that footnote.
- **Alternative rejected**: "a few hand examples in the README." That is a demo, not this project.
- **Alternative rejected**: RAGAS only. It cannot be the multi-hop differentiator the roadmap asked for.

## ADR-007: Frozen Snapshot; No Real-Time Filing Ingestion

**Status**: Accepted

**Context**: Production research systems watch EDGAR, re-chunk, re-extract, and worry about amendment 10-K/A, 8-K material events, and embargo. That operational loop is a product. It also makes eval a moving target: yesterday's gold is today's incomplete graph. This project's customer is a comparison on a pinned SHA.

**Decision**: Download once (politely), checksum, never query EDGAR at answer time. No watchers, no incremental extract-on-new-accession, no "freshness SLO." A new fiscal year is a **new corpus version** and a full rebuild + re-eval. Freshness is explicitly out of scope.

**Consequences**:
- (+) Eval is replayable. The table's header can print corpus SHA.
- (+) Scope stays inside a laptop and a week-scale study, not an EDGAR platform.
- (–) The design does not answer "how would this run in production for an analyst desk." That write-up, if needed, belongs in Future Enhancements of the architecture doc, not in v1 runtime.
- **Alternative rejected**: incremental ingest "to look production-grade." It looks like unfinished serving infrastructure and invalidates Phase 4.

## ADR-008: Extraction Precision Gate Before the Graph Column Is Publishable

**Status**: Accepted

**Context**: ADRs 001–007 can still produce a beautiful, wrong graph. Multi-hop F1 against gold will then measure the extractor, but a reader will attribute the number to "graph RAG." Shipping that number without a human spot-check is how this project becomes a cautionary tale.

**Decision**: Phase 3 includes a **written spot-check** ([System Design §7.4](./03_system_design.md#74-spot-check-protocol-the-phase-3-gate)) with thresholds set **before** seeing eval scores. If the gate fails, the comparison report either omits the graph column or marks it `DQ-FAIL` with the spot-check attached. It does not publish a win. Improving prompts and re-extracting is allowed; lowering the threshold after a fail is not.

**Consequences**:
- (+) Prevents laundering extraction errors as retrieval science.
- (–) May kill the photogenic part of the portfolio for a given sector. That is a successful Phase 0/3, not an embarrassment.
- **Revisit trigger**: none for v1. Threshold changes are a new eval version with a written justification.
