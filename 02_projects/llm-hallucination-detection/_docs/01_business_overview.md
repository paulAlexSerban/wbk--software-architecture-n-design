# LLM Hallucination Detection: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A production-side system that scores the **risk that a generated response contains a hallucination**, using only what is available at request time — the prompt, the response, model internals if exposed, and (when they exist) retrieved sources — and that **acts on that score in a way the product can afford**.

This is not a truth engine. It is not a second chatbot that "fact-checks." It is a **risk instrument**: a set of correlated, individually incomplete proxies, combined into a score, mapped onto actions (pass, hedge, block, escalate, audit later) whose operating point is chosen per domain because **false positives and false negatives have different prices in different products**.

The system exists to stop two equally common failures: shipping an LLM feature with no hallucination control at all, and shipping "we ask GPT to grade GPT" as if that were a detector.

## Business Context
- **Producer**: an existing LLM serving path — chat, RAG assistant, agent, summarizer, code helper — already in production or about to be. This project does not replace it. It attaches to it.
- **Consumer of the score**: the product surface (what the user sees), the safety/ops owner (what gets queued and paged), and eventually model-eval / quality owners (what gets measured over time). They do not want a research paper. They want fewer silently-wrong answers without making the product unusable.
- **The constraint that makes this hard**: at production scale there is **no ground-truth answer per request**. You cannot `diff` the model's output against Wikipedia, a database of facts, or a human rater, for every token of every session. Any design that assumes you can is a lab design wearing a production badge.
- **The constraint that people skip**: "no ground truth at scale" is **not** "zero labels ever." Calibration, ensemble fitting, and evaluation all require a **small, expensive, periodically refreshed labeled sample**. Pretending otherwise produces a dashboard of uncalibrated numbers that nobody should trust. See [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Organizational reality**: leadership will ask for "hallucination detection" as if it were a binary classifier with a published accuracy. Engineering will be tempted to put an LLM-as-judge on 100% of traffic because it is one API call and a prompt. Both of those instincts produce a system that is expensive, correlated with the generator's mistakes, and unauditable when it is wrong.

## The problem this is actually solving

Hallucination, for this project, means: **the model asserted something as if it were true (or as if it were supported by the provided sources) that is not**. That includes:

| Failure mode | Typical surface | What a detector can even see |
| --- | --- | --- |
| **Fabrication** | Invented citations, dates, APIs, people, policy clauses | Nothing in the request is a refutation. Only proxies: the model is uncertain, or multiple samples disagree, or (in RAG) the claim is not entailed by retrieved text. |
| **Unfaithfulness** | RAG answer that contradicts or goes beyond the retrieved chunks | The retrieved text *is* available. Entailment/groundedness is well-defined here. Truth of the source is not. |
| **Confident systematic error** | The model is sure, and would say the same thing ten times, and it is still wrong | Self-consistency is **blind**. Confidence may be **high**. This is the hardest and most dangerous class. |
| **Retrieval-brought-wrong** | The index returned an outdated or irrelevant doc; the model faithfully summarized it | Entailment will **pass**. The answer is grounded and false. This is a retrieval problem wearing a generation costume. |

A system that only catches class 2 and calls itself a hallucination detector is lying about coverage. A system that tries to catch class 3 on every request without labels is lying about capability. The architecture's job is to **name which classes it can move, at what cost, and what it will miss**.

## Why "just use another LLM to check" is not the solution

This is the default answer, and it fails for structural reasons, not prompt-quality reasons.

1. **Correlated errors.** The judge is usually the same model family, trained on overlapping data, with overlapping failure modes. When the generator confidently invents a plausible paper title, the judge often finds it plausible too. Independent evidence is the point of a detector; a second sample from the same distribution is not independent evidence.
2. **Cost and latency.** A judge call on 100% of traffic is roughly **another full generation** (often longer, because the judge prompt includes the original context plus instructions). At production QPS this is not "a bit of overhead." It is a second serving stack: tokens, rate limits, tail latency, and a bill that scales linearly with product success. Self-consistency sampling is even more expensive (k extra generations). Those costs have to be **tiered**, not sprinkled on every request. See [Architecture — cost tiers](./02_architecture_document.md#cost-and-latency-tiers).
3. **The judge hallucinates about hallucination.** LLM-as-judge papers routinely show instability across prompts, position bias, preference for verbose or confident prose, and poor calibration on the exact task of "is this factual." Using an uncalibrated judge as a production gate is how you either block good answers or rubber-stamp bad ones, depending on the prompt of the week.
4. **It does not create ground truth.** A judge label is another proxy. Treating it as gold is how evaluation becomes circular: the system is "accurate" because it agrees with itself.

LLM-as-judge is therefore **demoted**: an optional, bounded, **async** signal on a small flagged subset, never the primary inline detector, never the evaluation gold standard. [ADR-003](./04_architecture_decision_records.md#adr-003).

## What can actually be done without per-request ground truth

Three families of signal survive contact with production. None of them is a detector by itself. Each has a named blind spot, documented in [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

| Signal family | What it uses | What it is evidence of | Named blind spot | Relative cost |
| --- | --- | --- | --- | --- |
| **Calibrated confidence** | Token logprobs and/or verbalized confidence, mapped through a calibration curve fitted on a labeled sample | "The model is (un)sure, and historically that (un)certainty meant error at this rate" | Overconfident systematic error; logprobs on instruction-tuned chat models are often poorly calibrated; the curve dies when the model or domain shifts | Cheap enough for **all traffic** once logprobs are available |
| **Self-consistency** | k samples at temperature > 0; agreement / entropy over claims or answers | Variance-driven unreliability: the model does not stably believe this | **Confident, consistent hallucination** — the model that always invents the same citation | **k× generation cost**; must be sampled / triggered, not universal |
| **Entailment / groundedness** | Decompose the answer into claims; NLI-style check against **retrieved** sources | Unfaithfulness to the evidence that was actually provided | No retrieval → no signal. Wrong or stale retrieval that the answer faithfully reports → **false negative**. Claim decomposition errors → both FP and FN | Medium; a specialized NLI model is cheap compared to an LLM judge; still not free at QPS |

These signals feed a **risk ensemble**, not a boolean OR of rules. A hand-tuned "if any check fails, block" policy is how a 15% false-positive rate quietly kills the product. The ensemble outputs a score; **humans (product + safety) set the action thresholds per domain**. [ADR-001](./04_architecture_decision_records.md#adr-001), [ADR-005](./04_architecture_decision_records.md#adr-005).

## Two products, not one

The same serving stack often has both of these. They are **not the same detector**.

| Envelope | Evidence available at request time | Signals that apply | What "detected" can honestly mean |
| --- | --- | --- | --- |
| **Grounded** (RAG, tool-result, "answer from these docs") | Retrieved chunks / tool output | Confidence + entailment (primary) + optional self-consistency | "This claim is not supported by the sources we retrieved" — **not** "this is false in the world" |
| **Ungrounded** (open chat, general knowledge, creative-adjacent Q&A) | Prompt + completion + internals | Confidence + self-consistency only | "This answer is unstable and/or the model is unconfident in a way that historically meant error" — **not** "this is false" |

A design that runs entailment on ungrounded chat will invent a corpus to check against (the web, a dump of Wikipedia, another model). That is a different product (open-domain fact verification), with different legal, freshness, and cost problems. **v1 does not do that.** Ungrounded traffic gets the weaker envelope, and the docs say so out loud.

## False-positive cost is a first-class requirement

Every detector has an operating point. There is no architecture-derived "correct" precision/recall. There is a **loss function the business has not written down**, and the project fails if it pretends the architecture can write it.

**False positives** (flagging or blocking a fine answer) cost:
- User trust: banners and hedges that cry wolf get ignored, then the true positives do not land either.
- Task abandonment: extra friction, extra latency from k-sampling, refusals on questions the model actually had right.
- Human-review overload: a 5% flag rate at 100 QPS is 432,000 items/day. That is not a review queue. That is a second full-time product, or it is rubber-stamping.
- Margin: k extra generations on a hot path is a cost center that scales with success.

**False negatives** (missing a hallucination) cost:
- Safety, legal, and reputational harm — highly domain-dependent. A wrong restaurant hour is not a wrong drug interaction.
- Silent brand damage that does not show up in thumbs-down rates, because **the user often cannot tell**.

The business rule is: **thresholds are per domain / per surface, set with an explicit FP vs. FN story, and are not global.** A medical-adjacent RAG bot and a brainstorming chat do not share a cutoff. [ADR-005](./04_architecture_decision_records.md#adr-005).

## Core Value Propositions
1. **Name the coverage, do not inflate it.** The system tells operators which hallucination classes it can move and which it is blind to — especially consistent-and-wrong.
2. **Spend tokens where they buy independence.** Cheap internals (logprobs) on all traffic; expensive resampling and full entailment on a stratified plus risk-triggered subset; LLM-as-judge only async and bounded.
3. **Treat labels as a scarce resource, not as a confession of failure.** A small human-labeled sample is part of the runtime system (calibration, evaluation, drift), not a one-time research artifact.
4. **Put the operating point in product hands.** The architecture produces scores and recommended default policies. It does not ship a universal "hallucination = true" bit.
5. **Measure the detector like a detector.** Precision/recall on a held-out labeled sample, flag rate in production, review-queue depth, user-visible friction, cost-per-request overhead — not "the judge agreed 94% of the time."

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0 against a labeled sample and a traffic baseline**, not facts. A detector with no labeled sample has no success metric, only a vibe.

1. **Labeled-set discrimination, not a vanity accuracy.** On a held-out, stratified, human-labeled sample (grounded and ungrounded separately): AUROC / PR-AUC of the risk score vs. the hallucination label, **plus** precision and recall at the operating point the domain actually chose. "94% accurate" at an unstated base rate is forbidden as a reported number.
2. **False-positive rate at the chosen operating point**, measured on the labeled sample **and** inferred in production via audit sampling. If the product cannot absorb that FP rate (review capacity, or user-visible hedge rate), the operating point is wrong — not the model "needs a better prompt."
3. **Production flag rate vs. review capacity.** `flag_rate × QPS` must fit the action that flag maps to. A "send to humans" action whose arrival rate exceeds review hours is a design failure, even if the ROC curve looks pretty.
4. **Cost and latency overhead.** p50/p95 added latency on the inline path; extra tokens as a fraction of generator tokens, broken out by tier (inline / triggered sample / async audit). A detector that adds 2× cost to catch a class of error whose business cost is lower than that 2× is a net loss — this is an allowed kill criterion. See [Phased Implementation Plan](./06_phased_implementation_plan.md).
5. **Calibration quality.** Expected Calibration Error (or a reliability diagram) of mapped confidence vs. empirical error on the labeled sample, and **re-measured after every generator model/version change**. A stale calibration curve is a silent false-negative factory.
6. **Blind-spot monitoring, not just aggregate AUC.** Rate of **high-confidence, high-consistency, entailment-pass** answers that later attract user dispute, human audit labels, or known-bad probes. This is the consistent-and-wrong bucket. If it is non-trivial, the dashboard must show it rather than averaging it away.
7. **Stability under drift.** Score distribution, flag rate, and labeled-sample metrics after prompt changes, index refreshes, and model swaps. A detector whose flag rate doubles because the generator got a new system prompt is not "more sensitive"; it is uncalibrated.

## Business Rules
1. **No 100% LLM-as-judge path in v1.** Judge calls, if any, are async, sampled, and never the sole gate. [ADR-003](./04_architecture_decision_records.md#adr-003).
2. **No unlabeled production claims of precision/recall.** Until Phase 0 has a labeled sample with a documented sampling plan and inter-rater notes, the system may log scores but may not power user-visible blocks. Shadow mode exists for this reason.
3. **Grounded and ungrounded are configured as different detectors** sharing plumbing. Entailment is not run against a fantasy corpus.
4. **Inline path stays cheap.** Anything that multiplies generation (self-consistency k>1, a second LLM) is off the default hot path unless a risk trigger or a sampling budget says otherwise. [ADR-002](./04_architecture_decision_records.md#adr-002).
5. **Actions are cheaper than certainty.** Prefer hedge / cite / "I'm not sure" / retrieve-more over hard block, unless the domain's FN cost is safety-grade and the FP cost has been explicitly accepted. Hard-block is a product decision with a named owner.
6. **Recalibrate on model change, or the detector is off.** A generator swap, a major prompt change, or a retrieval-index rebuild invalidates calibration and ensemble weights until re-fit. Shipping the old curve on the new model is a defect, not a convenience.
7. **User feedback is a proxy, not a label.** Thumbs-down mixes hallucination with tone, latency, refusal, and "I didn't like the answer." It can **prioritize audit**, it cannot train the ensemble by itself.
8. **If the labeled sample cannot be funded, the project does not ship as a detector.** It can ship as telemetry. Calling telemetry "hallucination detection" is the failure mode this rule exists to prevent.

## Stakeholders
1. **Product owner of the LLM surface**: owns the FP/FN operating point and which actions are user-visible.
2. **Safety / trust owner**: owns hard-block and escalation paths; can veto an operating point that under-flags a high-FN-cost domain.
3. **Serving / platform owner**: owns latency SLO, logprob availability, and whether k-sampling is even possible on the critical path.
4. **Quality / eval owner**: owns the labeled sample, audit sampling, and the "is this detector working" report. This role is not optional; without it the ensemble is unsupervised folklore.
5. **On-call for the detector**: pages on flag-rate spikes, calibration freshness breaches, and review-queue overflow — not on every flagged response.
