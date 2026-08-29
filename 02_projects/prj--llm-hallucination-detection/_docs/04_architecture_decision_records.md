# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Ensemble of Proxy Signals vs. Single Check or Boolean OR-of-Rules

**Status**: Accepted

**Context**: The scenario invites a detector. Teams reach for one of two simplicities: (1) a single method sold as sufficient (usually an LLM judge, sometimes "just NLI," sometimes "just logprobs"), or (2) a dashboard of checks where **any** red flag blocks the answer. (1) inherits that method's blind spot as the system's blind spot. (2) ORs correlated noisy proxies and produces a false-positive rate the product cannot absorb — especially once claim decomposition is in the mix, because every extra claim is another chance to fire.

Hallucination is several failure modes ([Business Overview](./01_business_overview.md)). Self-consistency, entailment, and calibrated confidence move different modes and fail differently. Combining them as a **score** preserves ranking and lets the operating point move. Combining them as OR-of-booleans does not.

**Decision**: v1 produces a **fitted risk ensemble** over a small, named feature set ([System Design §6](./03_system_design.md#6-risk-ensemble)), with missing-signal indicators. User-visible booleans exist only in the policy layer after a threshold. Hand-tuned OR-of-rules is not the default. A single-signal ship is not the default.

**Consequences**:
- (+) Coverage is additive across failure modes without forcing the highest-FP signal to dominate.
- (+) Eval can attribute: "NLI moved RAG unfaithfulness; consistency did nothing on the high-confidence slice."
- (+) Policy can choose different thresholds without retraining.
- (–) Requires labels to fit. A rule pile can be shipped on vibes; an ensemble cannot. That is the point.
- (–) A badly specified ensemble will launder a useless feature into a slightly worse score. Feature list stays small and named.
- **Alternative rejected**: LLM-judge as the only check — see [ADR-003](#adr-003).
- **Alternative rejected**: ship T0 logprobs alone as "the detector" — rejected because instruction-tuned models are overconfident, and logprobs are blind to consistent error in a different way than people think (they often still look confident).
- **Revisit trigger**: if the labeled sample stays too small to fit even a logistic model, stay in **shadow + single-signal dashboards** and do not call it an ensemble detector. Do not invent weights.

## ADR-002: Tiered Compute (Cheap Inline, Expensive Sampled/Triggered) vs. Full-Strength Checks on 100% of Traffic

**Status**: Accepted

**Context**: Self-consistency is k extra generations. A judge is another long prompt. Research protocols that set k=10 on every question are measuring a method, not operating a product. At production QPS, 100% T2 is a second serving bill and, if placed on the wait path, a latency SLO break. The useful question is not "does k=10 work in the paper?" It is "what AUC do we buy at k=3 on 5% of traffic plus a trigger?"

Cheap signals (logprob aggregates, small NLI) can run widely. Expensive signals cannot.

**Decision**: **T0/T1 on all scorable traffic** (with NLI claim caps). **T2 self-consistency only on a stratified fraction plus risk/domain triggers**, under a hard extra-token budget. Default T2 is **off the first-token wait path**. T3 judge/human is async. See [Architecture — cost tiers](./02_architecture_document.md#cost-and-latency-tiers).

**Consequences**:
- (+) Detector cost scales as a chosen tax, not as 2–10× the product's success.
- (+) Stratified T2 still supports evaluation and training without leakage if `t2_reason` is handled ([System Design §3](./03_system_design.md#3-self-consistency-sampling)).
- (–) Most requests will **not** have a consistency feature. The ensemble must treat that as missing, not as "agreed."
- (–) Triggered T2 is biased toward already-uncertain cases; it will not catch consistent-and-wrong. Stratified T2 might, if those cases disagree — they often will not. This is accepted and documented, not "fixed" by raising k on 100%.
- **Alternative rejected**: k extra samples on every request before responding — rejected as a product-default; allowed only as a per-domain exception with a written SLO (low QPS, safety-grade, user waits).
- **Revisit trigger**: if serving can speculatively decode multiple samples at near-zero marginal cost (it generally cannot), revisit placement of T2.

## ADR-003: LLM-as-Judge Demoted to Optional Async Analysis vs. Primary Detector

**Status**: Accepted

**Context**: "Use another LLM to check" is the answer this scenario exists to kill. Judges share training data and failure modes with generators, add ~1× generation cost, are unstable across prompts, and **are not ground truth**. Using them as the production gate makes evaluation circular. Using them as the only eval metric makes the project look healthy while missing the hallucinations both models like.

Judges are not useless. On a **small** sample they can prioritize human review or study disagreement. That is analysis.

**Decision**: **No LLM-as-judge on the inline path in v1. No judge labels as ensemble training targets. No judge-agreement as a go-live metric.** An optional T3 async judge may run on a budgeted subset; its output is stored as a **proxy** next to human labels for bias studies (does the judge miss the same items humans mark?).

**Consequences**:
- (+) Forces the system onto signals with a better chance of independence (evidence entailment, multi-sample disagreement, calibrated internals).
- (+) Cost stays in T0/T1 plus budgeted T2.
- (–) We give up a convenient, always-on "explanation in English" from the judge. Claim-level NLI highlights are the substitute; they are uglier and more honest.
- (–) Some nuanced errors a careful human (or a slow judge) would catch will be missed. The residual is managed with humans on a **bounded** queue and with probes, not with a 100% judge.
- **Alternative rejected**: "cheap small judge model on 100%" — still correlated, still not gold, still a second inference stack; if we are willing to run a small model on 100%, that model should be NLI/groundedness with a defined task, not a chat rater.
- **Revisit trigger**: if a **human-validated** study on *our* domain shows a specific judge prompt adding independent precision after NLI+consistency, it may enter T3 more aggressively. It still does not become T0.

## ADR-004: A Small Human-Labeled Sample Is Mandatory vs. "No Ground Truth Means Zero Labels"

**Status**: Accepted

**Context**: The constraint is **no gold answer per production request**. Teams misread this as "we cannot label, therefore we will use judges and thumbs-down." Calibration is the mapping from model internals to empirical error. That mapping is not a priori. Ensemble weights are not a priori. Precision at a threshold is not a priori. All three need labels. Without them the system can log numbers and must not claim detection.

Labels are expensive and slow. That is an argument for a **small, stratified, refreshed** sample, not for zero.

**Decision**: Phase 0 includes a sampling plan, rater guidelines, dual annotation until agreement is known, and a budget. **User-visible block/annotate does not leave shadow mode** until that sample exists and a held-out slice can report precision/recall at the proposed threshold ([ADR-007](#adr-007)). Proxies (thumbs-down, regenerations, LLM-judge) may prioritize what to label; they do not replace labels.

**Consequences**:
- (+) The project has a definition of working that survives contact with a VP who wants a percentage.
- (+) High-confidence bins can be force-included so the dangerous slice is not empty.
- (–) Calendar time. If the org will not fund raters, the honest ship is **telemetry only**. That outcome is allowed and is not a failed architecture.
- (–) Labels go stale on model change; the sample is a living cost, not a one-off dataset.
- **Alternative rejected**: train on LLM-judge labels to "bootstrap" — rejected as the default. It encodes the judge's correlated mistakes as truth.
- **Alternative rejected**: wait for "enough user reports" — users under-detect hallucinations; reports are also not stratified.

## ADR-005: Per-Domain Action Thresholds vs. One Global Cutoff

**Status**: Accepted

**Context**: False-positive cost (trust erosion, abandonment, review overload, extra latency) and false-negative cost (safety, legal, reputational) are **not properties of the scorer**. A wrong drug interaction and a wrong trivia date do not share a loss function. A global threshold will either over-block a low-stakes chat or under-block a high-stakes RAG bot. Architecture cannot pick the number.

**Decision**: Policy configuration is **per `domain_id` / `surface_id`**: thresholds, enabled actions, fail-open vs fail-closed, whether T2 may block the wait path. Unknown domains stay in shadow. Safety/trust can veto an operating point; product owns FP cost. There is no default `T=0.5`.

**Consequences**:
- (+) The same plumbing serves many products without pretending they have the same risk.
- (+) Queue quotas can be set where humans exist.
- (–) More config to get wrong. Mitigate with "new domain ⇒ shadow" and a go-live checklist in [Phase 3](./06_phased_implementation_plan.md).
- (–) Eval must **slice**, not only report a blended AUC that hides a failing domain.
- **Alternative rejected**: one company-wide "hallucination threshold" published as policy — rejected as theater.

## ADR-006: Specialized NLI / Groundedness Model vs. LLM Faithfulness Prompt on the Grounded Path

**Status**: Accepted

**Context**: Checking "does this chunk support this claim?" is a decades-old NLI-shaped task. A chat model can do it, at higher cost, with more prompt brittleness, and with the same correlation problem as judges. Inline RAG traffic needs **bounded, batchable, cheap** inference with a stable schema (entail / contradict / neutral). Claim decomposition is the same story: a small extractor vs. a frontier model rewriting the answer.

**Decision**: v1 faithfulness uses a **specialized NLI or groundedness model** (and a small decomposer). A frontier LLM is not on this path. Chunks are filtered lexically before the cross-encoder so cost is `O(claims × M)` with M small.

**Consequences**:
- (+) T1 can be on 100% of grounded traffic without a second generator bill.
- (+) Task is specified tightly enough to eval (claim-level labels).
- (–) Weaker at nuance, sarcasm, multi-hop that isn't in one chunk. Multi-hop unsupported by any chunk should often be `unsupported` anyway in a strict grounded product.
- (–) Model selection and domain mismatch (NLI trained on Wikipedia vs. your contracts) is a real quality risk. Phase 2 must measure **on our claims**, not cite a GLUE score.
- **Alternative rejected**: "just ask the generator to only use the context" as the detector — prompting is generation hygiene, not detection. It can reduce base rate; it cannot score a failure.

## ADR-007: Shadow Mode Before User-Visible Actions vs. Shipping Banners on Day One

**Status**: Accepted

**Context**: A detector's FP cost is paid immediately in UX and in human time. Score quality is unknown until labels exist. Turning on `annotate` or `block` because the ROC "looked good on 40 examples" is how products train users to ignore warnings, or how they strand a review team.

**Context (operational):** streaming makes true inline block of already-sent tokens a fantasy. Shipping a half-working retract UI as v1 is worse than shadow.

**Decision**: **All surfaces start in shadow**: scores, would-have-actions, and costs are logged; the user-visible path is unchanged. Promotion to live actions is a gated Phase 3 event per domain, requiring the labeled-set operating point, a cost model, a streaming interaction choice, and a rollback switch.

**Consequences**:
- (+) You can debug flag rate and latency before you spend user trust.
- (+) Rollback is `shadow=true`, not a code revert in a panic.
- (–) Stakeholders will ask "when does it do something?" The answer is the Phase 3 gate, not a date. If labels slip, live actions slip.
- **Alternative rejected**: live-annotate at a very high threshold "to be safe" — a rare banner that is still often wrong is how you teach users the banner is noise.

## ADR-008: No Open-Domain Web Verification in v1 vs. "Check the Internet"

**Status**: Accepted

**Context**: Ungrounded traffic has no retrieved evidence. The instinct is to retrieve some (search, Wikipedia) and then run NLI. That is a **different product**: open-domain fact verification, with freshness, jurisdiction, source-quality, legal, and cost problems. It also quietly turns every chat into a RAG call.

**Decision**: v1 does **not** fetch external evidence for ungrounded generations. Ungrounded envelope = T0 + budgeted T2 only. World-truth on that traffic is out of scope except via probes and human labels.

**Consequences**:
- (+) Scope stays a detector, not a search engine.
- (–) Ungrounded fabrication that is consistent and confident is largely missed. That is stated in [Trade-offs](./05_tradeoffs_and_honest_assessment.md) and in every exec summary. Products that cannot accept that residual should **not be ungrounded** (add retrieval, tools, or don't use an LLM).
- **Revisit trigger**: a separately scoped fact-verification service with its own source policy — not a flag on this sidecar.
