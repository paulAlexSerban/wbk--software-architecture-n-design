# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give yourself before a week disappears into a Streamlit theme or a fourth vector database.

The fact, once: **this is a small system.** A folder of markdown and PDFs, a local Postgres, three splitters, a k-NN query, a labeled eval set. There is no 1.8 TB RAM story, no scatter-gather p99, no freshness plane. Pretending otherwise is how a foundation lab acquires fake architecture. The hard part is **not confusing "the chunker that won on 40 of my own questions" with "the chunker that is actually better,"** and not skipping the labels because the search box already looks like a product.

## 1. What I would build

A **controlled experiment with a flashlight**, not a search startup.

- **Pinned extractor + three versioned chunkers** (fixed-size, recursive, semantic) writing variant-scoped rows in **one** Postgres/pgvector. Semantic pays a sentence-embed tax that shows up as a column, not a footnote. See [ADR-003](./04_architecture_decision_records.md#adr-003).
- **One embedding model** for the primary table, preferably local, with query/document prefixes applied correctly if the model requires them. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **A query path that returns chunks.** No generator. No BM25 serving. No rerank. Dense-only is the baseline later projects beat, not a defect to patch this week. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **An eval set of 40–60 human-labeled queries** (doc-level relevance, optional passage overlap), versioned in git, frozen against a corpus snapshot. A keyword Success@k row in the same report so dense retrieval has to beat "grep." [ADR-004](./04_architecture_decision_records.md#adr-004).
- **A harness that writes Success@k, MRR, ingest seconds, embed calls, coverage.** Caveat block mandatory. Fictional precision to two decimals without n and caveats is banned.
- **A thin UI** after the table exists: query, strategy, provenance. Side-by-side if cheap. Not a product.

If Phase 0 discovers the folder is 40 markdown files with perfect headings, recursive will probably win and semantic will look silly. Build the harness anyway. The method is the portable artifact.

## 2. What I would give up

Be explicit. These are not "Phase 2" disguised as principles.

**Statistical rigor.** n≈40 is directional. I will not run t-tests on a convenience sample I wrote myself. I will not publish "semantic +8% retrieval." I will publish a table and a paragraph that says a 5-point Success@5 gap may be noise.

**A globally best chunker.** The winner is `(this corpus, this model, this eval-set version, this extractor)`. Changing any one can reorder the rows. Later RAG-at-scale using these params without re-measuring is cargo cult.

**Semantic-chunking sophistication.** One frozen boundary rule. No LLM splits, no learned segmenters, no weekend spent maximizing the eval set. If semantic needs a research project to win, it did not win.

**Hybrid, rerank, and generation.** Giving these up is the project. I would rather a boring demo than a muddled baseline.

**Incremental freshness, CDC, shards, HA, ACLs.** The write path is batch reindex. If a file changes, re-run ingest. Building RAG-at-scale seams "so we learn production" on 500 files teaches the wrong production (queues and generations) and skips the right one (labels and confounds).

**A real search UI.** Auth, collections, upload, sharing, design system. None of it moves Success@k.

**Store bake-off as the story.** pgvector vs Chroma vs FAISS will not change chunk quality on this corpus. Picking pgvector for reuse is enough. [ADR-001](./04_architecture_decision_records.md#adr-001).

**PDF perfection.** I will measure extract failure and, if PDFs dominate errors, split the table (markdown vs PDF) rather than invent a layout model. A chunker cannot save soup.

**The fantasy that a better splitter fixes retrieval.** Overlap, breadcrumbs, and embedding model often move the metric as much as the strategy name. The experiment holds those constant; it does not prove they were optimal.

## 3. Cost, in the units that actually hurt

**Dollars are not the story.**

A local MiniLM-class model on tens of thousands of chunks is laptop time. An API embed of the same is pocket money unless you loop semantic sentence embedding while tuning thresholds. The relative cost **between** strategies *is* a story: semantic can be several times the embed calls of recursive for a gap the eval set cannot resolve. That belongs in the table so "sophistication" has a price.

**Operator hours are the story.**

- Writing 50 good queries and clicking relevant docs: a slow afternoon if you know the folder, longer if you do not.
- PDF extraction rabbit holes: unbounded. Cap it (pin one extractor, report unsearchable rate, move on).
- UI polish: a weekend you will not get back.
- Adding a chatbot "for the README": you have started another project and this one's table is still empty.

**Contrast with RAG-at-scale, so the fear is correctly assigned:** there, RAM × replicas × generations dominates. Here, **lying with a small eval set** dominates. Copy measurement hygiene from that project. Do not copy its cluster.

## 4. Why "just pick recursive, everyone uses it" is not a full answer

The amateur move is to copy `RecursiveCharacterTextSplitter(chunk_size=1000)` and proceed to RAG. Sometimes that is fine. This project exists because that choice becomes folklore.

**Recursive is a prior, not a measurement.** It usually respects markdown headings. It often becomes fixed-size on PDFs. Without a control (fixed-size) you cannot see whether structure did anything. Without labels you cannot see it at all.

**Semantic is not automatically better.** It can cut at topical shifts that headings miss. It can also shatter a coherent section, cost 5–10× embeds, and win the one query you stared at while losing the set. The sentence tokenizer and the percentile cut are hidden chunkers.

**Fixed-size still wins sometimes.** Homogeneous prose, bad structure, or eval queries that match bag-of-words windows. If it wins, later you might still pick recursive for operational reasons (less mid-sentence cuts for a generator) — that is a **different** decision (generation-time context quality) and **out of scope** until `docqa-basic`. Do not launder it into this table.

**The honest scaling of this insight:** when you later add BM25, rerank, or hierarchical indices, you need to know whether a gain came from fusion or from finally stopping mid-table splits. That sentence is why a toy project is worth documenting like an architect.

## 5. What this project is not (and what those projects are for)

| Temptation | Why it shows up | Where it actually belongs |
| --- | --- | --- |
| Chat over the docs | Demos want answers | `docqa-basic` (naive RAG) |
| BM25 + RRF | IDs and error codes miss | `retrieval-x` |
| Cross-encoder rerank | Top-10 is messy | `retrieval-x` |
| Incremental re-embed / freshness SLO | Files change | RAG-at-scale |
| Sharded ANN, quantization, p99 | Imagined millions of docs | RAG-at-scale |
| Multi-tenant ACL at retrieve | "Enterprise" resume keywords | later retrieval + security projects |
| LLM-as-judge as the metric | Labeling is tedious | `rag-metrics` / `prompt-lab`, after a human set exists |
| k8s + Terraform for Compose Postgres | Infra credibility | not here; the eval table is the credibility |

Building those now is not ambition. It is **abandoning the independent variable**.

## 6. Why a folder of personal docs is still a serious portfolio artifact

Because hiring panels have seen a thousand Chroma notebooks and almost no **comparison with a held-out label set and a cost column**.

The system is easy. The claim is not "I designed pgvector." The claim is:

- I treated chunking as an experiment with one independent variable.
- I refused to rank strategies without labels.
- I reported the tax of the fancy method.
- I drew a hard line against generation so the next system has a baseline it can beat in public.
- I did not confuse laptop k-NN with production retrieval at 300M vectors.

If the table says recursive won by a hair and semantic cost 6×, that is a better architect story than a chatbot that "uses embeddings."

If the eval set never ships, this project is indistinguishable from the notebook it was supposed to replace. That is the only failure that matters.

## 7. Brutal summary

The clever design is not a vector database. The clever design is **treating retrieval quality as something you can be wrong about**: labels, controls, cost, caveats, and a scope that does not steal the measurement.

Chunking strategy tradeoffs are real and corpus-specific. Semantic chunking is a second embedder, not a personality trait. pgvector is a convenience and a bridge to later SQL-shaped RAG, not a scale strategy. The search UI is how you look at mistakes.

If they wanted a chatbot, this document is too strict. If they wanted the baseline every later RAG project is measured against, it is the minimum honesty.
