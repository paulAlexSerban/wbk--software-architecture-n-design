# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone pays for a grade call on every question.

The expected clever answer is: **multi-query fan-out + RRF + a CRAG-style grade + a bounded rewrite/web loop, modeled as a state machine (LangGraph).** Those words are correct. They are not free, they do not make retrieval perfect, they do not make the grader honest, and they do not fix a stale index. Passing the interview by drawing a graph with a loop and skipping the bound is capitulation of a different kind. This page is the cost of not capitulating.

## 1. What I would build

A **request-scoped state machine** over retrieval, with observation before generation.

- **Decompose** into a capped plan (S=1 legal). [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Parallel retrieve + RRF** into a grading window. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Structured grade**, three-way verdict, `missing_aspects`. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **At most one** internal rewrite-and-re-retrieve; identical plans skip. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Web fallback off by default**, on only as a signed source change. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Refuse** when still insufficient. Not generate-from-the-first-window. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Explicit graph**, not a chain and not an unbounded agent. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Rates and RAGAS-shaped eval** as the proof. [ADR-007](./04_architecture_decision_records.md#adr-007).

I would not raise top-k and call it CRAG. I would not add a reranker and call it a correction loop. I would not wrap the retriever as a ReAct tool and call the timeout a bound. I would not enable web on a mixed HR wiki because a demo looked good.

If Phase 0 shows **first-pass context-recall already meets the bar** on the real mix — especially if that mix is 90% simple lookups — this whole system is overkill. Ship the chain (maybe fusion-only if comparatives exist). The clever answer is for when **silent wrong-context answers are expensive** and you have measured that they happen.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Single-pass latency as the SLO.** Happy path already adds decompose + grade. Corrective path is roughly 2× retrieve-and-grade plus rewrite. Anyone quoting naive-RAG p95 for this system is either lying or has deleted the grade node. The tax is the point of the scenario; pay it with eyes open or do not build this.

**The cheap chain.** Operability now includes graph wiring, budget decrement, identical-rewrite skip, a refuse UX, and a dashboard that splits paths. That is more parts.

**A guarantee that the grade is right.** The grader is an LLM. False sufficient → you generate from bad context *and* you were slower. False insufficient → you pay the loop (or refuse) when the first window was fine. Calibration is the product. CRAG without Phase 2 is a longer chain.

**A fix for missing, badly chunked, or stale documents.** Re-querying the same index cannot mint a paragraph that was never indexed. Web can fetch *other* text, with other trust. Index freshness and chunking remain someone else's job — often the job that actually moves quality more per dollar than this graph.

**Zero cost overhead.** Grade prompts include the window (the expensive part). Fan-out multiplies retriever QPS. Correction multiplies both. RAGAS-as-judge on a sample is another LLM bill.

**Always-answer UX.** Refuse is the honest terminal. The lying bot wins demos and loses disputes. Product must staff or accept the chain.

**Unbounded "self-heal."** The name is a trap. Healing that cannot fail is an outage. `max_corrections=1` will feel stingy in a review; it is the architecture.

**Hallucination-proof generation.** Sufficient context can still be mis-summarized. Faithfulness is a guardrail, not this system's trophy.

**Company-wide CRAG middleware.** Wrapping every RAG route because the slide said LangGraph is how you 2–4× the LLM bill for FAQs whose top-1 was already right.

**Web as a free recall cheat.** Query leakage, untrusted snippets, citations that look internal. Default off.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence is not "they meant we can add 2 seconds."

Ask product:

1. **What is the acceptable p95 on the corrective path, as a multiple of today's RAG p95?** Working illustration: 2.5–3.5× for one internal hop. If they need "must stay under 1.2× always," they have forbidden grading on the critical path. Then this project is the wrong project (or they skip grade, which is the chain).
2. **Will you ship `cannot_answer` as a first-class UI, not a 500?** If no, they are asking to hide insufficiency, which is generate-anyway with extra steps.
3. **Is web search allowed at all, for which question classes, with which citation UX?** Expected: "yes for everything." Push back: mixed HR+public is a split-the-route conversation, not a flag.
4. **What rate of first-pass insufficiency would justify the tax?** If they will not look at a labeled mix, you are building a résumé graph.

Ask eval / domain experts:

5. **Who labels the holdout (question, must-have docs or aspects, naive-RAG window judgments)?** RAGAS without labels is another LLM judging your LLM. Better than nothing; not a gate by itself.
6. **Is faithfulness in scope for *this* team's SLO or a sister team's?** Keep it a guardrail here so CRAG does not get blamed for, or credited with, generation quality it does not own.

Ask engineering / platform / security:

7. **Retriever QPS headroom after × S × (1 + correction_rate)?** The 50M-doc platform next door will notice. See [`prj--rag-pipeline-at-scale`](../../prj--rag-pipeline-at-scale/).
8. **Grade-window token budget** (10 chunks × ~500 tokens is a real prompt). Provider RPM after adding decompose+grade to every request.
9. **Confirm skip-grade is not an approved load-shed lever.** Same class of cheat as T=0 on a consistency route.
10. **If web is even discussed: DPA, query logging, retention of snippets, deny-lists.**

What I would **not** ask for: a custom trained grader in v1, Kubernetes for the graph, a multi-agent debate, a new vector DB, "let's just use LangGraph Cloud." Those asks spend calendar that belongs to the labeled set and the SLO.

## 4. Complexity inventory (what those clever words cost)

| You take on | You shed |
| --- | --- |
| Explicit graph, budget, max-steps | The fantasy that retrieve() returns "the context" |
| Decompose prompt + S_max + mean_S telemetry | One embedding of a comparative question |
| RRF parameters and a window cutoff | Fake score mixing across sub-queries |
| Grader schema + Phase 2 calibration | Open-loop hope; "the generator will refuse" |
| ~1.5–3.5× latency/cost vs naive RAG depending on path | Sub-second-chain as a given |
| Refuse UX and staffing | Fluent empty-context answers |
| Retriever QPS multiplier | Fan-out as a free trick |
| Web policy, provenance, default-off | "Just search the internet if wiki misses" |
| RAGAS/labels + path-split dashboards | A notebook that looked good on five questions |
| Explaining why a simple FAQ got slower | Pretending observation is free |

Net: **more parts, in the right places.** The naive design is simple *and does not observe retrieval failure.* The clever design observes and sometimes recovers, at a measured tax, and still cannot invent missing docs or trust an uncalibrated grader. The interview is whether you name that tax instead of hiding it in a graph cartoon.

### What is not worth building

- An unbounded search agent with a timeout sold as CRAG.
- Per-document serial grading in v1.
- A second LLM that judges the grader.
- `max_corrections` as an on-call slider.
- Web-first retrieve on an internal policy corpus.
- Generate-anyway "fallback" when the grade fails to parse.
- Company-wide CRAG wrapper.
- Fine-tuning a T5 evaluator as a *gate* to starting the graph (optional later to cheapen grading).

## 5. When I would not do this

- **Baseline already good.** Phase 0 context-recall on the real mix meets the bar. Multi-query might still help a small comparative slice — measure Phase 1 in isolation; do not enable the loop.
- **Mix is almost all simple lookups.** The tax hits 100% of traffic to help 5%. Heuristic S=1 + skip decompose, or skip the project.
- **Latency budget cannot absorb a grade round-trip.** Then you cannot observe. Build a better index/reranker, or accept open-loop. Do not skip grade and keep the slide.
- **No labeled set and no willingness to make one.** Branch thresholds will be vibes. Kill.
- **QPS is a firehose** (batch enrichment of millions). Fan-out + grade will dominate. Different design (maybe cheaper retrieval improvements only; maybe offline CRAG on a sample).
- **The real problem is chunking / freshness / ACL.** CRAG will "heal" by looping and then refusing. Spend the quarter on the index.
- **Product requires always-fluent answers and forbids refuse.** They want the lying bot. Do not launder it through a graph.

When I **would** do this: an internal (or customer) Q&A route where (a) wrong-context answers are incidents, (b) the mix includes comparative/multi-hop/ambiguous/out-of-corpus at a measured rate, (c) first-pass retrieval measurably fails on that mix, (d) product signs a slower corrective p95 and a refuse UI, (e) security has a real answer on web (on with flags, or off). Then state machine + multi-query + RRF + bounded CRAG is the design, and this document is the bill.

## 6. Pushing back on the prompt (the actual interview)

The prompt is constructed so you either **draw LangGraph and smile**, **build an unbounded agent**, or **say "just retrieve better."** This project is the middle, with the pushback stated:

1. **A chain cannot correct.** If they wanted a chain, they should not have asked for CRAG.
2. **"Self-heal" is a bounded retry plus a source change plus a refuse.** Not a personality. Not a while loop.
3. **The latency/cost tax is not optional cleverness.** Observation is a round-trip. Fan-out is S searches. If they will not pay, they must drop correction or drop the SLA.
4. **Grading is not truth.** It is a calibrated, fallible predicate. Uncalibrated CRAG is worse than naive RAG (slower wrong answers, or a refuse storm).
5. **Web is a compliance decision, not a recall trick.**
6. **This is not the 50M-doc serving problem.** If their pain is p99 of ANN, they are in the wrong project.

Capitulation looks like: skip-grade under load, `max_corrections=5` in a hotfix, web_on=true on the HR space, generate-anyway on parse fail, or a ReAct loop "for flexibility." Call those by name in review.

## 7. Brutal summary

You cannot have always-sufficient first-pass retrieval, always-fast answers, always-fluent answers, and a loop that never costs anything. Physics and the prompt both say so.

What you can have is: **a graph that looks at the fused window, sometimes retrieves differently once, sometimes changes source if you signed that, and otherwise refuses — at about 1.5–3.5× the cost and latency of a chain, with a grader you must calibrate, without fixing the index.**

That is multi-query + RRF + CRAG as a state machine. It is the right clever answer. It does not make retrieval a function that returns truth. It does not make the model honest. It does not make the bill smaller.

If first-pass already works, do not loop. If 1.2× p95 is mandatory, do not grade on the path (and then you do not have CRAG). If refuse is forbidden, you do not have honesty. If the docs are not in the index, you do not have a retrieval bug you can self-heal — you have a corpus bug. Say that before you ship a LangGraph demo that 3× every Wi-Fi-password question and still cites last year's handbook.
