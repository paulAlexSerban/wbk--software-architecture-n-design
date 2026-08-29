# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: State Machine (LangGraph-Shaped) over a Linear RAG Chain

**Status**: Accepted

**Context**: Naive RAG is a chain: retrieve, prompt, generate. Multi-query plus correction needs (a) fan-out, (b) a branch on "was this enough?", (c) a loop back to retrieve with a *different* plan, (d) a different branch to web or refuse. A chain has concatenation. It does not have those edges.

Teams then fake the edges: a `RunnableSequence` with a lambda `if grade == "bad": retrieve()`. That *is* a state machine, unstated, without a budget, without a max-step fuse, without a name for the refuse terminal. LangGraph (or any explicit graph runtime) is not magic; it is the admission that control flow *is* the architecture.

An unbounded ReAct agent with a `search` tool is the other fake: the model *is* the router, the loop bound is "until the model says stop" or a timeout, and on-call cannot distinguish "needed two retrievals" from "the prompt got stuck."

**Decision**: Implement `kb.answer_question` as an **explicit state machine**: nodes Analyze/Decompose, RetrieveFanOut, FuseRRF, Grade, Rewrite, WebSearchFallback, Generate, Escalate; conditional edges owned by a router that holds `corrections_remaining`. LangGraph is the illustrative runtime. The invariant is the graph, not the import.

**Consequences**:
- (+) Correction and refuse are first-class, testable edges, not comments in a chain.
- (+) Budget decrement and max-steps can be enforced in one place (the router + runtime).
- (+) Telemetry maps to nodes; "why was this slow" has an answer.
- (–) More moving parts than `retrieve | generate`. Justified only if Phase 0 shows open-loop failure. See kill criteria.
- (–) Graph bugs (forgotten decrement) are outage-shaped. Tests for the forbidden terminals are mandatory, not optional.
- **Alternative rejected**: Linear chain + "if you don't know, say so" in the generator prompt. Observes too late; often does not refuse; cannot change retrieval.
- **Alternative rejected**: Chain plus a reranker only. Reorders the same set; still open-loop.
- **Alternative rejected**: Unbounded tool-calling agent. Deletes the budget; makes the model the control plane.
- **Alternative rejected**: Manual if/else in a single function without a budget object or named terminals. Same idea, worse operability; will grow a while-loop in review.
- **Revisit trigger**: the route's query mix is almost all simple lookups and first-pass context-recall already meets the SLO. Then a chain is the architecture; this ADR is void. That is a successful Phase 0 kill, not a failure.

## ADR-002: Multi-Query Decomposition and Parallel Fan-Out

**Status**: Accepted

**Context**: One embedding of a comparative or multi-hop question is a compromise vector. Retrieval returns documents that are a bit about each clause and enough about none. Raising k pulls more of the same compromise. Human searchers split the question; the pipeline should too.

Decomposition is an LLM call and S retriever calls. If the mix is "what is the PTO cap," S=1 must be legal. Always-4 is a tax, not thoroughness.

ACL must apply per sub-query. Fan-out is not a privilege escalation.

**Decision**: Before retrieve, produce a structured `QueryPlan` with 1..S_max sub-queries (working S_max = 4) and `aspects[]` for coverage. Execute sub-queries **in parallel** against the same index with the same caller ACL. Cap is enforced after the model returns, not requested in prose. S=1 is a success, not a decomposer failure.

**Consequences**:
- (+) Multi-target questions get multiple retrievals instead of one averaged miss.
- (+) `aspects` give the grader something to check besides "are there two relevant-looking chunks."
- (–) Cost: 1 decompose LLM + S retrieve vs 1 retrieve. Latency wall-clock ≈ max(sub-queries) plus decompose, not S × serial — unless someone implements it serially. Do not.
- (–) Bad decomposers emit duplicate or thought-like sub-queries. Cap + telemetry `mean_S` + Phase 1 eval. If S does not improve context-recall, skip to S=1 always (fusion-only is then pointless).
- **Alternative rejected**: Single query, larger k. Dilutes context; does not split targets.
- **Alternative rejected**: Sequential multi-hop (retrieve, read, then retrieve) as v1. That is another loop, harder to bound, more latency. Decompose-up-front is dumber and cheaper for the common comparative case. True interactive multi-hop can be a later node; it is not required to answer this scenario.
- **Alternative rejected**: Uncapped decomposition. 12-way fan-out is how you 429 the retriever.
- **Revisit trigger**: labeled mix has negligible comparative/multi-hop rate. Then decomposer is optional; Phase 1 may be "skip" and CRAG becomes grade-and-correct on a single query — still a state machine, smaller.

## ADR-003: Reciprocal Rank Fusion over Score-Normalization Merge

**Status**: Accepted

**Context**: Each sub-query returns a ranked list. Those lists may come from the same hybrid retriever but are still not one calibrated score space: a BM25@1 on a rare token is not comparable to a cosine@1 on a different sub-query. Concatenating lists naive-by-score lets one sub-query dominate. Round-robin is fair and ignores that a doc retrieved by *two* sub-queries is more likely useful.

RRF (`Σ 1/(k_rrf + rank)`) is the boring IR answer: rank-based, robust when scores are incomparable, one parameter (`k_rrf`, standard 60).

A cross-encoder reranker over the *union* of all hits is a reasonable extra, and it **reads text**, which RRF does not. It also adds a model, latency, and a window-size problem (you cannot rerank 80 chunks for free). It can sit *inside* retrieve or *after* RRF cut. It does not replace RRF as the merge of multiple lists, and it does not replace grading (rerankers pick a best order, not "this set is insufficient").

**Decision**: Merge sub-query lists with **RRF**, `k_rrf = 60` working default, deterministic tie-break on `chunk_id`, cut to `grade_window`. Optional per-list rerank is an implementation detail of the retriever node, not a substitute for fusion or for Grade.

**Consequences**:
- (+) No score calibration project across sub-queries.
- (+) Duplicate hits across lists get a natural boost (multiple rank terms).
- (–) RRF cannot save a world where every list is irrelevant. That is the grader's job.
- (–) `k_rrf` and `grade_window` need a Phase 1 sweep. Bike-shedding them in architecture review is not the work; measuring them is.
- **Alternative rejected**: Min-max or z-score fusion of raw retriever scores. Fragile across queries and retriever updates.
- **Alternative rejected**: Concatenate all lists and take global top-k by each list's native score. Incomparable units; first sub-query often wins.
- **Alternative rejected**: Replace fusion with a single reranker over the union as the *only* merge. Possible later; heavier; still not a sufficiency check.
- **Revisit trigger**: S is always 1 (ADR-002 skip). Then RRF is a no-op (single list). Keep the node so S can return without a redesign.

## ADR-004: Structured Relevance Grading as the Branch Condition

**Status**: Accepted

**Context**: Correction requires a predicate: was retrieval enough? If that predicate is a paragraph, you have built a hidden NLP parser and called it a router. If that predicate is the generator's refusal, you have paid for a completion to learn you should not have completed, and you still often get a fluent guess.

CRAG's contribution is **evaluate retrieved documents before generating**, with a three-way outcome (correct / ambiguous / incorrect in the paper; `sufficient` / `ambiguous` / `insufficient` here so "correct" is not heard as "true"). The labels must be schema-constrained: per-doc `relevant|irrelevant|ambiguous`, aggregate verdict, `missing_aspects[]`.

The grader is itself an LLM and can be wrong. That is not a reason to skip it; it is a reason to **calibrate against labels in Phase 2** before the verdict moves traffic. A miscalibrated grader that always says sufficient is a chain with extra latency. A miscalibrated grader that always says insufficient is a bill explosion.

**Decision**: Every retrieve-fuse cycle ends in a **structured grade** (batched one call over `grade_window` in v1). The router branches **only** on `verdict` and `parse_ok`. Unparseable ≠ sufficient. The generator never grades. Per-doc serial grading is not v1.

**Consequences**:
- (+) Edges are testable. Fixtures can force `insufficient` and assert refuse/rewrite, not "the prompt would have refused."
- (+) `missing_aspects` gives the rewriter a job besides "try again louder."
- (–) Grade call is on the critical path (chunks in the judge prompt). This *is* the latency tax of observation.
- (–) Calibration work is real. Phase 2 is not skippable. If the grader cannot beat a naive baseline against labels, **do not enable the loop**.
- **Alternative rejected**: Free-text judge plus regex. Hidden parser; un-auditable branches.
- **Alternative rejected**: Generator-as-grader. Wrong bill; weak refusal.
- **Alternative rejected**: Score-threshold only (e.g. "top RRF > 0.02"). Cheap, uncalibrated across queries, deaf to "wrong year same topic."
- **Alternative rejected**: Fine-tuned small evaluator as a v1 gate. Valid cost-down later (original CRAG used a retrieval evaluator); not required to have a branch. Do not block the graph on a training project.
- **Revisit trigger**: Phase 2 shows batch grading uncalibrated and per-doc grading is calibrated *and* the latency is signed. Then flip the batch decision. If neither is calibrated, kill the corrective edges; keep fusion if Phase 1 won.

## ADR-005: Bounded Corrective Loop, Explicit Fallback, Explicit Give-Up

**Status**: Accepted

**Context**: Without a cap, "they were insufficient, search more" becomes an unbounded bill and an unbounded tail — the agent failure mode. Without a refuse terminal, engineers will generate from the last bad window because the user is waiting. Without decrement-before-reentry, a graph bug is an infinite loop.

Self-consistency ensembles face the same honesty problem (failed quorum must not pick sample #1). CRAG faces it as: failed sufficiency must not pick the first fused window.

One internal rewrite is the working cap because a second internal hop rarely materializes missing corpus; web (ADR-006) is the source change. Identical rewrites must not pay retrieve.

**Decision**:
- `max_corrections = 1` internal rewrite-and-re-retrieve. Decrement **before** re-entering RetrieveFanOut.
- Identical canonicalized plans skip retrieve and go to web/refuse.
- Graph runtime **max-steps** as a safety fuse; hitting it is `cannot_answer` plus a page.
- After budget 0: web if allowed, else **`cannot_answer`**. No fluent generate from `insufficient` context. No silent "best effort" paragraph.
- Majority-of-zero-relevant-docs is refuse, not generate.

**Consequences**:
- (+) Cost and loop depth are bounded and explainable.
- (+) Refuse is visible in product; insufficiency is not laundered into tone.
- (+) `refuse_rate` and `correction_trigger_rate` become health metrics.
- (–) Users get refuses instead of fluent guesses. Product must accept that or keep the lying chain. There is no third thing that is both fluent and honest under empty context.
- (–) Support load may rise vs. the always-answer bot. Cost of honesty.
- **Alternative rejected**: Unbounded resample / agent loop until the grader is happy. Bill, latency, rubber-stamp risk.
- **Alternative rejected**: Generate anyway on insufficient. Deletes the architecture.
- **Alternative rejected**: `max_corrections=5` "to be safe." Incident slider; p95 weapon.
- **Alternative rejected**: Hash-based "just pick the top chunk" on insufficient. Deterministic, still a guess.
- **Revisit trigger**: Phase 3 measurement shows a **second** internal hop materially lifts context-recall on the labeled set, at a cost product signs. Then the number becomes 2 in a new decision, not a config tweak at 2 a.m. A route where "say something" is better than refuse should not use this project.

## ADR-006: Web / Broader Search as a Designed Fallback, Not a First Choice

**Status**: Accepted

**Context**: When the internal index does not contain the answer, rewriting the query cannot create the document. CRAG-style systems then query the web (or a broader corpus). That is a **source change**: different trust, freshness, PII leakage (query text to a vendor), and citation UX. Using web as the *first* retrieve turns an internal KB into a chatbot with a search toolbar and a compliance incident.

Enabling web on a mixed HR+public route with an LLM as the only PII gate is how you search an employee's medical leave question on the public internet.

**Decision**: Web/broader search runs **only** after internal correction budget is exhausted (or identical-rewrite skip), **only** if the route flag is on, **only** if deterministic allow-flags pass. Default for `kb.answer_question` is **off** until Phase 4 + security/product signatures. Web hits are `source_type=web`, graded, never mixed into the internal index. One web shot. Web failure or web-insufficient → `cannot_answer`, not generate-from-old-internal. Do not split a mixed-sensitivity corpus onto one route with web on.

**Consequences**:
- (+) Out-of-corpus questions have a designed path instead of hallucinating old all-hands notes.
- (+) Provenance can tell an employee this sentence is not a handbook.
- (–) Query leakage and untrusted content. Default off is the mitigation.
- (–) Web quality is a different IR problem; this project will not make Bing into a policy store.
- **Alternative rejected**: Web as default retrieve. Wrong source of truth for an internal KB.
- **Alternative rejected**: Web on every `insufficient` without flags. Compliance.
- **Alternative rejected**: Looping web queries. New unbounded agent, different logo.
- **Alternative rejected**: Generating from insufficient internal when web fails, "better than nothing." Forbidden terminal.
- **Revisit trigger**: product forbids any external search forever. Then this ADR's implementation is "always refuse after internal bound" — still a designed branch, destination = Escalate. Product wants web-first for a public-docs assistant: that is a different route with a different first node, not a flag on this one.

## ADR-007: Continuous RAGAS-Style Evaluation as a Production / Shadow Signal

**Status**: Accepted

**Context**: Multi-query + CRAG is easy to demo on five handwritten questions. Production mix drifts: new handbook versions, seasonal queries, prompt edits, model swaps, retriever upgrades. A context-recall number measured once in a notebook is not an SLO. Without production-shaped eval, the team will learn the graph "stopped working" from wrong-policy tickets, which is the expensive detector.

RAGAS (context precision, context recall; faithfulness as a guardrail) is the illustrative harness. A homegrown labeled set with the same metrics is compliant. LLM-as-judge eval is itself a bill and can be biased; it must not be 100% of production traffic unless someone enjoys paying twice.

Correction_trigger_rate ~100% is as important as a quality metric: it means the first retrieve or the grader is broken. A quality-only dashboard will miss a cost incident.

**Decision**: Treat **context precision/recall** (labeled holdout + shadow sample), **correction_trigger_rate**, **refuse_rate**, **fallback_rate**, **mean_S**, **grade parse_fail_rate**, **baseline_multiplier** (cost and latency vs single-pass), and **path-split latency p95** (happy vs corrective) as first-class metrics. Phase gates use the labeled set. Production uses rates + shadow eval. Do not alert on "correction edge fired." Do alert on rates leaving the Phase 0 band, on max-steps, on multiplier creep from config (S_max, max_corrections).

**Consequences**:
- (+) "We self-heal" has numbers. Phase 3–4 tune bounds against measurement, not folklore.
- (+) Phase 0 can kill the project if baseline is already good — the most valuable outcome.
- (–) Labeled set construction is real work. Skipping it ships a graph demo.
- (–) RAGAS/LLM judges can flatter or punish the system; spot-check with humans on a slice.
- **Alternative rejected**: One-time offline eval as the only proof. Stale by next model swap.
- **Alternative rejected**: Logging answers only. Cannot reconstruct a grade or compute context-recall without the window.
- **Alternative rejected**: Faithfulness as the *primary* SLO of this project. That's generation quality; CRAG can look good on faithfulness while still missing half the aspects (it refused or it answered a smaller question). Own sufficiency; guard faithfulness so you did not make it worse.
- **Revisit trigger**: none. If you cannot measure it, you are not operating this architecture; you are hoping.
