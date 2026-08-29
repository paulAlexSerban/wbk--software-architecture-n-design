# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone treats a resume chatbot as "our RAG platform" or skips the naive baseline because it feels too simple to write down.

The math, once: **~50 documents are ~400 chunks.** Memory is irrelevant. QPS is irrelevant. The live problems are already the ones that kill production RAG — lost-in-the-middle, cosine ≠ relevance, boundary bleed, unfaithful generation — they are just still **eyeballable**. Naive RAG is a legitimate design in a narrow envelope and malpractice outside it. This page is that envelope.

## 1. What I would build

A **deliberately naive, three-service RAG loop**, on purpose, as a measurement floor.

- **Ingestion** that extracts, splits with a frozen dumb chunker, embeds with one pinned model, and flips an `active` batch in Postgres/pgvector. PDF extract is the unfashionable place I would actually spend hours. Soup in the index is not a retrieval bug.
- **Retrieval** that embeds the raw question and returns cosine top-k. No BM25, no rerank, no cutoff. The chunk-list JSON is the product; the SQL is boring.
- **Generation** that stuffs rank-ordered chunks into a strict "only from context" prompt, short-circuits on empty retrieval, and logs the stuffed text. Synchronous. Stateless Ask.
- **A frozen eval set of ≥20 questions** written *before* prompt fiddling, with exact-token probes, a boundary probe, a multi-part probe, and known distractors. Human scores: retrieved-right / supported-by-context / correct-in-corpus.
- **Compose, then k8s**, one replica each, ClusterIP, secrets in the environment. Infra reps, not a platform.

I would not start with LangChain's kitchen sink, a Pinecone console, or a reranker "so the demo doesn't embarrass me." The embarrassment is the deliverable.

If Phase 0 shows the corpus is five markdown files and the questions are "what is my name," this still ships — but the eval set has to get harder or the baseline is a toy number that later tiers cannot fail to beat. If Phase 0 shows a company wiki and customer users, I would **refuse this design** and point at §1.1 / §1.3 / the at-scale project.

## 2. What I would give up

Be explicit. These are not "later" disguised as principles. They are out of *this* design. Some of them are in later roadmap projects; some are never free.

**Recall that a grep would beat.** Vector-only will lose to BM25 on slugs, error codes, and names. I give that up so the hybrid delta is real.

**A reranked prompt.** Distractors will enter context. The right chunk may sit at rank 7. I give that up.

**Structure-preserving chunks.** Tables and negations will split. I give that up rather than pretend a 512-token window is "semantic."

**Conversational follow-up.** Ask is stateless. "What about the other one?" has no "other." Context assembly across turns is `context-forge`, not a hidden buffer in Generation.

**Streaming UX.** Users wait. [ADR-005](./04_architecture_decision_records.md#adr-005).

**Freshness.** Changed files lie until re-ingest. No SLO, no watcher.

**Faithfulness.** The model will invent. The prompt will ask it not to. I will score the violations, not build a detector here.

**Multi-tenant safety.** There is no ACL. Sharing the index is sharing the corpus.

**Operational simplicity of a script.** Three services are strictly worse ops than a monolith at this scale. I pay that to have a Retrieval seam. If I were building a one-off internal tool with no sequel, I would give up the microservices instead. [ADR-004](./04_architecture_decision_records.md#adr-004).

**RAGAS / CI quality gates.** A spreadsheet is the eval. Using RAGAS here would steal §1.5's punchline.

**The fantasy that k8s makes it production.** One replica of a toy is a toy on a cluster. I give up pretending HA is in scope.

**Tuning the demo question until it works.** Frozen eval set. If the live demo question is also in the eval set, say so; that is overfitting, and an interviewer is allowed to ask a different question.

## 3. Cost, in the units that actually hurt

**Money is not the problem.**

- Embeddings for a few hundred chunks: single-digit dollars, including re-ingests.
- LLM: cents per Ask. A weekend of demos does not need a gateway or a cache.
- Postgres: local disk, or a small instance you already know how to run.
- Pinecone-class SaaS: a bill and a vendor relationship **for no capacity reason**. That is why [ADR-002](./04_architecture_decision_records.md#adr-002) refuses it.

**Operator time is the bill.**

- Writing eval questions that are not compliments to the corpus.
- Looking at PDF extracts.
- Sitting through Phase 5 and writing "this failed because of X" instead of changing k until it passed.
- Matching `embed_model_id` across two services because you chose microservices.

**k8s time is a chosen tax.** Cluster bring-up, PVCs, secret wiring. Budget it as career practice, not as a requirement of 400 vectors. Kind/minikube is enough to claim the skill; EKS-for-this is résumé cosplay unless you already live there.

**Quality cost of the omissions** is the cost that matters in production, and is **accepted here**: wrong neighbors, ignored middle chunks, unfaithful fluent answers. The Phase 5 table is how that cost is made visible instead of being paid by a user who believed the chatbot.

## 4. Why not just build the good version

Because then you have no idea whether the good version was worth it.

Hybrid + rerank + structure-aware chunking + CRAG + RAGAS is a pile of moving parts. Each part has a latency tax, a failure mode, and an ops surface. The industry default is to build the pile, ship a demo that "feels smart," and never know which part paid for itself.

This project exists so that later, on the **same corpus and the same questions**, a table can say:

| System | Precision@5 | Supported-by-context | Correct-in-corpus | p50 Ask latency | Notes |
| --- | --- | --- | --- | --- | --- |
| Naive (this) | e.g. 0.4 | e.g. 0.55 | e.g. 0.45 | LLM-dominated | baseline |
| Hybrid + rerank (§1.1) | ? | ? | ? | +rerank ms | must beat naive on exact-token and distractors |
| + CRAG (§1.2) | ? | ? | ? | +loop | must beat on multi-part / empty-ish retrieval |
| Hierarchical (§1.4) | ? | ? | ? | ? | must beat on bleed / section questions |

If naive already scores 0.9 on a fluffy eval set, the later systems have nothing to prove and will look like complexity for its own sake. That is a Phase 0 eval-set problem, not a reason to skip naive.

If you skip naive and start at §1.1, you will still need a control. The control will be a branch with rerank off, built under time pressure, measured once, and then contaminated. Doing naive **first**, frozen, is cheaper than reconstructing it.

Building naive and then "just adding a reranker in this repo" is the third failure: you no longer have a baseline, and you no longer have a clean §1.1 service. **Stop. New project.**

## 5. When naive RAG is actually fine vs malpractice

### Fine (ship it, call it a tool, do not call it a platform)

- Single user, docs they already have rights to, **low stakes** (searching your own notes, a portfolio Q&A, an internal toy).
- Corpus small enough that the operator can still read top-k and say "that's the wrong paragraph."
- Users can see sources (chunk filenames/text) and are expected to verify. The LLM is a reader, not an authority.
- Failure is embarrassment or a wasted minute, not a wrong clinical/financial/legal action.
- You have a re-ingest ritual and you actually run it.

In that envelope, adding hybrid/rerank/k8s-HA is **over-engineering**. A monolith script plus Postgres is even more honest than three services — three services are for the roadmap seam, not for the user's need.

### Malpractice (do not ship this design)

- **Customer-facing** answers that might be believed (support bot, HR bot, policy bot). Fluent unfaithful generation is the product harm.
- **More than one trust boundary** on one index (employees in different groups, customers, mixed public/confidential). No retrieval-time ACL means leakage is a cosine accident away. Post-filters on top-k are not a fix.
- **Stakes**: medicine, law, credit, safety procedures, anything you'd want a citation trail for.
- **Corpus growth** past a few thousand chunks, or a wiki that changes daily, without leaving this architecture. You will not eyeball failures; you will get a dashboard of green latencies and angry users.
- **Selling it as "production RAG"** to skip §1.1–1.5. The name naive is a warning label. Removing the word from the README to impress a hiring manager is the malpractice.

If a stakeholder wants a company wiki assistant next quarter, the honest sequence is: run this baseline on a **sanitized slice**, publish Phase 5, then fund §1.1 + §1.3 + eval CI. Funding "make docqa-basic handle the wiki" is how you get Pinecone, a reranker, and still no ACLs.

## 6. Brutal summary

Naive RAG is **ingest, window, embed, top-k, stuff, hope**. At resume scale it demos well and fails in ways you can still catch with twenty questions. That is exactly enough to be worth building, documenting, and then leaving alone.

The cleverness is not the chunker. The cleverness is **refusing to fix the named failure modes in this repository**, scoring them, and making later complexity earn its keep against that score.

Three Kubernetes deployments of this system do not make it production. A reranker added "real quick" does not make it not-naive. A second LLM that checks the first does not make it faithful.

If they wanted a chatbot screenshot, this document is too long. If they wanted a baseline an AI-systems architect can defend, it is the minimum honesty.
