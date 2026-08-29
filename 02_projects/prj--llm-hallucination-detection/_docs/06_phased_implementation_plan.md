# LLM Hallucination Detection — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–4 are sequential for a given surface. A new `domain_id` re-enters at Phase 0 for *labels and policy*, even if plumbing already exists. Standing rollback / kill criteria apply at every phase.

Shadow mode ([ADR-007](./04_architecture_decision_records.md#adr-007)) is the default until a Phase 3 gate is signed per domain. Numeric thresholds below are **templates to be replaced with Phase 0 measurements**; they are not universal SLOs.

## Phase 0 — Scope, baseline, and the labeled sample (no user-visible detector)

**Objective**: Find out what is even scorable, what it costs today, what the product will pay in FP, and whether anyone will fund labels — **before** building NLI, sampling, or an ensemble. Turn "detect hallucinations" into envelopes, traffic numbers, and a sampling plan.

**Deliverables**:
- Inventory of surfaces: `domain_id`, envelope (`grounded` | `ungrounded`), QPS, streaming vs buffered, current model id, whether logprobs exist, whether chunk **text** is in the trace, temperature.
- Cost/latency baseline of the **generator only** (tokens per request, p50/p95 TTFB and complete). Detector overhead will be reported against this, not against zero.
- Written FP/FN story per domain: what `annotate` / `block` / `escalate` would actually do, whether a human queue exists, fail-open vs fail-closed intent. Unsigned stories stay shadow-only forever.
- **Annotation plan**: population, stratification (envelope × domain × raw-confidence bin, including a high-confidence slice), target n justified by the precision/recall distinction you care about, dual-rating until agreement is measured, guideline version 1, privacy path for raters.
- First labeled batch in flight (not necessarily complete, but funded and started). Probe-set v0: a handful of known-good and known-bad items per envelope.
- Serving gaps logged as tickets: missing logprobs, missing chunk text, missing model version. Each gap turns a signal **off**, not into a workaround that 2×-decodes 100% of traffic.

**Exit Gate**:
- [ ] Every in-scope surface has envelope + domain + streaming interaction choice (post-stream annotate vs buffer vs next-turn only).
- [ ] Written FP/FN + action set per domain, with a named product owner and (if `block` or `fail_closed`) a named safety owner.
- [ ] Annotation funded; guidelines exist; at least the sample **frame** is drawn (ids selected) before scores are used to cherry-pick.
- [ ] Baseline generator cost/latency recorded.
- [ ] If **no** grounded traffic **and** **no** logprobs **and** T2 is unaffordable: **stop**. Remaining capability is T2-on-a-budget plus probes — too weak to call a detector. Telemetry-only is the honest outcome.
- [ ] If labels will not be funded: **stop live-action path**. Phase 1 may still log T0/T1 in shadow as instrumentation. Do not advertise detection.

## Phase 1 — Cheap inline signals + calibration spine (still shadow)

**Objective**: Put T0 on the trace, joinable and cheap, and fit a **first** calibration curve on whatever labeled batch Phase 0 completed. No user-visible action. No T2 tax yet.

**Deliverables**:
- Trace ingest with retention/PII controls ([System Design §1](./03_system_design.md#1-trace-contract-what-must-exist-before-any-signal)).
- T0 extractors: logprob aggregates if present; verbalized confidence only if the product already elicits it (do not add a second generation to "have T0").
- Calibration artifact registry keyed by `(model_id, envelope, coarse_domain)`; isotonic/Platt on a simple summary; reliability diagram.
- Shadow logger: features, `p_err_hat`, would-be policy if a **dummy** threshold were applied (for flag-rate forecasting), detector latency, extra tokens (= 0 here).
- Dashboards: score distribution, missing-logprob rate, ingest drop rate. No "accuracy" tile.

**Exit Gate**:
- [ ] Inline T0 p95 added latency within the Phase 0 budget (illustrative: small vs. generation complete time); ingest drop rate below a set bound.
- [ ] Held-out labeled slice (not the fit slice) produces a reliability diagram. If ECE is terrible, **document it** and keep the feature as uncalibrated ranking — do not present `p_err_hat` as a probability.
- [ ] High-confidence labeled bin is **not empty**. If Phase 0 sampling missed it, relabel before Phase 3.
- [ ] AUROC of T0 vs. human labels reported **sliced by envelope**. If T0 is noise on the held-out set, Phase 3 may not use it as a live gate; it can remain a feature.
- [ ] Still shadow. No banners.

If logprobs are absent, this phase is thin by design: ingest + shadow plumbing + whatever prior features exist. That is still required spine. Do not pad it with a 100% judge.

## Phase 2 — Grounded entailment + budgeted self-consistency (still shadow)

**Objective**: Turn on the two expensive-idea families in their **production shapes**: T1 NLI on all grounded traffic with caps; T2 consistency on a **small stratified fraction** plus a trigger, off the default wait path. Measure quality and cost separately. Do not mix into an ensemble until each signal has a slice metric.

Land T1 and T2 as separable deliverables with attribution (canary flags `t1_enabled`, `t2_enabled`). Bundling them into one PR is how you get a 4× bill and no idea which part moved AUC.

### 2a — Claim decomposition + NLI (grounded surfaces)

**Deliverables**:
- Decomposer + caps + chunk lexical filter ([System Design §2](./03_system_design.md#2-claim-decomposition), [§4](./03_system_design.md#4-entailment--groundedness-pipeline)).
- Specialized NLI/groundedness model chosen and **evaluated on our claims**, not on a public NLI leaderboard alone ([ADR-006](./04_architecture_decision_records.md#adr-006)).
- Claim-level labels on a subset of the grounded sample (supported / unsupported / contradicted / rater-unable).
- Features: `frac_unsupported`, `frac_contradicted`, `citation_mismatch`, `retrieval_empty`, `claims_truncated`.
- Metric: `retrieval_empty` pages if non-zero on a grounded contract.

**Exit Gate (2a)**:
- [ ] T1 p95 latency within budget at the claim/chunk caps; cap-hit rate measured (not silently 0 because you dropped the tail).
- [ ] PR curve of faithfulness features vs. rater unfaithful/contradicted labels on held-out grounded claims.
- [ ] Error analysis: top FP causes (over-split claims vs. NLI vs. missing chunk). If FPs are mostly decomposition, do not "fix" by adding a judge.
- [ ] Ungrounded traffic does **not** run T1.

### 2b — Self-consistency on a budget

**Deliverables**:
- T2 sampler: k=3 starting point, token bucket, `t2_reason ∈ {stratified, triggered, domain_policy}`, comparison via claims/clusters not raw strings ([System Design §3](./03_system_design.md#3-self-consistency-sampling)).
- `p_audit` sized from a spreadsheet (extra-token % vs. Phase 0 generator baseline). Trigger uses T0/T1 only.
- k-ablation on the labeled sample (k=3 vs 5 vs maybe 7): stop increasing k when PR-AUC flattens.
- Confirmation that T2 is **not** on the user wait path unless a domain's Phase 0 story explicitly accepted the SLO.

**Exit Gate (2b)**:
- [ ] Fleet extra-token rate matches the budget (± a small bound) on a soak; bucket-empty is observable.
- [ ] Held-out metrics: consistency features vs. labels, **sliced** into uncertain vs. high-confidence. The high-confidence slice is expected to be **weak** — if you "fix" that by raising k on 100%, you have failed the phase's intent.
- [ ] Training leakage check: ensemble work in Phase 3 must not treat triggered-only T2 as if it were a random sample ([System Design §3](./03_system_design.md#3-self-consistency-sampling)).
- [ ] Wait-path exception list is empty or signed.

**Phase 2 overall exit**: 2a complete for every in-scope grounded surface (or explicitly N/A); 2b complete or explicitly declined with a cost reason; still shadow; probe-set running on a schedule.

## Phase 3 — Ensemble + per-domain policy go-live

**Objective**: Combine signals into a score, pick operating points from labeled precision/recall **plus the FP cost story**, and promote **one domain at a time** from shadow to the least aggressive live action that the evidence supports (usually `annotate` before `block`).

**Deliverables**:
- Fitted ensemble on human labels, missing indicators, versioned artifact ([System Design §6](./03_system_design.md#6-risk-ensemble)).
- Policy engine: thresholds per domain, queue quotas, shadow flag, contradiction override if used ([System Design §7](./03_system_design.md#7-decision--action-policy)).
- Go-live packet per domain: held-out P/R at proposed T, predicted flag rate at production mix, review-hours or banner-rate, extra-token tax, streaming behavior, rollback (`shadow=true`).
- First live action is **not** `block` unless the domain is safety-grade, fail-closed was signed in Phase 0, and FP at `T_block` is accepted. Default first live action: `annotate` or `async_audit` only.

**Exit Gate** (must pass **per domain**):
- [ ] Held-out sample size is enough to make the P/R claim less embarrassing than n=40. If not, stay in shadow and label more. No "we'll monitor in prod" substitute for this.
- [ ] Predicted `flag_rate × QPS` fits the action (banners: product sign-off; escalate: staffed hours; block: safety + product).
- [ ] Blind-spot slice reported: high-confidence × (high-agreement or T2 missing) × (grounded: low unsupported) still-wrong rate. Leadership has seen this number.
- [ ] Probe-set still green (or failures explained as generator issues with a ticket).
- [ ] Rollback drill: set `shadow=true`; user-visible action stops.
- [ ] After a limited live soak (days, not hours): realized flag rate vs. predicted; if off by a large relative amount, revert to shadow and diagnose (mix shift, calibration, threshold).
- [ ] No LLM-judge in the live decision path ([ADR-003](./04_architecture_decision_records.md#adr-003)).

A domain that fails this gate stays in shadow. Other domains may proceed. **Blended company AUC is not a gate.**

## Phase 4 — Feedback loop, drift, recalibration; optional bounded judge

**Objective**: Make the system survive next week's model swap and next month's prompt change. Add T3 only as analysis. This phase is not "more detection methods." It is operations.

**Deliverables**:
- Drift monitors and pages from [System Design §10](./03_system_design.md#10-drift-monitoring): flag-rate, ECE, probes, escalation overflow, artifact validity, `retrieval_empty`.
- Recalibration / refit cadence; **automatic shadow of `block` (and default of `annotate`) when artifacts invalidate**.
- Ongoing stratified labeling (smaller than Phase 0, never zero) including high-confidence bins and production-flag audits for realized precision.
- Proxy pipeline: thumbs-down / report-inaccuracy join for **audit prioritization**, explicitly not for training.
- Optional T3 async LLM-judge on a **tiny** budgeted subset, stored as proxy, compared to humans (bias study). If judge-vs-human agreement is high **and** the judge misses the same consistent-wrong items, that study is a success at **not** promoting the judge.
- Residual report: consistent-and-wrong rate over time; retrieval-faithful-wrong handed to the retrieval owner.

**Exit Gate**:
- [ ] A simulated model-version bump in staging invalidates artifacts and shadows live blocks without a human remembering.
- [ ] ECE/AUROC re-measured on a post-refit held-out batch at least once on real traffic/labels.
- [ ] Escalation overflow is either ~0 or has an automatic degrade path that was tested.
- [ ] T3 judge, if present, is < a set fraction of traffic and is **not** in the ensemble feature list.
- [ ] Written ops run ownership: who pages, who relabels, who may set `shadow=false` again after a swap.

Phase 4 does not have a "we're done" date. Missing this phase after a live Phase 3 is how a detector becomes a stale false-negative factory.

## Standing Rollback / Kill Criteria (apply at every phase)

Any of the following pauses **live actions** (shadow on) and, if marked kill, pauses the **program**:

1. **No labels / labels unfunded** — kill the detector claim; telemetry may continue (Phase 0 gate).
2. **Precision/recall go-live on an undersized or non-stratified sample** — rollback live actions.
3. **Realized flag rate blows the review or UX budget** for more than a short soak — shadow; move threshold or disable action. Do not "hire more reviewers" as the default.
4. **Model/prompt/index change with old calibration still live on blocks** — immediate shadow of blocks; treat as a bug.
5. **Extra-token tax exceeds the signed cap** (usually T2 misconfig or 100% sampling regression) — disable T2; incident.
6. **Probe-set regression** on detector-side (NLI inverted, scorer crash-fail-closed on a fail-open domain) — rollback that component.
7. **PII incident** in rater tools or logs — halt annotation and trace dumps; security review.
8. **Judge sneaks onto 100% traffic or into training labels** — rollback that path; it is a process failure, not an experiment.
9. **Kill the program**: extra-token + review cost sustained above a conservative estimate of harm avoided; or residual consistent-and-wrong dominates the actual incidents and product still refuses to change the generator contract. At that point the sidecar is ceremony. Stop spending on k and spend on tools, retrieval, or not using an LLM.

Rollback means: `shadow=true` and/or disable the phase's signal via config, **keep ingest**, do not "fix forward" on live banners with a red eval.

## Suggested sequencing (calendar honesty)

This is not a two-week hackathon. Rough, for one primary RAG surface plus one ungrounded chat:

| Phase | What is actually slow |
| --- | --- |
| 0 | Getting serving fields, money for raters, and a written FP story |
| 1 | Ingest in the real trust boundary; first labels returning |
| 2a | Claim quality and NLI-on-our-docs (eval, not training a 70B model) |
| 2b | Serving integration for extra samples without exploding the bill |
| 3 | Arguments about thresholds; labeling enough to defend them |
| 4 | Forever: drift and relabel |

If the org wants a demo in a week, demo **shadow scores on a frozen labeled handful** and say they are not a detector yet. A week of LLM-as-judge on live traffic is how you get the wrong architecture stuck in production.
