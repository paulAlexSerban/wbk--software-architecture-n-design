# Multi-Query & Corrective RAG: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a retrieval-augmented generation pipeline that does not silently answer from the wrong context. The naive system is a linear chain: embed the user question, retrieve top-k, stuff the chunks into a prompt, generate. That chain has no observation of whether the retrieved context actually answers the question, and no primitive for going back. Three failure modes it cannot see:

1. **The query is the wrong unit of retrieval.** Multi-hop, comparative, and conjunctive questions ("how did the Q3 return policy change relative to Q2, and what does that mean for EU orders?") need decomposition. One embedding of the whole string retrieves a mush of vaguely related chunks. None of them, fused or not, contain both halves of the answer.
2. **The top-k is topically related and still useless.** Semantic similarity is not answerability. A chunk about "returns" is not a chunk about *this* return policy version for *this* region. A reranker that reorders the same bad set still cannot say "none of these are sufficient; try a different query."
3. **The index does not contain the answer.** Stale docs, unpublished policy, a question about an event after the last crawl. The chain will still generate. The LLM is trained to be helpful. Helpful-plus-empty-context is a hallucination with citations that look official.

The design must answer, concretely:

1. How a query becomes a **plan of sub-queries**, not a single vector, when the question has more than one retrieval target.
2. How parallel retrieval results are **fused** so heterogeneous rankers (BM25 on one sub-query, dense on another) do not require a shared calibrated score.
3. How the system **observes** that retrieved context is insufficient — a typed grade, not a vibes paragraph — and what it is allowed to do next.
4. What the **bound** on correction is, and why "keep searching until the model is happy" is not an architecture.
5. What happens when internal retrieval, after correction, still cannot answer — including whether web/broader search is a designed branch or a forbidden leak — and what the honest terminal is when even that fails.
6. What is measured so "we self-heal" is a rate and a cost multiplier, not a demo GIF of LangGraph blobs.

This is the open-loop retrieval trap. The naive answers — raise top-k, add a cross-encoder reranker, wrap the retriever as an unbounded agent tool — are the failure. They either spend more of the same retrieval, or they add a loop with no budget. **A chain cannot correct. An unbounded loop cannot finish.** The correct shape is a **state machine with a typed grade as the branch condition, a hard iteration cap, a designed fallback, and an honest give-up.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true: extra LLM calls, extra retrieval QPS, extra latency on the corrective path, a grader that can itself be wrong, and no promise that a missing document will appear because you asked a second time.

## The Trap, Stated Directly

"Just retrieve better" in a product conversation is almost always used as if it meant **the first top-k is good enough if we pick the right vector DB.** That is an indexing problem. Indexing is real; it is not this project. See [`prj--rag-pipeline-at-scale`](../../prj--rag-pipeline-at-scale/) for serving 50 million documents. This project starts after a retriever exists and still returns the wrong context.

Those are independent systems of meaning:

| What people hear | What the constraint actually protects |
| --- | --- |
| "Multi-query RAG" | The *question* may be several retrievals. Fan-out is not "retrieve more of the same query." |
| "Corrective RAG / CRAG" | After retrieval, **look** at the docs. If they are insufficient, change the query or the source, then retrieve again. Not: generate a disclaimer. Not: raise k. |
| "LangGraph / state machine" | Branching and a bounded loop are first-class. A `RunnableSequence` with an `if` stuffed in a lambda is a state machine you are ashamed of. |
| "The model will just know the context is bad" | During generation, maybe, if you prompt it to refuse. That is not retrieval correction. It is a generator that noticed too late, after you already paid for a completion, and it still often does not refuse. |
| "Self-healing" | A marketing name for a **bounded retry with a different query**. Healing that never stops is an outage. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| Retrieval that is always sufficient on the first pass | No. Query ambiguity, multi-hop structure, and index gaps are structural. First-pass recall will never be 100%. |
| A pipeline that notices insufficiency and tries again | Yes, as a **state machine** with a typed grade and a cap. Not as a hope in the generator prompt. |
| Unbounded self-correction until the answer is right | No. Cost and latency unbounded; the grader can rubber-stamp a second equally bad set; "right" is not what the grader scores (it scores relevance of context, not answer correctness). |
| A fix for a stale or empty index | No. Re-retrieving the same index with a rewritten query cannot produce a document that was never indexed. Web/broader search is a *different source*, with different trust, and is a product decision. See [ADR-006](./04_architecture_decision_records.md#adr-006). |
| Correctness of the final answer | Not this system's product. Grading relevance ≠ grounded generation ≠ factual truth. Faithfulness of the completion is a downstream concern (evals, citation checks). This system owns **context sufficiency before generate**. |
| Cheap, sub-second RAG | The happy path already pays decomposition + fan-out + grade + generate. The corrective path pays that again. If the latency budget is "one retrieve plus one generate," this project does not fit. Say so in Phase 0. |

Capitulating to "just raise top-k" is how you pass the interview by ignoring multi-hop and insufficiency. Capitulating to "just add a reranker" is how you pass it by reordering the same wrong set. Capitulating to an unbounded ReAct agent with a search tool is how you pass it by deleting the budget. Treating "self-heal" as "the graph has a loop node in the slide" is how you ship a demo that 5× the bill on every question, including "what is the office Wi-Fi password."

## Current State (Assumed Starting Point)

A typical first version of "we have RAG" looks like:

1. Request arrives. The handler embeds the raw user string (or sends it as a keyword query). One retriever call. Top-8 chunks. Sometimes a reranker on those 8.
2. Chunks are concatenated into a context window. A prompt says "answer using only the context; if you don't know, say so."
3. The model answers fluently. Citations point at chunk ids. Nobody measured whether those chunks contain the answer.
4. Failure modes show up as tickets, not as pipeline states:
   - comparative / multi-hop questions get a confident answer to *one* of the clauses;
   - the retrieved policy is last year's, topically similar, and the model does not notice;
   - the answer is in a table the chunker split badly, so retrieval returns the surrounding prose;
   - the user asks something the corpus never covered; the model interpolates from a neighboring topic.
5. Engineering raises k from 8 to 20. Context gets noisier. Latency and token cost go up. Insufficiency remains unobserved. Someone adds "be careful" to the prompt. Someone else wraps the retriever as a tool and lets the model call it in a loop. The first week a malformed query causes 12 retrievals and a 40-second response, they add a timeout and call it solved.

That version will appear to work in a demo: a question whose answer is in the first chunk, one fluent completion, citations. It will fail in production the first time:

- a question with two entities retrieves for the more popular entity only,
- a paraphrased policy question retrieves the FAQ that uses different words and misses the binding rule,
- an out-of-corpus question still gets a cited paragraph,
- on-call cannot tell, from logs, whether retrieval failed or generation failed — there is only one span,
- finance asks why the assistant quoted a deprecated discount; the log shows eight chunks, none of them the current promo, and no grade.

This project documents the replacement, not a patch of that single `retrieve()` call.

## Concrete Route Used Throughout These Docs

One product-shaped example, so the sequences are not abstract. The architecture is the same if the corpus is support macros, API docs, or a research library; only the retriever, the fallback policy, and the grade threshold change.

**Route: `kb.answer_question`.** An employee (or an internal chatbot) asks a question against the company knowledge base: policies, product docs, runbooks, dated announcements.

Corpus (illustrative): internal wiki + exported PDF policies + ticket-macro snippets, already chunked and indexed. Hybrid retrieval (BM25 + dense) is assumed available. How that index is built and sharded is **out of scope**; this design consumes a retriever interface.

Typical query shapes on this route:

| Shape | Example | Why single-query top-k fails |
| --- | --- | --- |
| Simple lookup | "What is the default PTO accrual cap?" | Often works. Paying full CRAG on this is the tax you must justify in Phase 0. |
| Comparative | "How did parental leave change between the 2024 and 2025 handbooks?" | Needs two retrievals; one query embedding averages them. |
| Multi-hop | "Can a contractor in Germany use the same laptop stipend as FTE, given the 2025 equipment policy?" | Eligibility + region + policy version. One hop misses a clause. |
| Ambiguous | "What's the return policy?" | Which product line, which region, which date. Top-k is a random product line's FAQ. |
| Out of corpus | "What did the CEO say on the earnings call this morning?" | Not in the wiki. First-pass retrieval returns old all-hands notes. Without a grade, the model summarizes those. |

Working product constraints for the route (signed in Phase 0, not invented at generate-time):

- Internal corpus is the default source of truth.
- Web/broader search is allowed **only** after internal retrieval is graded insufficient, and only for questions that are not HR-PII / embargoed (a policy flag, not a model judgment). See [ADR-006](./04_architecture_decision_records.md#adr-006).
- "I cannot answer from available sources" is a **valid, preferred** terminal versus a fluent guess. Same honesty pattern as failed quorum in a decision-ensemble: do not ship sample #1 because the user is waiting.

A genuinely navigational ask ("open the handbook PDF") is **out of this route**. Retrieval is not search-as-navigation. See Non-Goals.

## Target Users

- **Owning engineer**: implements the graph; needs a definition of "sufficient context" they can defend when the grader said relevant and the answer was still wrong (that is not this system's miss — or it is, if they sold grading as correctness).
- **On-call / support**: needs to answer "why did this take 4 seconds instead of 1," "why did we hit the web," and "why did we refuse."
- **Product**: wants fewer hallucinated policy answers. Must accept a numeric correction-trigger rate, a fallback rate, a refuse rate, and a latency SLO that is **worse** than naive RAG on the p95 of the corrective path.
- **Security / compliance**: needs web-fallback to be off for corpora that must not leak query text to a third-party search API, and needs external snippets labeled as such in the answer.
- **The employee**: needs an answer that matches current internal docs, or a clear "we don't have this," not a neighboring policy with confident tone.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which embedding model, chunk size, wiki connector) are out of scope — and several of them belong to the retrieval-platform project, not this one.

1. **Control flow is a state machine, not a chain.** Decomposition, retrieval, fusion, grading, correction, fallback, generate, and escalate are nodes with typed edges. A linear `retrieve | prompt | generate` cannot satisfy correction. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Queries that need more than one retrieval target are decomposed and retrieved in parallel.** Fan-out is bounded (max sub-queries). Fusion is RRF, not ad-hoc score mixing. See [ADR-002](./04_architecture_decision_records.md#adr-002), [ADR-003](./04_architecture_decision_records.md#adr-003).
3. **Sufficiency is a structured grade, not a prose judgment.** Per-document labels plus an aggregate verdict (`sufficient` / `ambiguous` / `insufficient`) are the only legal branch conditions. Unparseable grades are a failed grade, not "looks fine, generate." See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **Correction is bounded.** Working default: **at most one** internal rewrite-and-re-retrieve cycle, then fallback or escalate. Unbounded "until the grader is happy" is forbidden. Raising the cap under incident pressure is a policy violation, not a hotfix. See [ADR-005](./04_architecture_decision_records.md#adr-005).
5. **Web/broader search is a designed branch after internal insufficiency, not a first-class default and not a hidden retry.** It can be disabled per route. External snippets are provenance-tagged. See [ADR-006](./04_architecture_decision_records.md#adr-006).
6. **Generate is not allowed on a failed sufficiency check.** After the bound is exhausted, the terminal is `cannot_answer` / escalate, or generate **only** from context that passed grade (possibly partial, with an explicit coverage warning). Fluent generation from empty/irrelevant context is a forbidden terminal — the analogue of silently picking sample #1. See [ADR-005](./04_architecture_decision_records.md#adr-005).
7. **The latency and cost tax of decomposition, fan-out, grading, and correction is a first-class production metric**, compared to a single-pass baseline. RAGAS-style context precision/recall (or equivalent labeled eval) is continuous or shadow, not a one-time notebook. See [ADR-007](./04_architecture_decision_records.md#adr-007).

## Success Criteria for the Design (Not Implementation Metrics)

1. On a labeled eval set that includes simple, comparative, multi-hop, ambiguous, and out-of-corpus items: **context sufficiency** (RAGAS context precision / context recall, or a human-labeled equivalent) beats the single-pass baseline by a margin Phase 0 names in writing. If it does not, the graph is complexity without benefit — kill or stop after Phase 1 fusion-only if fusion alone was the win.
2. Simple lookup queries do **not** regress in accuracy, and their added latency vs baseline is measured and accepted. "We made the hard 20% better and the easy 80% 2× slower" is a product conversation, not a silent ship.
3. A query whose first-pass retrieval is graded `insufficient` takes the correction path. A query graded `sufficient` does **not**. Tests that always loop are wrong tests.
4. After `max_corrections` internal attempts, the system does not loop. It takes fallback (if enabled) or `cannot_answer`.
5. Web fallback, when it runs, is visible in the response provenance (source type `web` vs `internal`). When it is disabled, an insufficient internal grade never calls a search API.
6. Grader parse failure does not default to generate. It defaults to the conservative branch (treat as `ambiguous` / continue correction if budget remains, else `cannot_answer`).
7. Cost per successful request is approximately **1 × decompose + S × retrieve + 1 × grade (+ 1 × rewrite + S' × retrieve + 1 × grade_again if corrected) (+ 1 × web if fallback) + 1 × generate**, with S = number of sub-queries. That multiplier vs single-pass (`1 × retrieve + 1 × generate`) is on a dashboard. Hiding it in "LLM spend" is a failed design.
8. No unbounded agent loop and no "generate anyway from ungraded context" path exist on this route "as a fallback." If those are the actual requirements, this project is the wrong project. See kill criteria in the [Phased Implementation Plan](./06_phased_implementation_plan.md).

## Business Rules (RAG-Scoped)

1. The retriever is a **dependency**, not a subsystem of this design. Chunking, embedding, index refresh, and ANN capacity live elsewhere. This graph must not grow an indexer "just for CRAG."
2. Sub-query count is capped (working default: **4**). Decomposition that emits 12 sub-queries is a prompt bug, not a reason to fan out 12 ways.
3. RRF `k` and cutoffs are route parameters. Changing them is not a new architecture; deleting fusion and concatenating all lists is.
4. The grader sees retrieved text, the original question, and the sub-query that fetched the doc. It does not see the generator's draft — grading is **pre-generate**. Using the generator as the grader is a different (worse) design: you pay for a completion to decide you should not have generated.
5. Correction rewrites the **query plan**, not the user-visible question. The user asked one thing; the system may retrieve differently. Do not silently change what you claim to answer.
6. `max_corrections` is a route parameter with a hard cap in config. Engineering changing it from 1 to 5 to "fix quality" in an incident is a constraint violation. If measurement later justifies 2, that is a new signed number, not a panic slider.
7. Web fallback is off unless product and security signed it for the route. Query text leaving the perimeter is a data decision.
8. Refuse / `cannot_answer` is a product outcome, not an infrastructure error. Staff it (or accept a worse lying bot). Same honesty as a failed ensemble quorum.

## Non-Goals

- **Not an indexing or serving-scale project.** Fifty million documents, HNSW RAM, shard hedging, freshness SLOs: [`prj--rag-pipeline-at-scale`](../../prj--rag-pipeline-at-scale/). This design will make retrieval QPS worse (fan-out × sub-queries × correction), which that platform must survive; it will not replace that platform.
- **Not a generation-faithfulness / hallucination detector.** Checking that the *answer* is entailed by the context is downstream (and a good idea). This system stops at **context sufficiency**. A sufficient context can still be summarized wrongly. Do not sell CRAG as "we don't hallucinate."
- **Not unbounded self-correction, multi-agent debate, or "the model keeps searching."** Bound is the architecture.
- **Not a fix for structurally missing, unchunked, or stale knowledge.** Correction cannot invent coverage. Index hygiene, crawl freshness, and access control remain the owners of "the doc doesn't exist."
- **Not query routing across many corpora as a product.** One KB retriever plus an optional web fallback. Multi-index federation is a different design (and a tempting place to hide unbounded fan-out).
- **Not a claim that this is cheap or fast.** The honest alternative — one retrieve, one generate, hope — is cheaper and will survive a demo. This design is justified when **silent wrong-context answers are expensive** (policy, legal, safety, user trust) *and* Phase 0 shows a real retrieval-failure rate on the actual query mix. It is overkill for a FAQ whose top-1 already has 95% recall. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not an implementation.** No Python graph, no LangChain retriever, no RAGAS script. Numbered steps and diagrams only.
