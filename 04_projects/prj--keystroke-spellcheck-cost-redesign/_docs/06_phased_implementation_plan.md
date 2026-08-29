# Keystroke Spell-Checker Cost Redesign — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know people type a lot."** Buying GPUs against an unmeasured residual rate is how you provision a supercomputer for correctly spelled English. Phase 4 proves the 100x in dollars; claiming it after Phase 2 from a Fermi table is a failed gate.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a two-week death march. A realistic Phase 0 is days to a couple of weeks of instrumentation. Phase 1 (client dictionary) may already exist in the editor — then it is a measurement phase, not a rewrite. Distillation + cache is longer because of eval and privacy, not because Kubernetes is hard. Do not compress Phase 0 by skipping the histograms.

## Phase 0 — Measure and Replace the Fermi Table (before any GPU ask)

**Objective**: Replace \(k\), residual rate, peak factor, and current dictionary coverage with measurements (or honest proxies). Decide whether this project is a 100x inference redesign, a Hunspell gap, or a scale that does not justify the pipeline. See [Scenario — Fermi Estimate](./01_scenario_and_requirements.md#fermi-estimate-naive-per-keystroke-llm).

**Deliverables**:
- Keystrokes (or `input` events) per DAU per day: p50/p95, not just mean. Peak-hour share \(p\).
- Tokenization stats: tokens per session, words vs keys, paste rate and paste size histogram.
- Current client dictionary coverage: fraction of tokens `local_ok` / `local_suggest` / would-be `residual` on a labeled sample. If there is no client speller today, run Hunspell offline on a **consented / public** corpus — not a silent production tap of documents.
- Typo corpus: existing customer reports, public typo lists, plus a small labeled eval set for real-word confusables. This is the quality bar for later phases.
- Privacy written ask: neighbors off-device yes/no; sampled accept/reject yes/no. Do not wait for the answer to finish measurement of *on-device* stats.
- Product written ask: pause-latency acceptable; auto-apply out of scope; spell-check vs grammar/tone. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- FinOps ceiling: monthly inference cap for this feature.
- A one-page "assumption log": each Fermi cell is `measured`, `still assumed`, or `irrelevant` (e.g. DAU is not 10M). Open items that would change the design (legal no to any off-device, product insists on per-keystroke model) are flagged immediately.
- Revised cost band: naive and redesigned, using measured \(k\) and residual rate, still with serving assumptions called out as assumed.

**Exit Gate**:
- [ ] \(k\), \(p\), and a residual-rate proxy are numbers with a source, not "4,000 sounds right."
- [ ] Go/no-go: **10M-scale (or trajectory) + residual that would make per-keystroke or per-word LLM unaffordable → proceed to Phase 1–2.** **Product only needed non-word underlines → Phase 1 then stop.** **Legal forbids off-device and product requires hosted context → stop hosted path; Phase 1 only or on-device-tiny only.** All three outcomes are successful Phase 0.
- [ ] If proceeding to hosted residual: FinOps ceiling written; 100x target restated against the *revised* naive number, not the original $50M if \(k\) was wrong.
- [ ] Eval set exists and is versioned. No eval → no Phase 2 model.
- [ ] Per-keystroke logging is **not** the measurement plan. If someone "just enabled keystroke telemetry for Phase 0," that is a kill, not a gate pass.

Do not "stand up the GPU cluster in parallel" before this gate. Parallel is how the wrong fleet gets a head start.

## Phase 1 — Client Dictionary Tier (no hosted LLM)

**Objective**: Instant local spelling at Hunspell-class quality. Prove the client can carry the common case. No inference bill yet.

**Deliverables**:
- Dictionary pack + edit-distance on the keystroke/token path; `local_ok` / `local_suggest` / `residual` emitted to **in-process** metrics (counters), not to a document log.
- Confusable list that marks known real-word pairs as residual (even if in-dictionary) so Phase 2 has a defined stream.
- Mixer: local underline + click-to-fix. No auto-apply except an optional tiny allow-list of local non-word fixes, if product already does that today.
- Input-thread hitch budget: instrumentation for >X ms stalls on the typing path.
- Offline: works with the network disabled. Tested, not assumed.

**Exit Gate**:
- [ ] Coverage on the eval set: non-word recall/precision at or above the named Hunspell-class bar (write the numbers; do not say "looks good").
- [ ] Residual fraction measured in production (flagged cohort) — this *is* the 16x (or not).
- [ ] False-positive rate on a "should not underline" set (names, code identifiers if the editor is for code, product jargon) is inside a written bound.
- [ ] No input-hitch regression vs. baseline editor.
- [ ] Residual QPS **if we hypothetically sent all residuals to a model now** is computed and compared to FinOps ceiling. If even that (debounce+client only, 0% cache, no batching credit) already fits with a small cluster, Phase 3 is optional margin. If it still looks like thousands of GPUs, the trigger is wrong or residual class is too wide — fix classification before Phase 2.

If Phase 1 residual is ~0 because the product is English prose with a fat dictionary and no confusable ambition, **stop**. Do not invent a GPU to justify the project.

## Phase 2 — Debounce + Batched Residual LLM (flagged)

**Objective**: Hosted model only on residuals after trigger. Prove latency, cost per 1k sessions, and fail-open. Cache is **not** required yet (cache-aside empty = all residual misses).

**Deliverables**:
- Trigger: boundary, punctuation, \(T_{idle}\), blur; coalesce; per-session cap; paste window. [ADR-002](./04_architecture_decision_records.md#adr-002).
- Inference service: small task model, dynamic batching, generation cap, shed policy, model_version stamp. [ADR-004](./04_architecture_decision_records.md#adr-004).
- Mixer upgrade path: late suggestions drop if span generation changed; typing never waits. [ADR-005](./04_architecture_decision_records.md#adr-005).
- Flag: internal, then N% of DAU. Default off.
- Metrics: residual QPS, inference QPS, batch size, p50/p95, shed rate, GPU $, accept/ignore of shown *model* suggestions, sessions at cap.
- Load drill: 2× expected residual; confirm shed, not a 2 s p95.
- Outage drill: kill inference; editor still types; local underlines remain.

**Exit Gate**:
- [ ] p95 suggestion latency (pause → mixer) ≤ 250 ms at the flagged cohort's peak, or a written exception with a product signature (not "we'll optimize later").
- [ ] Cost per 1k sessions (or per million tokens processed) is measured and extrapolated to 100% DAU. Extrapolation at or under the 100x band vs. revised naive, **without counting on cache**. If this already misses the FinOps ceiling, **do not add cache as a miracle** until residual classification is tightened; cache is ~2–3x, not 100x.
- [ ] False-positive / harmful suggestion rate on eval + sampled production is inside bound. A model that "fixes" correct `their` at 5% is a failed gate.
- [ ] Fail-open drill passed. Retry-storm absent (inference 5xx does not multiply QPS).
- [ ] Per-session residual histogram: no cohort at keystroke-rate. If there is one, the trigger is a bug; do not raise GPU count to absorb it.
- [ ] Privacy: residual payloads match the strip rules; no user id; logs sampled. Legal has signed the actual payload, not the slide.

If the model cannot beat client-only on the residual eval, **do not proceed to cache**. A cache of a useless model is a global amplifier of uselessness. Kill the hosted path; keep Phase 1.

## Phase 3 — Shared Cache in Front of the LLM

**Objective**: Zipf the residual. Hit-rate is a measured SLO, not a hope. Poison controls exist before default-on.

**Entry Gate**: Phase 2 exit is honestly green. Do not use the cache to hide an SLO miss ("it'll be faster when it hits"). A miss must still meet Phase 2 latency.

**Deliverables**:
- Cache-aside GET before infer; PUT on confident, privacy-eligible results including `ok`.
- Key spec as in [System Design §3](./03_system_design.md); model_version in the key; TTL ~24 h.
- Kill switch: delete key, prefix, namespace. Runbook with an owner, not a wiki wish.
- Hit/miss/skip-privacy metrics; key-cardinality dashboard (if cardinality ≈ request count, the key is too fine).
- Poison drill: insert a bad entry in a non-prod namespace; confirm kill; confirm clients stop seeing it within a stated bound (TTL is not the only control if you can delete).
- Optional: exclude confusables from cache if Phase 2 showed they are poison-prone. That is a valid outcome, not a failed cache.

**Exit Gate**:
- [ ] Hit rate on residual GETs ≥ 50% **or** a written decision that cache is not worth operating (ADR-003 revisit) and 100x still holds from Phase 2 numbers. Both are valid. Pretending 20% is 50% is not.
- [ ] Cardinality and privacy skips understood. A 90% skip-privacy rate means the strip rules or the product (lots of emails/URLs) make the cache idle — fix keys or drop the cache.
- [ ] Poison drill passed; on-call can execute kill without the owning engineer.
- [ ] GPU QPS dropped vs. Phase 2 at the same cohort size, in proportion to hit rate, ± noise. If GPU QPS did not drop, the cache is not on the path — find the bypass.
- [ ] No auto-apply still holds. A "let's trust the cache now that it's hot" request is a kill criterion, not a Phase 3 stretch.

## Phase 4 — Default-On, Dashboards, Kill Switches, Optional Hot-Pack Compile

**Objective**: 100% of eligible users on the pipeline. Prove the monthly bill. Prove UX did not regress. Remove any leftover "just call the model" prototype path.

**Deliverables**:
- Flag default ON for the v1 language pack. Other languages are new packs, not silent fallback to hosted-everything.
- Cost/quality dashboard: GPU $, residual QPS, hit rate, accept rate, hitch rate, vs. Phase 0 baseline.
- Time-box to delete any prototype per-keystroke or per-document prompt path.
- Optional: compile hottest N cache keys into the next dictionary release (reviewed, not automatic from live PUT). Only if Phase 3 hit rate and review staffing exist.
- Support note: local underline vs. delayed contextual suggestion; "spell-check is fine, smart suggest is degraded" during GPU incidents.

**Exit Gate**:
- [ ] Realized monthly inference cost inside the 100x band vs. the **Phase 0 revised naive**, not vs. a made-up $50M if measurements changed. Working expectation: well below $500k; stretch is the low-five-figures GPU line if serving and hit rate land.
- [ ] Accept rate of shown suggestions flat or up vs. Phase 2; hitch complaints not up vs. Phase 0.
- [ ] Naive/prototype path gone or 410'd. A hidden flag that restores `keydown` inference is a failed gate.
- [ ] Kill switches (inference shed, cache namespace drop, feature off → client-only) drilled in production-like conditions.
- [ ] Language / DAU growth plan: inference QPS must not be assumed linear in DAU without a cache-warm argument.

This phase may be short (cache already hot, Phase 2 cheap) or long (eval regressions, legal caveats). Both are successful if the bill and the UX are measured.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the hosted path — do not "keep the model on to see if it settles" — if any of the following hold:

1. **Phase 0 says Hunspell is the product, or DAU/k makes naive cheap.** Proceeding to a residual GPU fleet anyway is résumé-driven. Kill hosted phases; keep Phase 1 if it earned its keep.
2. **Product requires per-keystroke (or per-grapheme) model output** and will not sign pause-latency. Do not "compromise" at every-character-of-word. Kill this architecture; the Fermi is the counter-proposal.
3. **Legal forbids off-device tokens** after Phase 1. Hosted Phase 2–3 stop. Tiny on-device neural is the only remaining residual, and only if it passes CPU/battery gates.
4. **Cost regresses toward the naive bound** (residual QPS at keystroke rate, or prompt sizes become documents). Roll flags off. Fix the trigger or the prompt. Do not buy GPUs to outrun a bug.
5. **Cache poison in production** without a working kill. Feature off to client-only. Do not "let TTL burn it down" as the only response if delete is possible.
6. **On-device neural (if shipped) blows hitch/battery budget.** Kill the neural, keep Hunspell. Do not move that work to the GPU to "help."
7. **Suggestion p95 misses SLO** and product will not accept shed-to-local. Then you are in a latency war that ends in smaller batches and more GPUs. Cap the GPU spend; if still missing, kill hosted rather than recreate 34k cards.
8. **Eval quality worse than client-only on residual.** The model is a regression. Turn it off. Caching it is forbidden.
9. **Keystroke or raw-prompt firehose enabled.** Treat as a privacy incident. Disable. This project's metrics are counters and sampled accepts, not a typing warehouse.

Rollback is always to the last phase whose exit gate was honestly green — typically "flag off, client dictionary only." After a kill, the honest output is the Phase 0 measurements plus whatever local spelling shipped. The output is not a 1% flag that still calls a 70B on every key "to collect data."
