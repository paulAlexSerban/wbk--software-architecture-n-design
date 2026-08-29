# Context Assembler (context-forge) — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know we should summarize history."** Building a shrink loop against a route with no pin policy is how you industrialize `text[:N]`. Phase 4 is extra strategy; cutting over without it is allowed. Cutting over without measured part sizes and a signed tier policy is not.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a weekend hackathon. A realistic Phase 0 is days of traffic measurement and a policy meeting, not an afternoon of prompt-packing. Do not compress Phase 1 by skipping ImpossibleBudget tests.

## Phase 0 — Inventory and Baseline (before any allocator)

**Objective**: Replace "we need a context assembler" with numbers: part-size distributions, overflow rate of naive concat, tokenizer mismatch, and a signed pin/evict policy. See [Scenario](./01_scenario_and_requirements.md).

**Deliverables:**
- Written answers to the [Trade-offs](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction) questions: pins, evictable priority, cost cap yes/no, eval ownership, model ids, re-assemble-per-round, ranker ownership, summarizer-on-hot-path allowed.
- Traffic sample (production logs or a replay set, tens to hundreds of real requests, not five demos): per part type, p50/p95 token counts using a **candidate adapter**, naive-concat overflow rate against `window - output_reserve` for **each** model you actually run (including the cheap one finance prefers).
- Tokenizer drift sketch: local adapter vs provider billed/usage tokens on a sample (or vs a provider tokenize endpoint used **offline**). Proposed `safety_margin`. `chars/4` error on the same sample, as a warning poster, not as a candidate design.
- Draft `TierPolicy` for one route (working: `agent.answer_with_tools`). Pins named. Priorities named. Default strategies **Truncate/Drop only**. Summarize explicitly `off`.
- Agent-loop check: confirm whether tool rounds re-pack or append forever. If append-forever, write down that Phase 1 must be called **each round** or the project cannot help.
- Cost sketch: current input-token $ vs a hypothetical `target_input` cap vs a hypothetical Summarize-on-overflow (overflow_rate × summarizer $). Put the summarizer number next to Truncate-only so nobody "turns it on to be safe" uninformed.
- Eval inventory: what quality signal exists today (golden tickets, tool-choice accuracy, groundedness). If none, record that Phase 2 can ship telemetry but **cannot** gate strategy choice on quality.
- A one-page unknowns log: window, output_reserve, margin, max_passes, target_input — each `decided` or `open`.

**Exit Gate:**
- [ ] Pin list signed. Empty pins + "just fit" → **kill** or send them to a trimmer; do not start this library. "The whole prompt is pinned" → **kill** (ImpossibleBudget will be the steady state) or they must unpin.
- [ ] Naive overflow rate **or** fat-prompt cost is **real enough to care**. If overflow ≈ 0 on the smallest production window **and** input $ is acceptable, **kill** — ship an adapter length assertion only.
- [ ] At least one `model_id` has a trustworthy adapter path identified. If not, **kill** or fail-closed is unacceptable to them (same outcome: do not build a fake hard budget).
- [ ] Re-assemble-per-round is agreed, or the loop is not this route.
- [ ] Cost sketch exists. Summarize-on-by-default is **not** an exit item; it is a Phase 3 question.

Do not "start Truncate in parallel" before this gate. Parallel is how the wrong pins ship.

## Phase 1 — Deterministic Core (Truncate + Drop only)

**Objective**: Prove the allocator without a second model. Pins panic correctly. Counting is real. The loop halts. No Summarize. No Orderer sophistication required beyond a stable, documented serialize (even concat-by-type is acceptable if pins cannot be tail-sliced — but do not slice across part boundaries).

**Deliverables:**
- Collector + `BudgetSpec` (window, output_reserve, margin, max_passes).
- Tokenizer adapters for Phase 0 model ids; `UnknownTokenizer` fail closed; heuristic count logged only.
- Pin check → ImpossibleBudget with numbers; **tests** that a too-large system prompt does not emit a trimmed system prompt.
- Shrink loop: Truncate grains per [System Design](./03_system_design.md#41-truncate), Drop, hard-drop, re-count each pass, serialize-and-count.
- `AssemblyResult` on every call (success or typed error).
- Identity path: under-budget parts returned unchanged (modulo agreed wrapping).
- Tests: determinism (same inputs → same prompt); progress (no-op truncate exhausts); termination; query/system never absent on success.

**Exit Gate:**
- [ ] Internal/canary traffic can assemble end-to-end without Summarize.
- [ ] ImpossibleBudget drill observed (oversized pins), not "the code looks like it would error."
- [ ] Hard-drop drill observed (evictable still too big after max_passes).
- [ ] Adapter count of serialized success path `<= working_limit` on the canary set.
- [ ] Provider context-length 400 rate on canary is understood (zero, or a logged adapter bug with a plan). Not "we'll add margin later" while raising traffic.
- [ ] Summarize is not reachable in this phase (not registered, or flag default off and tested off).
- [ ] Old concat path still available if this is a migration. This phase does **not** claim quality wins.

If wrapper under-count causes 400s here, **do not start Phase 2 placement experiments**. Fix the adapter.

## Phase 2 — Orderer, Telemetry, Scoring Hook (still no Summarize)

**Objective**: Make placement explicit and make "is this better?" measurable. Truncate/Drop remain the only reducers.

**Deliverables:**
- Orderer with a named policy id; working default from [System Design](./03_system_design.md#6-ordering-placement); final serialize-and-count still enforced.
- Metrics: tokens before/after, passes, hard_drop, impossible_budget, tokens removed by Truncate vs Drop, heuristic vs adapter drift.
- Scoring hook contract: async, after user-facing completion; payload = telemetry + answer ids. **No LLM judge inside the library.**
- If evals exist: a first comparison — e.g. naive concat-with-400s-filtered vs Phase 1+2 assemble — on **cost** (always) and **quality** (if labels exist). Shadow mode preferred.
- Optional `target_input` cost cap on a slice of traffic.

**Exit Gate:**
- [ ] Dashboards show the metrics above. If they do not, you cannot enter Phase 3 (you cannot see summarizer burn).
- [ ] Placement policy is named in config, not implicit join order.
- [ ] Hook invoked on the canary path **or** explicitly deferred with a written "no evals; quality claims forbidden" note. Silence is not a hook.
- [ ] A/B or shadow has at least a **cost** delta. Quality delta required only if evals exist; if they do not, Phase 3 Summarize cannot be defaulted on (kill criterion 7).
- [ ] p95 assemble latency (Truncate/Drop) is negligible vs the user-facing LLM. If it is not, counting/loop is mis-implemented (tiny truncate steps); fix before adding network calls.

## Phase 3 — Optional Summarize behind a Flag

**Objective**: Offer Summarize only where measurement says it beats Truncate/Drop on **quality at acceptable extra $ and latency**. Default remains off.

**Entry Gate:** Phase 2 telemetry is honest. Do not hide an unbounded compressor behind a missing dashboard.

**Deliverables:**
- Summarize strategy: one call, timeout, max_output_tokens from target, fallback Truncate, `already_summarized` guard, circuit breaker.
- Flag per route/type. Library default off.
- Telemetry: summarizer_calls, ms, tokens in/out, fallback_used, error rate.
- Experiment: overflow (or cost-cap) traffic with Truncate-only vs Summarize-on-history (or one type only — do not enable on all types at once). Same eval as Phase 2.
- Kill switch runbook: disable flag; assembler remains Truncate/Drop.

**Exit Gate:**
- [ ] Experiment ran long enough to see fallback rate and latency p95, not a good afternoon.
- [ ] Decision recorded: **stay off** (allowed, successful) **or** enable on specific types because quality delta **justified** the extra generation. "It felt more context-engineery" is a failed gate.
- [ ] If enabled, circuit breaker tested (force summarizer errors → fallback, not hung requests).
- [ ] Determinism tests remain green with Summarize **off**; Summarize-on tests do not require byte-identical summaries.
- [ ] Cost is within the Phase 0 sketch band or the enable is rolled back.

This phase may conclude **Summarize never on**. That is a successful outcome.

## Phase 4 — RelevancePrioritize and Additional Routes (conditional)

**Objective**: Use real ranker scores; copy the pattern only where Phase 0 is redone. Optional. Phase 2/3 already "the system."

**Entry Gate:** Retriever (or reranker) actually emits scores on the part list. Fake uniform scores are forbidden (collector should reject or the strategy is a no-op equal to list Truncate — do not call it prioritize).

**Deliverables:**
- RelevancePrioritize on `retrieved` (and few-shots if scored).
- Compare vs Truncate-by-retriever-order on quality + tokens kept.
- Second route only after a **new Phase 0** (pins, sizes, models). Copy-paste of `agent.answer_with_tools` pins onto a coding agent is not a rollout.
- Optional placement-policy A/B now that survivors are score-selected (order vs set is still independent).

**Exit Gate:**
- [ ] No new route skipped Phase 0.
- [ ] Prioritize shows a measured keep-set difference vs Truncate **and** a quality result (or an explicit "cost-only; quality unknown" label).
- [ ] Summarize still not silently chained with Prioritize (e.g. summarize the kept chunks) without a new signed experiment.

This phase may be skipped. Skipping is a successful outcome.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the project — do not "leave Summarize on to see if it settles" — if any of the following hold:

1. **Phase 0 finds no overflow and no cost problem.** Length assertion only. Kill the allocator.
2. **Product will not name pins** and wants silent fit. Kill rather than ship a trimmer named context-forge.
3. **No tokenizer can be matched** and fail-closed is rejected. You cannot implement a hard budget. Kill.
4. **Provider 400s remain high** after adapter/margin work. Do not compensate by slicing pins. Fix count or raise margin; if still broken, kill claims of a hard budget.
5. **Impossible-budget storms** after a prompt bloat, and the response is "just unpin the system prompt in the library." Constraint violation. Shrink the prompt or raise the window.
6. **Summarize enabled without a quality signal** (no evals, no hook) **and** treated as default. Vanity compressor. Turn it off; if the team insists, kill Phase 3 as a product decision to pay for unmeasured loss.
7. **Summarize quality delta does not justify $ and latency** in the Phase 3 experiment. Stay off. Re-enabling without new evidence is a kill of engineering discipline, not a feature.
8. **Summarizer error/latency** blows the user-facing SLO; circuit breaker must trip. If it cannot, roll the flag off.
9. **Hard-drop rate is huge** and answers are junk: the budget/pins/retriever top-k are wrong. Do not "summarize harder." Fix parts or window. If pins already fill the window, ImpossibleBudget is the truth.
10. **Agent loop still concatenates tool results** without re-assemble. The library is unused where it matters. Fix the loop or kill the integration.
11. **Scoring hook becomes a synchronous LLM judge on the assemble path.** Remove it; [ADR-006](./04_architecture_decision_records.md#adr-006).
12. **Baseline Truncate+Drop already meets cost and quality** and Phase 3 was done anyway. Leave Summarize off. That is a successful reduction, not a failed project.

Rollback is always to the last phase whose exit gate was honestly green — typically "Truncate+Drop, Summarize flag off" (Phase 1–2) or "old concat + length check." After a kill, the honest output is the Phase 0 size tables and pin policy, plus whichever cheaper lever is justified (retriever top-k, smaller system prompt, larger window, length assert). The output is not a half-enabled summarizer that still `[:N]`s the system prompt in a wrapper, undocumented.
