# RAG Evaluation & Observability Platform — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need RAGAS in CI."** Building a dashboard against 20 hand-picked questions is how you ship a screensaver. Phase 4 is polish and a *conditional* promotion of soft metrics; cutting over without it is allowed. Cutting over without a labeled set and a judge-vs-human baseline is not.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a one-week death march. A realistic Phase 0 is days to weeks of labeling and power arithmetic, not an afternoon of `pip install ragas`. Do not compress Phase 2 by skipping calibration.

## Phase 0 — Define Contracts, Label a Real Set, Measure the Judge (before any CI gate)

**Objective**: Replace "we need RAGAS and a dashboard" with a hard-gate list, a versioned eval set, a power/MDE note, a buy-vs-build note, and a judge-vs-human baseline. No merge-blocking job yet. No production tracing requirement yet. See [Scenario](./01_scenario_and_requirements.md).

**Deliverables:**
- Written product answers to the [Trade-offs](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction) questions: incident-class failures, non-blocking soft metrics yes/no, labeler role, `cannot_tell` UX, eval token budget, trace redaction, prompt-lab vs fork, buy-vs-build.
- Hard-gate check list for one pipeline (working: `docqa-basic` internal-docs). Every check is a pure function. No judge behind a hard-gate costume.
- Eval-set **v1 draft**: ≥ 80 items after de-dup, stratified (factual, multi-hop, not-in-corpus, policy, adversarial), provenance on each item, `gate` / `iterate` / `holdout` split declared. Relevant-chunk labels on the subset that will claim context precision/recall (if that subset is empty, **do not claim those metrics**).
- Power sketch: given N_gate and estimated judge noise, what MDE is detectable for faithfulness. If the MDE you care about is smaller than what N can see, either grow the set or write down that CI will only catch large drops.
- Judge baseline: human labels on ≥ 40 items (working) vs one pinned judge; κ per metric/stratum; length-bias note. This is the number that justifies trusting soft scores *at all*.
- Adapter spike (design, not a merge gate): can the pipeline return chunks + citations, not only a string?
- Cost sketch: items × pipeline tokens × PR frequency + judge_calls × judge tokens. Compare to the signed budget.
- Buy-vs-build one-pager. If buy wins, this project's remaining phases shrink to **policy** (what blocks merge) + instrumentation adapters, not a runner rewrite.
- A one-page unknowns log: MDE, κ floor, N, budget, second consumer name — each `decided` or `open`.

**Exit Gate:**
- [ ] Incident-class failures exist and map to hard-gate checks. Empty list → **kill** or reduce to "no platform."
- [ ] Product signed that v1 soft metrics do **not** block merge **or** explicitly chose to drop "CI flags regressions" as auto-fail. Silence is not a signature.
- [ ] Gate set meets size/strata/provenance bar. 20 hand-picked items → **do not proceed**. Grow or kill.
- [ ] Labeler named with a cadence. "We'll see" → **do not proceed** to Phase 2 (Phase 1 hard-gate only is still allowed).
- [ ] Judge κ measured. If κ is below the "unusable" floor (Phase 0 number; working: < 0.4 on faithfulness overall), **do not proceed** to Phase 2 with that judge; change judge/rubric or drop LLM-judged metrics.
- [ ] Power sketch is written. If N cannot detect any effect you would actually revert a PR for, do not advertise "regression detection."
- [ ] Cost sketch fits the budget at smoke-set size. If full RAGAS on every PR already blows it, the smoke/full split is mandatory going forward — record that.
- [ ] Buy-vs-build decided. If buy, subsequent phases are integration phases; do not dual-build.
- [ ] Feasibility: adapter can expose chunks. If the only API is "answer string," stop and change the pipeline contract; do not score faithfulness on a missing context blob.

Do not "stand up Streamlit in parallel" before this gate. Parallel is how the wrong 20 questions become the product.

## Phase 1 — Hard-Gate Only, One Pipeline (blocking, no soft metrics in CI)

**Objective**: Prove the plumbing the rest will multiply. Run the eval set through the adapter, persist Runs in the `prompt-lab` store (or the Phase 0 chosen store), **block merge** on hard-gate + harness health + budget. Paying judge tokens before this works is lighting money on fire.

**Deliverables:**
- Adapter for `docqa-basic` (or the chosen v1 consumer): retrieve + generate, config hashes pinned.
- Eval-set v1 **frozen** as `gate` in the registry. No author write path from a failing PR.
- Hard-gate checker wired as a **required** GitHub check. Failures list check id + item ids.
- Budget check: incomplete run → red, no partial mean (even though there is no mean yet).
- pytest entry that CI calls. No RAGAS import required in this phase.
- Identity: every run has eval_set_version + pipeline config_hash.
- Old path: PRs that do not touch pipeline/prompt/retriever/config skip the job (`prompt-lab` change-scope). A docs-only PR must not pay N_items generations.

**Exit Gate:**
- [ ] A PR that deliberately breaks a hard-gate check (remove citations, empty retrieval on factual_lookup, etc.) is **red**. Observed, not "the code looks like it would fail."
- [ ] A harness crash is red, not skipped (`continue-on-error` absent on the required check).
- [ ] Docs-only PR does not run the full gate set.
- [ ] Runs are queryable in the store. If they only exist as GitHub logs, Phase 2 has nowhere to land.
- [ ] Flake rate of the hard gate on a unchanged pipeline, N replay CI runs, is near zero. If it flakes, **do not add judges**; fix the adapter/pipeline nondeterminism (retrieval order, sampling T on the generator for eval — pin decoding for eval runs).

If the generator cannot be pinned enough to make retrieval-floor checks stable, **do not start Phase 2**. You will blame RAGAS for pipeline jitter.

## Phase 2 — Soft Metrics + Calibration Job + Dashboard (not blocking)

**Objective**: Compute RAGAS-family (or equivalent) metrics, stand up calibration, show decomposed dashboards. Merge policy unchanged (ADR-001).

**Deliverables:**
- Scorer plugins: faithfulness, answer relevancy; context precision/recall **only** where labels exist. Skip reasons recorded.
- Judge identity pinned (model + prompt hash). Eval-run temperature for the judge documented.
- Calibration job: sample, human rubric UI or spreadsheet-with-contract, CalibrationSnapshot, trust bit.
- Dashboard: per-stage, per-stratum, $ per batch, trust bit. No blended KPI as the default landing.
- Async scoring: hard-gate check can go green before judges finish; annotation updates.
- Nightly full suite if PR is smoke-only.

**Exit Gate:**
- [ ] A full gate-set batch produces scores with skip reasons, not fake recall on unlabeled items.
- [ ] Calibration snapshot exists post-Phase-0 baseline; trust bit visible on the dashboard.
- [ ] If a judge prompt change is deployed, trust resets to untrusted until a new snapshot. Drilled.
- [ ] Dashboard does not page. There is no alert yet on soft deltas (that is Phase 3).
- [ ] Token spend of a full suite is within the Phase 0 sketch ± agreed band. Surprise 3× → stop and cut metrics or N, do not "optimize later" into Phase 3.

If κ collapses vs Phase 0, **stay in Phase 2**. Do not alert on an untrusted judge.

## Phase 3 — Statistical Regression Alerting (human-reviewed, not auto-block) + Second Consumer

**Objective**: ComparisonReport with pass/fail/cannot_tell; alert a human on pre-registered `fail` slices when the judge is trusted. Test the backbone with a **second** pipeline adapter (`retrieval-x` or `rag-selfheal`). Still not merge-blocking on soft metrics.

**Deliverables:**
- Regression detector as specified in [System Design](./03_system_design.md#4-statistical-regression-test). Named baseline (usually last green main full suite).
- PR annotation: hard result + soft outcomes + trust + coverage.
- Alert path (Slack/issue): only trusted + `fail` on pre-registered slices. Human decides revert vs accept vs refresh dataset.
- Second adapter + its own eval-set family (do not blindly reuse `docqa-basic` questions on a graph/hybrid pipeline and call it comparison).
- Runbook: what `cannot_tell` means; do not "set threshold to 0.7" as step 1; do not skip the job.

**Exit Gate:**
- [ ] Replay of last N good main batches does not produce a storm of `fail` (false-positive characterization). If it does, the test or N or MDE is wrong — **do not auto-block later**, and do not page until this is honest.
- [ ] A seeded retrieval regression (e.g. top-k=1 vs baseline top-k) shows as a **retrieval** metric `fail` (or cannot_tell if underpowered — then grow N or accept the limit).
- [ ] Second pipeline plugs in without forking the runner. If the team copies the repo instead, the backbone has **failed** — see kill criteria; collapse SPI or stop claiming "one backbone."
- [ ] Alerts are staffed. If they go to a channel nobody reads, this is still a screensaver — do not proceed to Phase 4 auto-block.

If quorum of humans ignore alerts for a month, **do not add merge-block** to "make them listen." Fix the alert quality or kill soft alerting.

## Phase 4 — Production Tracing at Scale; Conditional Soft Auto-Block (optional)

**Objective**: Instrument live retrieve/generate; operational SLOs; optional cost-capped live canary. Soft auto-block remains **off by default**. Turn it on only if the evidence bar is met.

**Entry Gate:** Phase 3 alerts are honest (false-positive rate signed), tracing design (redaction, retention) signed, Phase 1–2 still green.

**Deliverables:**
- Trace collector on production pipeline(s): spans, redaction, empty-retrieval and citation-missing metrics, p95s.
- On-call runbook: reconstruct a request by id without a RAGAS score.
- Optional sampled canary: traces → Runs → scores, monthly $ cap, stop when hit.
- Evidence pack **if** anyone wants soft merge-block: κ held for N weeks, false-block rate on replayed accepted PRs below signed threshold, MDE vs N still valid, product signature.
- Default: skip auto-block. Skipping is a successful outcome.

**Exit Gate:**
- [ ] A synthetic production fault (empty index, missing citations) is visible on traces/SLO **without** waiting for nightly RAGAS.
- [ ] User-facing latency does not include a judge.
- [ ] Canary, if present, respects the cap (drilled).
- [ ] Soft auto-block, if present, has a kill switch that returns to ADR-001 in one config change.
- [ ] PII/retention review passed. If it cannot, traces shrink to ids and counters; document the reduced on-call capability.

This phase may be skipped entirely except for **minimal** tracing (even counters beat nothing). Tracing is more justified than soft auto-block. Soft auto-block without tracing is the brief in the wrong order.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "lower the threshold to see if it settles" — if any of the following hold:

1. **Phase 0 finds no incident-class contracts** (only "make it better"). Platform is résumé-driven. Kill; maybe a notebook.
2. **Product requires merge-block on RAGAS and will not staff calibration or accept flake.** This design cannot help. They must buy a vendor and still will flake, or they skip CI. Kill rather than fake a threshold.
3. **Nobody labels on cadence.** Stay at Phase 1 (hard-gate) or kill Phases 2–4. Do not run an uncalibrated judge as a dashboard.
4. **Judge κ stays unusable** after a good-faith judge/rubric change. Drop LLM-judged metrics; keep hard gates + traces + overlap.
5. **N cannot detect the MDE they would revert for**, and they refuse to grow the set. Do not claim regression detection. Kill Phase 3 advertising.
6. **Eval job is skipped or `continue-on-error`** under flake/cost pressure. Treat as constraint violation. Roll back to a smaller hard-gate until the required check is honest again.
7. **Gate set is mutated to pass** without version bump, or authors paste gate items into the prompt. Goodhart incident; freeze, refresh with review, or kill the merge-signal set.
8. **Second consumer never comes** and SPI maintenance is real cost. Collapse to a single-purpose harness; drop "backbone across all projects" from the story. That is a successful reduction, not a failed Phase 1.
9. **Eval $ exceeds the value of caught regressions** (no revert ever came from a report, bill is large). Kill soft suite; keep hard gates/traces.
10. **PII in traces** without redaction. Immediate stop of query storage; do not keep "just for a week."
11. **Pressure to put RAGAS on the hot path** during an incident. Constraint violation. Tracing and hard gates only.
12. **Buy-vs-build said buy, but a shadow runner is being built anyway.** Kill the shadow; integrate.

Rollback is always to the last phase whose exit gate was honestly green — typically "hard-gate only" (Phase 1) or "no CI, old notebook" if Phase 1 was never green. After a kill, the honest output is the Phase 0 set, κ, power sketch, and whatever cheaper lever is justified (pytest contracts, vendor, or nothing). The output is not a skipped GitHub check and a dashboard that still says Quality: 0.82.
