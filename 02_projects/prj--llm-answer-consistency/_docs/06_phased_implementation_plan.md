# LLM Answer Consistency — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we need N=5."** Building an ensemble against a route with no gated fields is how you 5× a chatbot bill. Phase 4 is polish; cutting over without it is allowed. Cutting over without a measured baseline is not.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a one-week death march. A realistic Phase 0 is days of schema and measurement, not an afternoon of prompting. Do not compress Phase 2 by skipping the failed-quorum drill.

## Phase 0 — Define the Decision and Measure Disagreement (before any ensemble)

**Objective**: Name the gated fields, confirm they are worth N×, and measure how often a **single** sample already disagrees with itself. Replace "we need consistent answers" with a schema and a baseline rate. See [Scenario](./01_scenario_and_requirements.md).

**Deliverables:**
- Written product answers to the [Trade-offs](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction) questions: gated fields, non-100% SLO yes/no, money-dissent policy, low_confidence UX, audit requirement.
- A draft `DecisionSchema` for one route (working example: `support.refund_guidance`). Every field marked gated or expression. Enums preferred. Count of gated fields (if more than ~6, the schema is probably smuggling prose).
- Provider check: structured output at the product T>0, parse-success rate on ≥ 50 representative prompts (production logs or a labeled set — not five happy examples).
- **Baseline disagreement experiment** (still no production ensemble): for each of M held-out requests, draw k single samples (e.g. k=5) against the **same frozen snapshot**, parse, compute pairwise / plurality agreement on the gated tuple. Report per-field agreement and full-tuple agreement. This is the number that justifies N.
- Live-data inventory: sources, fail-closed list, PII, whether any sample path today tool-calls those sources (that path must die before Phase 2).
- Cost sketch: tokens per sample × N vs. current single-sample cost, at the route's QPS. Multiply the provider RPM by N. Write down whether the bill and the rate limits survive.
- A one-page unknowns log: SLO number, N, N_min, money-dissent rule — each `decided` or `open`. Open items that change the design are flagged immediately.

**Exit Gate:**
- [ ] Gated field list exists and is signed by product. Empty list → **kill** (see standing criteria). "The whole paragraph" → **kill** or send them to T=0/cache.
- [ ] Product signed a non-100% agreement SLO **or** explicitly chose to drop a constraint instead of this project. Silence is not a signature.
- [ ] Baseline: single-sample disagreement is **real enough to care** (e.g. full-tuple agreement well below the SLO). If a single sample already agrees with itself 99% at T=0.7 on this schema, an ensemble is superstition — ship schema + validator only (Phase 1) and **do not proceed to Phase 2** unless product still wants the remaining 1% at N× cost, in writing.
- [ ] Parse-success at T>0 is high enough that `N_min` is reachable without absurd N (working bar: parse_ok ≥ 90% on the sample set). Below that, fix schema/model/provider; do not "add samples."
- [ ] Cost sketch does not already exceed budget at the smallest N that could theoretically hit the SLO (N=3 is the usual floor for a majority). If it does, **kill** or drop constraints.
- [ ] Feasibility: live sources can be fetched once and frozen. If the only "live data" is inside a tool loop the model must drive, stop and redesign the fetch; do not ensemble a tool race.

Do not "start the fan-out in parallel" before this gate. Parallel is how the wrong N ships with no baseline.

## Phase 1 — Snapshot-Once + Schema-Constrained Single Sample (no ensemble)

**Objective**: Prove the plumbing that the ensemble will multiply. One sample, T>0, snapshot frozen, validator on, expression from that one object. Paying N× before this works is lighting money on fire.

**Deliverables:**
- Snapshot fetcher: fail closed on required sources; snapshot_id on the request; samples (the one sample) cannot tool-call live systems.
- Constrained generation emitting the decision schema; parse failures are explicit errors (for N=1, a parse fail *is* the request fail or a retry of the **same** snapshot, bounded).
- Validator rules v1 against the snapshot; reject does not clamp.
- Response contract: decision object + prose + `confidence=single_sample`. No claim of ensemble agreement yet.
- Metrics: parse_ok, validator_reject, snapshot_fail, latency of fetch vs generate. Not agreement-across-samples yet (N=1).
- Flagged or internal-only traffic. Old unconstrained prose path still default if one exists.

**Exit Gate:**
- [ ] Internal users can complete the route end-to-end: live fetch, schema-valid decision, validator ran, prose returned.
- [ ] A deliberately illegal model output (amount > order, if you can induce it, or a fixture injected in a test harness) is **rejected**, not shipped, not clamped.
- [ ] No live tool calls on the generation. Verified by code review and by a test that a tool definition is absent.
- [ ] T is > 0 in production config; a config of T=0 fails a check.
- [ ] No HTTP/application cache of the completion on this route.
- [ ] Old path still works for unflagged users if this is a migration. This phase does **not** "solve consistency"; claiming it does is a failed gate.

If structured output is unreliable here, **do not start Phase 2**. Five unreliable samples are five problems.

## Phase 2 — N-way Ensemble, Aggregation, Quorum, Fallback (low traffic)

**Objective**: Turn on the actual consistency mechanism on a slice of traffic, with the failed-quorum path exercised on purpose.

**Deliverables:**
- Parallel N samples, same snapshot, same T, same schema. N and N_min from Phase 0 (working: N=5, N_min=3).
- Aggregator with per-field rules; money any-dissent default unless product signed median.
- Terminal `low_confidence` / `requires_human` when quorum fails or validator rejects. Client contract documented.
- Expression: pick agreeing sample, or re-phrase if none agree with the aggregate.
- `EnsembleRun` + `SampleResult` persistence for the flagged slice (especially if money).
- **Drill**: fixture or forced split votes → confirm sample #1 is **not** shipped; confirm no amount is executable.
- **Drill**: 3/5 parse failures → `N_valid < N_min` → low_confidence.
- Metrics: per-field agreement, quorum_failure_rate, realized token multiplier, time-to-last-sample.

**Exit Gate:**
- [ ] Flagged traffic runs the ensemble in the real environment (or production-like).
- [ ] Forced disagreement drill observed, not "the code looks like it would escalate."
- [ ] Forced parse-fail drill observed.
- [ ] Validator reject still escalates under the ensemble (majority illegal → reject).
- [ ] Dashboards show N multiplier and agreement. If they do not, you cannot enter Phase 3.
- [ ] Latency p95 of the fan-out is known and accepted, or N is dropped to 3 with a new baseline — not "we'll optimize later" while raising the flag.

If quorum_failure_rate on real flagged traffic is already catastrophic (e.g. > 30%) at N from Phase 0, **do not expand traffic**. Either the schema is wrong, the prompts are wrong, the questions are ambiguous, or N does not help. Debug or kill; do not N=9.

## Phase 3 — Production SLO, Tune N, Cost Control

**Objective**: Default the route (or a real percentage) onto the ensemble only if agreement and cost match what Phase 0 promised. Tune N against **measured** agreement, not fear.

**Deliverables:**
- Agreement SLO in the same system other SLOs live in (burn alerts). Working target from Phase 0, e.g. ≥ 90% full gated-tuple quorum on production mix — **recalibrated** from Phase 2 data, not copied from the plan as scripture.
- Alerts: agreement burn, parse_fail_rate, validator_reject_rate, token multiplier, fan-out p95, 429s.
- N tuning note: if N=3 meets SLO, do not keep N=5. If N=5 misses SLO, try prompt/schema before N=7. Document the curve (agreement vs N vs $) from production or from a shadow run.
- Support runbook: why two paragraphs differ; how to read a run; what low_confidence means; do not "set T=0" as step 1.
- Capacity: provider limits × N confirmed under the new default.

**Exit Gate:**
- [ ] SLO is live; a week (or a traffic-equivalent window) of data exists; it is not a single good afternoon.
- [ ] N is the smallest N that meets SLO + N_min hygiene, or an explicit signed acceptance of extra N for a measured gain that was actually observed.
- [ ] Quorum_failure_rate is compatible with human-queue staffing. If escalations drown support, you have not met the gate — you have moved the incident.
- [ ] Cost is within the Phase 0 sketch ± an agreed band. Surprise 4× over sketch is a kill/rollback, not a finance surprise.
- [ ] T>0 and no answer cache still hold under the default-on flag.

## Phase 4 — Expression Polish and Additional Routes (conditional)

**Objective**: Spend on wording and on copying the pattern **only where a decision substructure exists**. This phase is optional. Phase 3 default-on is already "the system."

**Entry Gate:** Phase 3 SLO is honestly green. Do not hide an unstable voter behind a re-phraser.

**Deliverables:**
- Optional expression-layer T>0 call when agreeing-sample prose is missing or unsafe (numbers). Template fallback remains.
- Optional clustering **only** if a gated free-text field survived Phase 0 over protest; prefer converting it to an enum instead. If you still cluster, it is its own signed experiment with a kill switch.
- Second route only after a **new Phase 0** (schema, baseline disagreement, cost). Copy-paste N=5 is not a rollout strategy.
- Render money/enums from the locked decision into the user-visible string so prose cannot contradict the vote.

**Exit Gate:**
- [ ] Expression call failure still returns the locked decision (template), never drops the decision.
- [ ] No new route skipped Phase 0.
- [ ] Clustering, if any, has a measured benefit on agreement **and** has not become a cosine-similarity substitute for enums. If it has, remove it.

This phase may be skipped entirely. Skipping is a successful outcome.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "keep N=5 to see if it settles" — if any of the following hold:

1. **Phase 0 finds no gated decision fields** (pure creative / chat). Ensemble is résumé-driven. Kill; one sample.
2. **Product requires 100% identical answers (text or decision) and will not sign a rate.** This design cannot help. They must pick T=0 or a cache. Kill rather than fake 100% with a silent cache.
3. **Minimum N that approaches the SLO is unaffordable** at real QPS. Kill or drop a constraint. Do not ship N=3 that still fails the SLO and call it "best effort consistency."
4. **Parse-success at T>0 is structurally bad.** Do not compensate with huge N. Fix provider/schema/model or kill.
5. **Pressure to set T=0** as a hotfix. Treat as constraint violation. If product now wants T=0, turn the ensemble **off** (N=1, T=0) — do not stack.
6. **Pressure to cache completions** during a bill spike. Constraint violation. Roll traffic down, do not cache.
7. **Quorum failures flood the human queue** beyond staffing, and prompt/schema work does not move the rate. The route is too ambiguous to automate under honesty. Kill automation of the decision; keep the bot if it is chat-only.
8. **Agreement looks great and disputes show confident wrong majorities.** That is the bias warning. The ensemble is doing what it says (mode), and the mode is wrong. Stop shipping money decisions; invest in evals/grounding/rules, not in larger N.
9. **Live tools reappear on sample calls** or snapshots mix mid-flight. Roll back to Phase 1 behavior until snapshot discipline is proven again.
10. **Baseline single-sample agreement was already sufficient** and Phase 2 was done anyway. Roll N to 1; keep schema + validator. That is a successful reduction, not a failed project.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off, single schema-constrained sample" (Phase 1) or "unconstrained old path." After a kill, the honest output is the Phase 0 schema and baseline numbers, plus whichever cheaper lever is justified (validator-only, T=0 if product recants, or do nothing). The output is not a half-enabled fan-out that still caches on the CDN, undocumented.
