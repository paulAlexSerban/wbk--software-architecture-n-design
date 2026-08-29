# Multi-Query & Corrective RAG — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need LangGraph."** Building a correction loop against a route whose first-pass RAG already retrieves the right chunks is how you 2× a FAQ bill. Phase 4 is web plus production SLOs; cutting over without it is allowed. Cutting over without a measured baseline is not.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a one-week death march. A realistic Phase 0 is days to weeks of labeling and baseline runs, not an afternoon of drawing states. Do not compress Phase 2 by "we'll calibrate the grader in prod." Do not compress Phase 3 by skipping the refuse drill.

## Phase 0 — Baseline the Open Loop (before any graph)

**Objective**: Name the query mix, measure how often **today's single-pass RAG** retrieves insufficient context, and write down whether that rate is worth a state machine. Replace "we need CRAG" with numbers. See [Scenario](./01_scenario_and_requirements.md).

**Deliverables:**
- Written product answers to the [Trade-offs](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction) questions: corrective-path p95 multiple, refuse UI yes/no, web yes/no and for which class, insufficiency rate that justifies tax.
- A labeled holdout for `kb.answer_question` (production logs or expert-written): include **simple, comparative, multi-hop, ambiguous, out-of-corpus**. Working floor: ≥ 50 items, not five happy demos; stratify so simple lookups are not 90% of the set if they are 90% of traffic — **report both the traffic-weighted mix and the stratified set**.
- For each item: gold aspects or must-have doc ids if known; naive-RAG retrieved window; human (or carefully spot-checked RAGAS) context precision / context recall; whether the generated answer was acceptable (guardrail, not the primary metric).
- Mix report: % simple vs rest **in traffic**, not only in the set. This number decides whether decompose-every-request is affordable.
- Retriever QPS and LLM TPM headroom sketch: S=3, correction_trigger_rate 20% (example), grade window 10 chunks. Write down whether the index and the provider survive.
- Web/security one-pager: default off, or split route. Do not leave "maybe web" implicit.
- A one-page unknowns log: S_max, min_relevant, max_corrections, web flag — each `decided` or `open`. Open items that change the design are flagged immediately.

**Exit Gate:**
- [ ] Product signed a non-zero insufficiency problem **or** explicitly chose to keep the chain. Silence is not a signature.
- [ ] Baseline: first-pass context-recall / human "window sufficient" is **bad enough to care** on the mix you will actually serve (e.g. stratified hard queries fail often, *or* traffic-weighted fail rate is material). If naive RAG already meets the quality bar traffic-weighted, **kill** the full graph. Optionally continue to Phase 1 **only** if comparatives are a signed slice with their own bar.
- [ ] Refuse UI is signed **or** product dropped correction (they cannot have generate-anyway and CRAG). If they demand always-fluent, **kill**.
- [ ] Latency multiple for the corrective path is signed or the project is scoped to fusion-only (Phase 1) with **no** grade on the critical path — which is **not** CRAG; do not call it that.
- [ ] Cost/QPS sketch does not already exceed budget at S=2, max_corrections=1, grade every request. If it does, **kill** or drop to heuristic-simple skip + fusion-only.
- [ ] Feasibility: retriever has a batch/parallel API; ACL can be applied per sub-query. If the only retrieve is a tool the model must call, stop and wrap it in the graph; do not start with ReAct.

Do not "start the LangGraph in parallel" before this gate. Parallel is how the wrong loop ships with no baseline.

## Phase 1 — Multi-Query + Fan-Out + RRF (no grading loop)

**Objective**: Prove decomposition and fusion improve **retrieved context** over the Phase 0 baseline **before** adding a fallible branch. Paying for a grader that routes a fusion that does not help is lighting money on fire.

**Deliverables:**
- Decomposer → QueryPlan, S_max enforced, S=1 legal, `aspects[]` on non-simple items.
- Parallel retrieve, per-call timeouts, ACL preserved.
- RRF (`k_rrf=60` working), `grade_window` cut (even if unused for branching, produce the same window you will later grade — so Phase 2 compares apples).
- Eval: context precision/recall on the holdout vs Phase 0 single-query window. Sweep S_max (2 vs 3 vs 4) and window size on the set, not in prod.
- Metrics: `mean_S`, cap-hit rate, retrieve latency p95 vs baseline (fan-out wall clock).
- Flagged or offline only. Generator may still be naive (window stuffed, no grade). This phase does **not** claim self-heal.

**Exit Gate:**
- [ ] On the stratified **hard** slice (comparative/multi-hop), fused context-recall **beats** baseline by a margin you wrote down in Phase 0 (working bar: material lift, not 0.5% that will vanish on the next model swap).
- [ ] Traffic-weighted simple queries do **not** regress recall, or the regression is signed. If simple queries get worse because four noisy sub-queries diluted RRF, **fix decompose** (force S=1 on simple) before Phase 2.
- [ ] `mean_S` on a production-like mix is not stuck at S_max. If it is, the decomposer is a tax machine — fail the gate.
- [ ] Fan-out p95 is known. Retriever did not 429 in the experiment at realistic concurrency.
- [ ] If fusion does **not** beat baseline on hard queries: **do not add CRAG on top to compensate.** Debug retrieve/decompose/chunking, or kill. A grade loop cannot fuse signal that was never retrieved.

If Phase 1 wins **only** on fusion and simple queries dominate, consider shipping Phase 1 as the product (multi-query RAG, still a small graph or even a chain with fan-out) and **stop**. That is a successful reduction. Phase 2 is for observed insufficiency that fusion did not fix (wrong-year chunks still in the window, empty corpus, etc.).

## Phase 2 — Grade Node in Shadow (do not route on it yet)

**Objective**: Put the structured grader on the window, **log** verdicts, **do not** change retrieve or generate yet. Measure calibration against the labeled set before the verdict is allowed to spend money or refuse users.

**Deliverables:**
- Grade schema: per-doc labels, aggregate verdict, missing_aspects, parse_ok.
- Batch grade one call per window. Parse-fail handling implemented **as it will be in prod** (conservative), but the **live edge** still generates from the fused window (old behavior) so users are not yet refused by a coin-flip grader.
- Confusion matrix: grader verdict vs human "window sufficient / partial / insufficient" on the holdout.
- Parse-success rate on ≥ the holdout and a live shadow sample.
- Dashboards: verdict histogram, parse_fail_rate, grade latency and token cost (window tokens).
- Graph runtime exists (LangGraph or equivalent) with nodes wired, **correction edges disabled** (or no-op).

**Exit Gate:**
- [ ] Parse_ok ≥ 90% on the sample set (working bar). Below that, fix schema/model; do not "add retries."
- [ ] Calibration: false-sufficient rate and false-insufficient rate are **named and accepted**. Working kill: false-sufficient on windows humans marked insufficient is high enough that the loop would be theatre, **or** false-insufficient is high enough that projected correction_trigger_rate would blow the Phase 0 cost sketch.
- [ ] Grade p95 added to the chain is measured and still inside the signed latency multiple **for the happy path** (everyone pays grade once).
- [ ] Humans reviewed a slice of disagreements (grader vs label). If the grader cannot distinguish "wrong year, same topic" from relevant, it is not ready to route.
- [ ] Shadow only. Claiming "we have CRAG" in this phase is a failed gate.

If the grader cannot be calibrated, **do not proceed to Phase 3**. Keep Phase 1 fusion if it won. A miscalibrated router is worse than a chain.

## Phase 3 — Bounded Correction Loop Live (low traffic, web still off)

**Objective**: Turn on the actual correction mechanism on a slice: rewrite + re-retrieve at most once, refuse when still insufficient. Exercise the forbidden terminals on purpose.

**Deliverables:**
- Router live: sufficient → generate from kept `relevant` docs; ambiguous/insufficient + budget → rewrite, decrement first, retrieve, grade again; budget 0 → `cannot_answer`.
- Identical-plan skip.
- Union of previously relevant docs into kept context when attempt 1 succeeds.
- Client contract for `cannot_answer` (stable codes).
- `RagRun` persistence for the flagged slice.
- **Drill**: fixture first window insufficient, second sufficient → assert rewrite happened, generate used kept docs, budget did not loop.
- **Drill**: both insufficient → assert **no** generate from window 0; user sees cannot_answer.
- **Drill**: identical rewrite → no second retrieve.
- **Drill**: grade parse fail with budget 0 → cannot_answer, not generate.
- **Drill**: graph max-steps (fault injection) → cannot_answer + alert.
- Metrics: correction_trigger_rate, refuse_rate, baseline_multiplier, path-split latency, identical_skip_rate.

**Exit Gate:**
- [ ] Flagged traffic runs the loop in a real environment (or production-like).
- [ ] Forced insufficient drills observed, not "the code looks like it would refuse."
- [ ] Correction_trigger_rate on live mix is in a plausible band vs Phase 2 shadow (not 95% because the grader starved). If it is catastrophic (e.g. > 40–50% with no quality win), **do not expand traffic**. Debug grader/decompose/retrieve; do not raise max_corrections.
- [ ] Holdout context-recall **on the path that includes correction** beats Phase 1 fusion-only by a margin that pays for the extra latency — or product signs "we pay for refuse honesty, not for recall." If neither recall nor honest-refuse value is there, kill the loop, keep fusion.
- [ ] Refuse_rate is compatible with UX/staffing. If everyone hits cannot_answer, you have not met the gate — you have turned the bot off.
- [ ] Dashboards show path-split p95 and multiplier. If they do not, you cannot enter Phase 4.
- [ ] Web still off. Enabling it here to "fix" refuse_rate is a gate fail (and a compliance risk).

## Phase 4 — Web Fallback (conditional) and Production SLOs

**Objective**: Add the source-change branch **only if** Phase 0/security signed it, then default (or a real percentage of) traffic onto the graph only if quality, honesty, and cost match what Phase 0 promised.

**Entry Gate:** Phase 3 loop is honestly green **or** you are shipping Phase 3 as the product with web permanently off (then this phase is SLO-only, no web). Do not hide an unstable internal loop behind Bing.

**Deliverables:**
- If web signed: fallback node, `source_type` in prompt and UI, allow-flags, one shot, grade web, web-fail → cannot_answer not generate-from-internal. Route split if mixed sensitivity.
- If web not signed: document Escalate as the only post-budget edge. That is a complete system.
- SLOs in the same system other SLOs live in: e.g. traffic-weighted quality (shadow RAGAS or sampled human), correction_trigger_rate band, refuse_rate band, happy-path p95, **corrective-path p95**, baseline_multiplier cap.
- Alerts: trigger-rate burn, parse_fail, max-steps, multiplier creep, 429s, web error rate (if on).
- Support runbook: why this was slow; why web; why refuse; do not "skip grade" as step 1; do not raise max_corrections as step 1.
- Optional: heuristic skip decompose on simple queries **after** measuring it does not destroy the hard slice.
- Capacity: retriever and provider limits under default-on.

**Exit Gate:**
- [ ] SLO is live; a week (or a traffic-equivalent window) of data exists; it is not a single good afternoon.
- [ ] Web, if on: security review recorded; provenance visible; no HR/PII route sharing the flag.
- [ ] Web, if on: sampled answers with web citations are acceptable to product (not internal-looking).
- [ ] Cost is within the Phase 0 sketch ± an agreed band. Surprise 3× over sketch is a kill/rollback, not a finance surprise.
- [ ] Grade node still on the path under load. Skip-grade did not ship as a "performance flag."
- [ ] Faithfulness guardrail did not crater vs Phase 0 (CRAG must not make generation worse by stuffing worse windows).

This phase's web half may be skipped entirely. Skipping is a successful outcome. Skipping SLOs is not.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "keep max_corrections=3 to see if it settles" — if any of the following hold:

1. **Phase 0 finds first-pass RAG already sufficient** on the traffic-weighted mix, and the hard slice is tiny. Graph is résumé-driven. Kill; keep the chain. Optionally keep Phase 1 fusion if it helped the slice.
2. **Product forbids refuse and forbids extra latency.** This design cannot help. Kill rather than skip-grade and generate-anyway.
3. **Phase 1 fusion does not beat baseline** on hard queries. Do not add a loop to a bad retrieve. Fix index/chunking/decompose or kill.
4. **Phase 2 grader cannot be calibrated.** Do not route. Kill the loop; maybe keep fusion.
5. **Minimum tax (grade every request + S≥2) is unaffordable** at real QPS. Kill or drop to heuristic S=1 chain. Do not ship a graph that still skip-grades under load and call it CRAG.
6. **Pressure to skip the grade node** to hit p95. Constraint violation. Roll traffic down, do not un-observe.
7. **Pressure to raise max_corrections** as a quality hotfix. Constraint violation. Same class as T=0 on a consistency ensemble.
8. **Correction_trigger_rate ~100%** and prompt/schema work does not move it. First retrieve or grader is broken. Roll back to Phase 1/2 behavior until it is.
9. **Refuse storms** drown UX/staffing and recall does not improve. The corpus cannot answer the mix. Stop pretending retrieval self-heals; invest in docs/index or accept the chain's lies (explicitly).
10. **Web enabled to paper over refuse_rate** without security signature, or web queries leak sensitive classes. Turn web off immediately; treat as incident.
11. **Max-steps / infinite re-entry** observed in prod. Roll off; fix the graph; do not "add a longer timeout."
12. **Baseline was sufficient and Phase 3 was done anyway.** Roll correction off; keep fusion if it won. That is a successful reduction, not a failed project.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off, single-pass RAG" (Phase 0 baseline) or "multi-query fusion without routing" (Phase 1). After a kill, the honest output is the Phase 0 labeled numbers and mix report, plus whichever cheaper lever is justified (better chunking, fusion-only, reranker-only, or do nothing). The output is not a half-enabled graph that skip-grades on the CDN, undocumented.
