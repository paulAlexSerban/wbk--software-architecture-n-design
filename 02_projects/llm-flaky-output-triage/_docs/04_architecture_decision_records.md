# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Diagnosis-Before-Mitigation Is a Merge Gate

**Status**: Accepted

**Context**: The default culture is to patch the prompt from the last bad completion. That is fast, locally satisfying, and systematically misroutes Class G/R/S failures into few-shot examples. A guideline ("please classify first") will lose to a twenty-minute prompt PR the first time a ship is on Friday. The alternative — "let engineers try whatever, measure at the end" — is how you measure a mix of overfitting-to-ticket and unrelated prompt drift, then keep the change because the ticket went quiet.

**Decision**: A mitigation cannot be merged as a **fix** without a `failure_class` (or a time-boxed `class_unknown` investigation) and citation of `failure_record_id`s. Phase 2 enforces this as a PR checklist. Phase 3 enforces it in CI. Experiments without a class are allowed in a playground or a feature flag; they are not allowed to rewrite the production prompt/index/decoding config under the word "fix." See [Scenario — ASR 1](./01_scenario_and_requirements.md#architecturally-significant-requirements) and [System Design — Playbook](./03_system_design.md#3-mitigation-playbook).

**Consequences**:
- (+) Wrong-lever patches become visible before they become the prompt.
- (+) Retrieval and platform owners get routed work instead of absorbing it as prompt folklore.
- (–) Time-to-patch increases. The teammate who was "right" on a Class F paste will feel process-taxed. The playbook must keep Class F *fast* (auto-confirm on parse fail) or the gate will be routed around.
- (–) `class_unknown` will be abused as a skip unless it is time-boxed and reported.
- **Alternative rejected**: "try anything, A/B at the end." End-point A/B without class labels cannot tell a format win from a retrieval miss. It also needs traffic volume most teams do not have for a single flake class.
- **Revisit trigger**: if completeness/capture is so bad that every record is `class_unknown`, the gate is theater — fix tracing (Phase 0) rather than weakening the gate.

## ADR-002: Few-Shot Is Scoped to Class F (and Illustration of a Rewritten Class A Contract)

**Status**: Accepted

**Context**: Few-shot examples are a real method for demonstrating output shape and style. They are the teammate's proposed universal patch. Used on reasoning errors they can install a shortcut (conservative refund example → over-refusal). Used on retrieval gaps they cannot supply the missing document and they occupy window. Used on sampling variance they do not cut entropy. The design must not become "few-shot is always wrong," or it loses the one case where the teammate is correct.

**Decision**: Few-shot is an **in-bounds primary lever only for Class F**, and as *illustration* of an instruction that was already rewritten for Class A. It is out of bounds as the primary lever for R, G, and S unless the override path is used: named approver, paired eval showing the **target class rate** moved, written hypothesis. Few-shot pairs are first-class rows with token count, linked schema/instruction version, and expiry. See [System Design — Playbook](./03_system_design.md#3-mitigation-playbook) and [ADR-003](#adr-003).

**Consequences**:
- (+) The 2-minute answer and the merge policy say the same thing. Debate becomes a class label, not a personality conflict.
- (+) Example rot becomes a measurable budget, not an unmarked blob.
- (–) A genuine, rare case where a few-shot chain-of-thought example *does* lift Class R on a frozen sample must go through override. That is friction. It is cheaper than the common case (it doesn't lift, but the ticket looks better).
- (–) Owners will try to relabel G as F to unlock examples. Disagreement metrics and the completeness rule (cannot confirm R without chunks; G is the residual) exist to make that visible.
- **Alternative rejected**: ban few-shot entirely. Incorrect for Class F on providers without structured output, and it turns the architecture into religion.
- **Alternative rejected**: allow few-shot anywhere if "eval passes." A generic quality mean can pass while the target class does not move; the gate metric must be class-specific ([ADR-004](#adr-004)).
- **Revisit trigger**: a documented, repeated override where few-shot is the only lever that moved Class R on a held-out set *and* schema/tools were already in place. Then the playbook can add a narrow in-bounds exception, still not a default.

## ADR-003: Schema-Constrained Decoding Preferred Over Few-Shot for Class F

**Status**: Accepted

**Context**: Class F is the one class few-shot actually addresses. It is also the class where the model is being asked to emit a regular language (JSON, tool calls, enums). Most providers now expose structured output, function/tool calling, or grammar/constrained decoding. Those mechanisms enforce shape at decode time. Few-shot *suggests* shape and bills for the suggestion on every call. Validate-and-regenerate is a backstop, not a control loop you want at 8% fail rate.

**Decision**: When the serving provider can constrain output to the product schema, that is the **default Class F lever**. Few-shot may remain as optional reinforcement, versioned with the schema, and is a candidate for deletion when the constraint is sufficient. When the provider cannot constrain, the default is validate-and-regenerate with a bounded retry, then a *small* few-shot set if retries are still expensive. A growing example zoo while function calling sits unused is a playbook violation. See [Architecture — Brutal Honesty](./02_architecture_document.md#brutal-honesty).

**Consequences**:
- (+) Lower per-call token cost than N examples; higher reliability than "please return JSON."
- (+) Schema version becomes the source of truth instead of whatever the examples still illustrate (stale-enum incident in the [taxonomy](./01_scenario_and_requirements.md#class-f--format--schema-drift)).
- (–) Constrained decoding is provider-specific and sometimes worse at *content* when the schema is over-specified. Measure Class F *and* Class R/G metrics; a schema that forces keys can still fill them with invented values.
- (–) Teams on a provider without this feature will see this ADR as unusable. The fallback is written: validate-and-retry, then small few-shot. Do not invent a local constrained decoder in v1 unless serving already planned it.
- **Alternative rejected**: "few-shot first, schema later." Examples will still be there later. Default to the control that does not rot.
- **Revisit trigger**: provider constraint APIs too unstable or too slow (measured p95). Then validate-and-retry becomes default and this ADR's preference is documented as blocked.

## ADR-004: Paired Before/After on a Frozen Sample Before a Mitigation Is a Fix

**Status**: Accepted

**Context**: Re-running the original ticket is not evaluation. It is overfitting. The support-bot eval harness project already exists to make paired comparison a gate with pass/fail/inconclusive. Rebuilding a second platform here would be theater. Skipping measurement entirely is the current failure. Using a generic "quality score" as the gate lets a few-shot patch "pass" by improving format on the sample while Class G items stay wrong — or by the judge liking the verbose examples.

**Decision**: To close a mitigation as `verified_pass`, run a paired comparison of candidate vs. declared baseline on a **frozen** sample, and require movement on the **target class metric** ([System Design — Verification](./03_system_design.md#4-verification)). Inconclusive is a legal outcome and is not pass. This project consumes the eval harness in [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md); it does not re-specify judge calibration or golden-set versioning. If that harness is not in place, Phase 3 uses an honest stub (frozen file, class-specific counts, documented N) and **forbids** calling the stub statistically significant when N cannot support it.

**Consequences**:
- (+) The sequence in [System Design §5.2](./03_system_design.md#52-the-trap-caught-few-shot-patch-on-a-retrieval-gap-bug) becomes enforceable: few-shot on G fails `unsupported_claim_rate`.
- (+) Eval-harness investment is reused.
- (–) Merge latency. If the gate takes an hour, people will lobby to skip it. Size the freeze set to a minimum detectable effect *or* accept frequent `inconclusive` — do not shrink silently.
- (–) Dependence on another project's existence. If the harness is vapor, this ADR still requires a stub; it does not waive measurement.
- **Alternative rejected**: "the ticket is the test." That is the trap.
- **Alternative rejected**: production A/B only. Too slow for a prompt PR, underpowered for rare classes, and still needs labels for R/A.
- **Revisit trigger**: none for "must measure." Harness vs. stub is a Phase 3 implementation choice.

## ADR-005: Classifier Is Human-Seeded and Heuristic-First; LLM-as-Classifier Is Not the Authority

**Status**: Accepted

**Context**: Auto-classifying "why the model failed" with another LLM is the same structural mistake as [llm-hallucination-detection](../../prj--llm-hallucination-detection/README.md) using a judge as gold: correlated errors, cost, uncalibrated confidence, circular evaluation. Some screens *are* deterministic (parser fail → F; T=0 vs T>0 disagreement with T=0 good → S). The remaining classes (especially R vs. G) require looking at retrieved text and are exactly where a second model will guess.

**Decision**: v1 classification is (1) deterministic screens that may auto-confirm only F (parse-only) and may auto-suggest S, (2) human raters using a versioned labeling guide, (3) measured inter-rater agreement. An LLM classifier, if any, is Phase 5, async, suggestion-only, and gated on an agreement floor against humans. It is never the sole authority, never on the user-facing path, never the eval gold for the verifier. See [System Design — Classification](./03_system_design.md#2-classification-workflow).

**Consequences**:
- (+) Auto-F keeps the Class F path fast enough that ADR-001 is survivable.
- (+) R vs. G disagreements stay visible instead of being laundered through a judge.
- (–) Human bottleneck. Phase 1–4 will feel like "process." That is accepted; automating before agreement is measured produces a second flake source.
- (–) Labeler training is real work. A bad guide makes ADR-001 a random gate.
- **Alternative rejected**: LLM-as-classifier on every failure "to scale." Same objection as LLM-as-judge as detector.
- **Alternative rejected**: pure heuristics including "if chunks exist then R else G." Chunks existing does not mean the *relevant* span was retrieved.
- **Revisit trigger**: Phase 5 entry gate — pairwise human agreement above a documented floor on a held-out batch, *and* a suggestion model that agrees with humans at a documented rate without inflating R on chunk-less records.
