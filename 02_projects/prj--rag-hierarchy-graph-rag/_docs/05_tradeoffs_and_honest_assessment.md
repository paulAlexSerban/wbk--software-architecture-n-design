# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give yourself before you docker-compose Neo4j because a roadmap bullet said "graph RAG."

The topology argument, once: **a vector index stores neighborhoods of text; a graph index stores typed paths.** Multi-hop questions are path queries. Hierarchical indices fix **grain** inside a document, not paths across documents. None of the three can answer a question whose facts were never disclosed. A 10-K does not contain a supplier graph. Designing extraction for `SUPPLIES` edges from Item 1A boilerplate is not ambitious. It is refusing to read the filing.

## 1. What I would build

A **three-column retrieval lab** on a frozen, named 10-K snapshot — not "a GraphRAG product," not a chat-with-EDGAR app.

- **Phase 0 before any index.** Pick 8–12 issuers in one sector such that a few named competitors are *also* issuers. Download 10-Ks. Hand-build a relation inventory: competitors named, Exhibit 21 present, locations usable. **Reframe the flagship query** to subsidiaries-of-competitors-in-Y (or kill multi-hop if the inventory is empty). Put the original supplier query in the eval set as **unanswerable bait**.
- **Baseline**: same child chunks, embed, top-k, shared generator, citations. Optional BM25 only if it is also on the hierarchical child retriever or is a labeled extra row.
- **Hierarchical**: real tree, auto-merge to section, summaries for *selection* not as fake source, shared stuff budget, truncation traces.
- **Graph**: deterministic Exhibit 21 parse; closed-schema LLM IE on Item 1/1A/2; Neo4j with provenance; **five Cypher templates**; classifier; refuse on `none`. Alias table. Spot-check gate.
- **Eval harness**: frozen questions first; RAGAS + list F1 + refuse rate; cost including **build-time extraction**; a markdown report that is allowed to say the graph lost.

I would run extraction **last** among the index builds, after the question set exists, so I cannot "discover" gold from the graph.

If Phase 0 shows dense named-competitor overlap and clean Exhibit 21 HTML, this looks like a lot of process for a small graph. Build the process anyway. The process is what makes "extraction precision was 0.55" a result instead of a Thursday-night rewrite of the schema.

## 2. What I would give up

Be explicit. These are not "later" in v1. Some are never in this design.

**The roadmap's supplier query as a solvable gold item.** The corpus does not support it. Giving this up is the design. Keeping it as bait is honesty. Using it as the hero demo is fraud.

**A single retriever that is best at everything.** Graph will likely **lose or tie** on single-hop lookups: extra classifier latency, extra failure mode (bind miss), no benefit. Hierarchical will likely **lose or tie** on questions whose answer is already in one child chunk. Publish that.

**General graph QA / NL-to-Cypher.** v1 understands a closed template list. Users (and reviewers) who ask an untemplated but graph-shaped question get a refuse, not a generated `MATCH`.

**Microsoft GraphRAG** (community detection + hierarchical community summaries). Different topology, different budget, different paper. Name-dropping it in the README as what you built is a fail.

**Live EDGAR, S&P-500 coverage, 10-Q deltas, 8-K events.** Frozen SHA. Freshness is not a metric here.

**General entity resolution.** Twelve issuers and a CSV of aliases. "TSMC" vs legal name is a row in that CSV, not a research contribution.

**Silent fallback** from empty graph to vector. It makes the graph column a lie. If you want a cascade, it is a fourth row: `graph_then_hier`.

**CRAG / multi-query on only one topology.** [`prj--rag-selfheal`](../../prj--rag-selfheal/) can wrap all three later. Wrapping only the graph is how you steal the table.

**Rerank-as-confound** on one column. Same story with [`prj--retrieval-x`](../../prj--retrieval-x/).

**Query-time extraction** and **whole-document extraction**. Cost and noise.

**The claim that graph RAG is cheaper.** Build-time extraction dominates. Query-time Neo4j is cheap; that is not the bill people forget.

**Investment-grade completeness.** Even a perfect T3 path only sees competitors **named in the 10-K** and subsidiaries **of in-corpus issuers**. Real competitive landscapes are wider. The system must not talk like a terminal.

**Pretty Neo4j Browser screenshots as a substitute for Phase 4.**

## 3. What I would ask for, even though I expect a no (or a "this is a solo study")

There is no System B team in this scenario. The "asks" are to **future-you** and to anyone who wants to turn the study into a platform.

Ask, in writing, in Phase 0:

1. **Is the multi-hop slice feasible on *this* sector's filings?** If not, do not start Neo4j. Expected: you will want to skip the inventory. Do not.
2. **Will the eval set stay frozen** once scores look embarrassing? If a collaborator (or you) wants to drop supplier-bait items, that is a no — or a new version with a changelog.
3. **Budget for judge + extraction tokens** as a real number, not "it's just API calls." Expected: people under-guess by 5–10× because they forget eval.
4. **Time for gold labels on Exhibit 21 lists.** Tedious. Non-optional. Expected: someone will propose "use the graph as gold." That is circular. Refuse.

If this were an internal wiki instead of EDGAR (it is not, but reviewers will ask):

5. **Access control at retrieval time** (roadmap 1.3). This design has none. Do not point it at confidential data.
6. **A data owner for entity canonicalization.** Alias tables without an owner rot immediately.

What I would **not** ask for: GPUs, Aura Enterprise, a team of annotators for 200 issuers, legal to bless "investment research." Those asks turn a study into a stalled program.

## 4. Honest limits of graph RAG (the part the paper abstracts omit)

**Win condition is narrow.** Graph RAG is worth the extraction tax when (all of):

- relations are **typed and recurring** in the query mix, not one demo question;
- those relations are **actually in the text** at extractable precision;
- hops cross **units that vector search will not co-retrieve** (here: two filings);
- you can **bind** questions onto a schema you are willing to maintain.

If any bullet is missing, hierarchical or even naive RAG plus a better chunker is the grown-up system.

**Extraction is the product.** Retrieval mechanics in Neo4j are the easy 10%. False `COMPETITOR_OF` edges fan out: one wrong competitor in T3 dumps an entire foreign Exhibit 21 into the answer, cited, faithful-to-context, **wrong**. Precision gates exist because of this, not because of process theater.

**Schema brittleness is not a documentation issue; it is the architecture.** Every new question shape is a template + extractor field + gold labels + re-eval. Vector RAG degrades gracefully (returns something vaguely related). Graph RAG fails **closed** (refuse) or **catastrophically** (wrong type walked). Closed failure is better. It still feels worse in a demo.

**`in_corpus` is a silent killer of the flagship query.** "A names B as a competitor" does not give you B's subsidiaries unless B's 10-K is in the snapshot. Issuer-list design is architectural. A random sample of 10 famous companies often has **zero** usable T3 paths.

**Hierarchy does not steal the graph's job, and the graph does not steal hierarchy's.** Hierarchy: long Item 1A, shredded tables, wrong 512-token window. Graph: join across filings on typed edges. Using graph retrieval to "summarize risk factors" is a misuse. Using auto-merge to answer T3 is a hope.

**RAGAS will not save you.** High faithfulness on graph cells can mean the generator recited the bad triples correctly. The custom list-F1 and the unanswerable refuse rate are the differentiators. If you only report RAGAS averages across slices, the graph's multi-hop win (or loss) **washes out** in the single-hop majority.

**Operationally, Neo4j is optional complexity at this scale.** A SQLite table of triples plus recursive SQL would answer T3. Neo4j is chosen because the roadmap and the industry conversation use it, and because path queries stay readable. It is not chosen because 200 nodes need a native graph engine. Say that out loud so you do not implement clustering, GDS, and Bloom to avoid writing the eval set.

**What "vector RAG cannot answer well" actually means.** It does not mean the LLM *cannot* join two retrieved chunks. If baseline top-k **happens** to contain A's competitor sentence *and* B's Exhibit 21 row, the generator might join them. At k=8 over 12 filings × 4 items, that coincidence is rare; it is not impossible. The architecture claim is **tractability and reliability**, not a mathematical impossibility. The table should show **rates**. A single cherry-picked miss is a tweet, not a result.

## 5. How the answer changes if the corpus were not 10-Ks

The topology argument survives; the schema does not.

| Corpus | Hierarchical still for | Graph still for | New trap |
| --- | --- | --- | --- |
| Internal wiki | Long runbooks, parent pages | Service → owner → oncall → region | ACL; stale pages; everyone names services differently |
| Resume/portfolio | Multi-page CV vs project READMEs | Person → company → skill → project | Tiny graph; overkill unless multi-hop is real ("who used X at Y") |
| Contracts | Clause hierarchy | Party → obligation → date | Legal NER; you will be wrong; do not ship without lawyers |
| 10-Ks (this project) | Item grain | Competitor / sub / jurisdiction | **Suppliers aren't there**; ER; `in_corpus` |

Do not reuse the `COMPETITOR_OF` schema on a wiki. That is how GraphRAG cargo-cults fail.

## 6. Brutal summary

The clever design is not Neo4j. The clever design is **refusing to extract relations the filings do not contain**, **refusing to evaluate three systems on three question sets**, and **refusing to publish a graph column that failed a precision gate**.

Hierarchical RAG is the conservative upgrade for long, structured documents. Graph RAG is a **specialized join index** with an LLM-shaped data-entry problem in front of it. Naive RAG remains the correct control and, on many questions, the correct production choice.

If Phase 0's inventory is rich, the table will likely show: baseline fine on lookups; hierarchy up on long Item 1A; graph up on T3-shaped list questions; **all three** supposed to refuse suppliers. If the inventory is poor, skip Neo4j and write that down. Either way, the first artifact is the relation inventory, not a browser screenshot. Start there. Print the F1. Ask the filings, not the model, what edges exist.
