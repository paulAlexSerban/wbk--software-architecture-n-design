# Hierarchical vs Graph RAG: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design retrieval over a **real domain corpus** such that index topology is a first-class architectural decision, not a library default. The corpus is a bounded set of SEC 10-K filings. The question mix includes ordinary single-hop lookups ("what does Company X say its principal products are?") and **multi-hop compositional questions** ("which subsidiaries of X's named competitors are located in jurisdiction Y?").

Three systems share that corpus and that question set:

1. **Baseline** — flat chunks, dense retrieval, optional BM25 hybrid. The naive/hybrid RAG this workbook already documented. It is the control, not the embarrassment.
2. **Hierarchical RAG** — a document → section → chunk tree with summary nodes and parent-child (auto-merging) retrieval. The bet: long, structured filings lose answers at chunk boundaries and bury them in 200-page PDFs; retrieving at the wrong grain is the failure, not missing a knowledge graph.
3. **Graph RAG** — offline entity/relation extraction into Neo4j, then retrieval by **constrained graph traversal** (a small library of Cypher templates, not free-form text-to-Cypher). The bet: some questions are path queries. Vector search cannot compose a path.

The design must answer, concretely:

1. **Which questions a vector index cannot answer well**, and why that is a topology problem rather than a "raise k / add a reranker" problem.
2. **What a 10-K actually discloses**, versus the interview query that assumes it discloses a supplier graph. If the corpus cannot support a relation, no index topology invents it.
3. How hierarchical retrieval is built (parent-child chunking, summary index, auto-merge) and **what it still cannot do**.
4. How the knowledge graph is modeled, how extraction is scoped and checked, and how queries hit it **without** an unconstrained NL-to-Cypher generator.
5. How all three are evaluated on the **same frozen corpus and the same labeled questions**, with RAGAS plus a multi-hop correctness judge, such that "graph wins" is a cell in a table, not a blog title.
6. What is given up: live EDGAR, full-universe coverage, general graph QA, entity resolution at scale, and the claim that one topology dominates.

This is the **index-topology trap**. The naive answers — "just use GraphRAG, Microsoft published a paper," "just chunk smaller," "just extract everything into Neo4j" — are the failure. They either spend extraction budget on boilerplate, or they pretend a vector neighborhood is a join, or they evaluate a graph on questions the filings never answered. **The correct shape is three parallel indices, a question set written before any clever pipeline exists, and a comparison report that is allowed to say the graph lost.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true: extraction LLM spend, Neo4j operations, a schema that will be wrong for the next query type, hierarchical index rebuilds when section maps drift, and no promise that a multi-hop question becomes easy because you drew circles and arrows.

## The Trap, Stated Directly

"Graph RAG" in a product conversation is almost always used as if it meant **the system understands entities and can join them**. What it actually means, if you are honest, is: an LLM extracted some triples, you stored them, and a later query can walk those triples **if they exist, if they are correct, and if the query was anticipated**. Those are three independent failure modes.

| What people hear | What the constraint actually protects |
| --- | --- |
| "Hierarchical RAG" | Retrieval grain matches document grain. A 10-K is not a bag of 512-token windows. Parent-child and summaries are how you stop stuffing the wrong paragraph of Item 1A. |
| "Graph RAG" | **Path queries** over an extracted schema. Not "the LLM read the whole 10-K into a mind palace." Not Microsoft GraphRAG's community-summary tree (a different design; see Non-Goals). |
| "Index topology as an ADR" | You choose *what is indexed* (passages vs summaries vs triples) the way you choose a data model. You do not get all three for free by importing LlamaIndex. |
| "RAGAS comparison" | A table on a frozen eval set. Not a vibe that multi-hop "felt better." RAGAS will not, by itself, tell you the graph traversed two hops. That is a custom judge. |
| "Real domain corpus" | Filings you can name, sections you can cite, relations you can spot-check. Not a Wikipedia dump and a screenshot. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| One retriever that is best at everything | No. Single-hop lookups will likely be cheaper and as good (or better) on flat/hierarchical retrieval. Graph wins, *if it wins*, on a minority of query shapes. |
| Graph RAG answers "suppliers of competitors in Y" over 10-Ks | **Not from this corpus.** 10-Ks almost never name suppliers. See [The Supplier-Disclosure Reality Check](#the-supplier-disclosure-reality-check). |
| Automatic, general NL-to-Cypher | Not as the primary path. Hallucinated Cypher, unbounded traversals, and injection-shaped strings are the failure. Templates selected by a classifier are the v1 contract. See [ADR-003](./04_architecture_decision_records.md#adr-003). |
| Extraction that is "good enough if the model is frontier" | No. Extraction precision is the bottleneck. A 90% precise `COMPETITOR_OF` edge set still poisons multi-hop answers: one false competitor fans out into a wrong subsidiary list. Spot-check is a gate, not a nice-to-have. |
| Cross-company entity resolution ("TSMC" vs "Taiwan Semiconductor Manufacturing Company Limited" vs a subsidiary d/b/a) | Not at this scale, not silently. A bounded alias table plus human review for the named company set. Pretending an embedding of the name is ER is how the graph double-counts. |
| Live, complete EDGAR | No. Frozen snapshot, named issuers, named forms, named items. Freshness is out of scope. |
| Graph RAG that is cheaper than vector RAG | Almost never at build time. Extraction is an LLM pass over every in-scope section. Hierarchical is re-chunk + re-embed. Do not sell graph as a cost optimization. |

Capitulating to "just GraphRAG the 10-Ks" is how you pass the interview by ignoring what a 10-K contains. Capitulating to "hierarchical is just recursive character splitting" is how you pass it by renaming naive RAG. Capitulating to an eval set written *after* the graph schema exists is how you p-hack a table. Treating the comparison report as optional is how this project becomes two demos and a README that says "it depends."

## The Supplier-Disclosure Reality Check

The roadmap's flagship query is:

> which suppliers of X's competitors are based in Y?

That sentence is a clean illustration of **why vector RAG fails at multi-hop**. It is a bad evaluation item for **this corpus**. The two facts are not in conflict. Write both down before anyone extracts an edge.

What a Form 10-K typically contains, in the sections this project actually indexes:

| Section | Typical content | Relation you can hope to extract |
| --- | --- | --- |
| **Item 1 — Business** | Products, segments, sometimes named competitors, sometimes "principal markets." Rarely a supplier list. | Weak `COMPETITOR_OF`, `OPERATES_IN` / segment. |
| **Item 1A — Risk Factors** | Named competitors more often than Item 1; customer *concentration* (the opposite of suppliers); supply-chain *risk* in aggregate ("a limited number of suppliers") without names. | `COMPETITOR_OF` (sometimes). Almost never `SUPPLIES`. |
| **Item 2 — Properties** | Plants, offices, owned vs leased, **locations**. | `LOCATED_IN` for the *issuer's* sites, not competitors' sites. |
| **Exhibit 21 — Subsidiaries of the Registrant** | Legal names, jurisdictions of incorporation. The most reliable structured list in the filing. | `SUBSIDIARY_OF`, `INCORPORATED_IN`. High precision if parsed as a list, not as prose. |
| Remainder of the 10-K | MD&A, financial statements, legal proceedings, exhibits. Boilerplate, tables, XBRL. | Low yield per token. Out of extraction scope. See [ADR-002](./04_architecture_decision_records.md#adr-002). |

**Suppliers are a competitive-sensitivity disclosure.** Issuers name *customers* when a customer is 10%+ of revenue (Reg S-K concentration). They do not publish a vendor graph. Supply-chain language in Item 1A is almost always un-named: "we rely on a limited number of suppliers," "foundry capacity," "rare earths." A graph that extracts `(:Company)-[:SUPPLIES]->(:Company)` from that prose is extracting a hallucination with a legal caption.

**Competitors are sometimes named, often not.** "We compete with numerous companies, including A, B, and C" appears. "The semiconductor industry is highly competitive" appears more often. A `COMPETITOR_OF` extractor will over-call on the second pattern if the prompt is greedy, and under-call on the first if the prompt is timid. That is a measured precision/recall problem in Phase 3, not a prompt you "fix in the demo."

**Subsidiaries and property locations are the honest multi-hop.** Exhibit 21 lists subsidiaries and jurisdictions. Item 2 lists the parent's sites. A question the corpus can actually support:

> Which subsidiaries of {issuer X}'s **named** competitors are incorporated (or listed as located) in {jurisdiction Y}?

Walk: `X -[:COMPETITOR_OF]- Competitor -[:SUBSIDIARY_OF]- Sub -[:INCORPORATED_IN]-> Y` (edge direction as modeled). Vector RAG must hope some chunk of X's 10-K *and* some chunk of a competitor's Exhibit 21 land in the same top-k. They will not, except by accident, because those facts live in **different filings**. That is the topology argument, stated without the supplier fantasy.

**Phase 0 may kill even this reframed query** if the chosen sector's 10-Ks do not name competitors. Then the honest multi-hop shrinks further: "which of issuer X's subsidiaries are incorporated in Y?" which is **one filing, Exhibit 21**, and which hierarchical retrieval (or even a dedicated table parse) may beat the graph on. If that is the outcome, the comparison report says so. Building Neo4j anyway to rescue the roadmap bullet is a failed Phase 0.

The aspirational query remains in the docs as a **negative example**: the question vector RAG cannot answer *and that this corpus cannot answer either*. Teaching that distinction is part of the architecture, not a footnote.

## Current State (Assumed Starting Point)

A typical first version of "we did Graph RAG on EDGAR" looks like:

1. Download a pile of 10-K HTML. Dump it through a generic chunker. Embed. Call that the baseline, or skip the baseline.
2. Run a generic entity extractor over whole documents. Get a soup of `ORG`, `GPE`, `PERSON` mentions, many of them auditors, law firms, and "the Company."
3. Load mentions into Neo4j with a `RELATED_TO` catch-all. Ask an LLM to write Cypher. Screenshot a path. Publish "Graph RAG."
4. Evaluation is three hand-picked questions that match the screenshot. RAGAS is mentioned in the README and not run. Hierarchical RAG is "we used LlamaIndex's AutoMergingRetriever" with no ablation.
5. Failure modes show up when anyone else queries:
   - "Who supplies TSMC?" returns a risk-factor paragraph about supply-chain disruption, cited, fluent, wrong as a supplier list.
   - Entity duplication: `Apple`, `Apple Inc.`, `the Company` in Apple's own filing.
   - A Cypher query that `MATCH (n)-[*1..5]-` times out or returns the entire connected component.
   - Hierarchical retrieval returns a 4,000-token parent that blows the context window, so the generator ignores the middle (lost-in-the-middle, now at section scale).
   - Rebuilds: a new fiscal year lands and nobody owns extraction diffs; the graph is silently stale while the vector index was at least re-embedded.

That version will appear to work in a demo: one multi-hop question, one pretty graph viz, one cited answer. It will fail as a portfolio artifact the first time a reviewer asks for the table, the false-positive competitor edges, or why suppliers were in the schema.

This project documents the replacement: **bounded corpus, section-scoped extraction, typed schema, template queries, baseline-first eval, and a comparison report that can say "don't use the graph for this."**

## Concrete Corpus Used Throughout These Docs

One sector, a **named** issuer list, one form type, one (or two consecutive) fiscal year(s). Working illustration — replace in Phase 0 with whatever the operator can actually download and read:

**Sector (illustrative):** large-cap semiconductors (design, foundry, equipment). The point is a sector where Item 1A sometimes names competitors and Exhibit 21 is meaty. Automakers, large-cap software, or pharma are equally valid if Phase 0 verifies named-competitor density. Do not pick 200 random issuers.

**Issuers (illustrative, on the order of 8–12, not 500):** a closed list written down in the corpus manifest. Every filing in the store belongs to that list. Cross-references to companies *outside* the list (a named competitor who is not an issuer in the corpus) are **second-class**: they may exist as graph nodes without a filing, which means you cannot traverse *their* Exhibit 21. That limitation is load-bearing. A multi-hop that needs competitor subsidiaries requires the competitor to be **in the corpus**, not merely mentioned. Phase 0's issuer list is therefore chosen so that a few pairs are mutual named competitors *and* both have filings.

**Forms and sections in scope:**

- Form 10-K, items: **Item 1, Item 1A, Item 2**, plus **Exhibit 21**.
- Optional later: 10-Q Item 1A updates — **out of v1**. Annual snapshot only.
- HTML from SEC EDGAR (company filings are public). PDF image scans are out; if a filing is not extractable text, drop it from the corpus rather than OCR-heroics.

**Scale that this design is sized for:**

| Dimension | Working bound | Why |
| --- | --- | --- |
| Issuers | 8–12 | Entity aliases are reviewable by a human. Past ~30, ER becomes a project. |
| Filings | ~10–24 10-Ks | Two years × 12 issuers at most. Frozen. |
| Pages / filing | typically 50–200+ | Hierarchy exists *because* of this, not in spite of it. |
| In-scope tokens for extraction | items 1 / 1A / 2 / Ex. 21 only | Full-doc extraction is how the bill dies and the graph fills with auditor names. |
| Eval questions | on the order of 40–80, labeled | Enough to split single-hop vs multi-hop vs unanswerable. Not 5, not 5,000. |

**Typical query shapes** (the eval set is written in Phase 1, *before* hierarchical or graph code, against the filings):

| Shape | Example | What should win, *if extraction is honest* |
| --- | --- | --- |
| Single-hop lookup | "What does Issuer A describe as its principal products in Item 1?" | Baseline or hierarchical. Graph is wasted motion. |
| Long-context / wrong grain | "Summarize Issuer A's risk factors related to foundry concentration." | Hierarchical (section-level parent). Flat chunks scatter the item. |
| Intra-doc list | "List Issuer A's subsidiaries incorporated in Singapore." | Hierarchical *or* graph. Exhibit 21 is a list; a table parse may beat both. Graph is justified if you also join to other filings. |
| Multi-hop, in-corpus | "Which subsidiaries of Issuer A's named competitors in this corpus are incorporated in Singapore?" | **Graph**, if `COMPETITOR_OF` and `SUBSIDIARY_OF` edges are precise. Vector must retrieve across filings and hope the generator joins. |
| Multi-hop, out of schema | "How did Issuer A's capex guidance change vs last year in the context of competitor B's capacity announcements?" | **None of these topologies** as designed. Needs temporal alignment and numbers. Do not pretend the graph has it. |
| Unanswerable / supplier bait | "Which suppliers of A's competitors are based in Malaysia?" | **Refuse / cannot_answer.** A correct system says the filings do not name them. A wrong system cites Item 1A supply-chain boilerplate. |
| Alias / ER trap | "Where is TSMC located?" vs "Taiwan Semiconductor Manufacturing Company Limited" | Alias table or fail visibly. Silent split nodes are a defect. |

Working product constraints for the study (signed in Phase 0):

- The corpus is a **frozen snapshot**. No "watch EDGAR and re-extract." See [ADR-007](./04_architecture_decision_records.md#adr-007).
- Answers must **cite** filing + item + (where possible) excerpt. Graph answers that cannot point at the source span that justified the edge are incomplete even if the Cypher was pretty.
- "Cannot answer from indexed filings" is a **valid, preferred** terminal versus a fluent join over weak edges.
- This is a **study system**, not a production research terminal for an investment firm. No user auth, no SLA, no streaming filings. The comparison report is the customer.

A genuinely navigational ask ("open Apple's 2024 10-K PDF") is **out of this route**. Retrieval is not EDGAR-as-a-file-browser. See Non-Goals.

## Target Users

- **Owning engineer**: implements three retrieve paths and one eval harness; needs a definition of "graph win" they can defend when RAGAS faithfulness is high and the multi-hop fact is still wrong (that is extraction, not generation — do not launder it).
- **Reviewer / hiring panel**: needs a table, a negative result if that is the truth, and evidence Phase 0 read the filings. A Neo4j screenshot without the table is a toy.
- **Future self, plugging this into agentic RAG** (roadmap 2.3): needs a **tool-shaped interface** per topology (`naive_retrieve`, `hierarchical_retrieve`, `graph_retrieve`) with documented failure modes, not a monolith that "just uses the graph."
- **Not in v1**: equity analysts, compliance, a multi-tenant SaaS. Do not design for them. The moment you add "the analyst UI," the comparison study dies.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which embedding model, Neo4j version, LlamaIndex vs hand-rolled) are secondary — several belong to later serving/eval projects, not this one.

1. **Three parallel index topologies over one corpus are the deliverable.** The comparison report is the product. Picking a winner and deleting the losers before the table exists is a failed project. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Entity/relation extraction is offline, batch, and section-scoped** to Item 1, Item 1A, Item 2, and Exhibit 21. Whole-document extraction is forbidden in v1. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Graph query path is template-selected Cypher**, not open text-to-Cypher, as the primary serving path. A classifier (or structured router) picks a template and fills slots. Unconstrained generation of Cypher is a documented non-goal / rejected primary path. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. **Hierarchical retrieval is parent-child chunks plus a summary index**, with auto-merge (return the parent when enough children hit). "Recursive splitter" alone is not hierarchical RAG. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **The corpus is a named, bounded issuer set in one sector.** Cross-corpus entity resolution is an explicit, limited alias table, not an unsolved research problem smuggled into the demo. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Evaluation is RAGAS (faithfulness, answer relevancy, context precision, context recall) plus a custom multi-hop-correctness judge** on a question set frozen before the clever pipelines. RAGAS alone does not grade path-correctness. See [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **No real-time filing ingestion.** Frozen snapshot. Freshness is out of scope. See [ADR-007](./04_architecture_decision_records.md#adr-007).
8. **Extraction precision is a gate, not a metric to glance at.** Graph numbers may not enter the comparison report until a spot-check of `COMPETITOR_OF` / `SUBSIDIARY_OF` / location edges meets a Phase 3 threshold written in advance. A graph of hallucinated competitors is a liability. See [Phased Implementation Plan — Phase 3](./06_phased_implementation_plan.md).
9. **Unanswerable questions are in the eval set on purpose**, including the supplier-bait shape. A topology that "answers" them with high RAGAS and wrong facts **loses that slice**, even if it wins multi-hop-in-schema.
10. **Every graph-backed answer still carries source spans.** Edges store `source_filing_id`, `item`, and excerpt hash/offset. Traversal without provenance is a defect.

## Success Criteria for the Design (Not Implementation Metrics)

1. Phase 0 produces a written **relation inventory**: for the chosen filings, which of `COMPETITOR_OF`, `SUBSIDIARY_OF`, `INCORPORATED_IN` / `LOCATED_IN` actually appear, with example citations. If named competitors are absent, the multi-hop slice is reshaped or killed **before** Neo4j.
2. A labeled eval set exists **before** hierarchical or graph retrieval is implemented, split into single-hop, long-context/section, multi-hop-in-schema, out-of-schema, and unanswerable. Writing questions after seeing graph output is a kill criterion.
3. Baseline numbers (RAGAS + the custom judge) exist as **row 1 of the table**. Hierarchical and graph are not allowed to publish without that row.
4. Hierarchical beats baseline on the long-context/section slice by a margin Phase 1 names, **or** the write-up says hierarchy did not pay and why (section map failed, parents too large, summaries too lossy).
5. Graph beats baseline **on the multi-hop-in-schema slice** after the extraction-precision gate, **or** the write-up says it did not (extraction too noisy, competitors not in corpus, templates too narrow). Either result is a successful project. A missing row is not.
6. Graph does **not** have to win on single-hop. If it is slower and no more faithful there, that is the expected, publishable outcome.
7. Unanswerable/supplier-bait items are refused or explicitly "not in filings" at a rate the eval set can show. Fluent supplier lists are a failed honesty criterion regardless of topology.
8. Cost is reported per topology: embed cost (all three), extraction LLM cost (graph only), query-time LLM cost, Neo4j ops. Hiding extraction cost inside "we used an LLM" is a failed design.
9. No unconstrained Cypher-from-NL path is on the default query route. If a lab experiment exists, it is labeled experimental and off the comparison table's graph column unless Phase 4 explicitly adds it as a fourth row.

## Business Rules (Study-Scoped)

1. **One corpus manifest.** Issuers, accession numbers, form, fiscal year, SHA of the stored HTML. Adding a filing without updating the manifest is a dirty eval.
2. **Question set is versioned and frozen** the way a prompt is versioned in `prompt-lab`. Changing labels after seeing graph output is cheating. Adding questions is a new eval version, re-run all rows.
3. **Exhibit 21 is parsed as a list/table first**, LLM-extracted second. Using only an LLM on a structured exhibit is how you pay frontier prices for OCR-of-a-table. See [System Design](./03_system_design.md).
4. **Edge types are closed.** v1: `COMPETITOR_OF`, `SUBSIDIARY_OF`, `INCORPORATED_IN` / `LOCATED_IN`, `EXEC_OF` (optional, Item 1 / cover). No `RELATED_TO`. New types are a schema version and a new extraction pass, not a prompt tweak in prod.
5. **Alias table is curated** for the issuer list and for high-frequency legal-name variants. Mentions that do not match are either dropped or stored as `unresolved` nodes that **templates will not traverse** for multi-hop. Traversing unresolved nodes is how false competitors enter answers.
6. **Refuse is in-schema.** If the router cannot select a template and vector/hierarchical retrieval is the fallback, that fallback is **labeled** in the trace (`path=hierarchical_fallback`). Silent fallback makes the ablation table a lie.
7. **Citations are mandatory** on generated answers for all three paths. Graph path cites the supporting edge sources, not "the graph."
8. This is **not investment advice infrastructure**. The comparison report must not be phrased as a research product. Public filings, public methods, no claim of completeness.

## Non-Goals

- **Not a production EDGAR research platform.** No user accounts, no alerting on new filings, no "coverage of the S&P 500." Frozen 8–12 issuers.
- **Not Microsoft GraphRAG** (Leiden communities + hierarchical community summaries). That is a different topology (graph used to *build* a summary tree, then retrieve summaries). If you want it, it is a fourth row and a fourth budget; it is not this v1. Do not name-drop it as what this system is.
- **Not unbounded NL-to-Cypher** as the serving path.
- **Not a substitute for hybrid+rerank quality work.** Baseline may *use* [`prj--retrieval-x`](../../prj--retrieval-x/) ideas (BM25+dense+RRF). This project's independent variable is **hierarchy vs graph vs flat**, not reranker ablations. Do not confound them in one table without labeling the confound.
- **Not a substitute for corrective / multi-query RAG.** [`prj--rag-selfheal`](../../prj--rag-selfheal/) can wrap any of these retrievers later. v1 of *this* project is retrieve-then-generate **per topology**, so the table isolates topology. Adding CRAG to only the graph path is how you cheat.
- **Not serving-scale ANN, sharding, or multi-tenant ACL.** [`prj--rag-pipeline-at-scale`](../../prj--rag-pipeline-at-scale/).
- **Not live extraction, streaming EDGAR, or year-over-year graph diff as a product.** Out of scope ([ADR-007](./04_architecture_decision_records.md#adr-007)).
- **Not general entity resolution / knowledge-base construction.** Alias table for a named list. If Phase 0 requires 200 issuers to make multi-hop interesting, the project is the wrong size; shrink the question, do not grow ER.
- **Not a claim that graph RAG is the future of all RAG.** The honest alternative — hierarchical or even naive, on single-hop questions over a small corpus — will win the demo and the latency budget. This design is justified when **path queries over typed relations** are a recurring, labeled slice *and* Phase 0 shows those relations exist in the text. It is overkill for "chat with one PDF."
- **Not an implementation.** No Python, no LlamaIndex trees, no Cypher files, no RAGAS script. Numbered steps and diagrams only.
