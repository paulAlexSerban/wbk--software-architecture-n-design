# Support Bot Eval Harness: Scenario and Requirements

## Problem Statement

A customer-support bot is about to ship a new prompt (or a prompt-plus-model pairing). The design must answer, concretely:

1. How a **golden set** is curated, versioned, stratified, and kept from rotting or being gamed.
2. How **regression is detected** when the team upgrades the model version (or swaps providers) — with a gate that can block the ship, not a slide that says "looks good."
3. How the system **catches silent quality drift** after a provider swaps the underlying model under the **same API name** (the endpoint still says `gpt-4o` / `claude-3-5-sonnet` / equivalent; the weights behind it are not what you evaluated).

This is the vibes-and-ship trap. The naive answer — run five hand-picked transcripts in a playground, eyeball the answers, maybe ask another model "is this good?", ship, and trust the vendor's model string forever — is the failure. It produces a demo that looks like evaluation and a production bot whose quality is unobserved.

## The Trap, Stated Directly

Standard LLM shipping culture treats **a handful of impressive transcripts** as evidence. If the eval is curated after the fact, graded by vibe, run once at ship time, and never pointed at the live production endpoint again, the design has already failed the problem:

- Hand-picked cases are the ones the prompt author already knows work. They measure memorization of the author's taste, not coverage of real tickets.
- "10/10 looked fine" is not a rate. A binary outcome on ten items is consistent with a true pass rate anywhere from roughly 70% to 100%. You cannot distinguish a real regression from noise at that sample size.
- An LLM judge used without calibration against humans will agree with itself and disagree with the people who actually close tickets. Position bias, verbosity bias, and self-preference (the judge liking answers that sound like the judge's family of models) are not edge cases; they are the default.
- A one-time comparison at ship time cannot see a change that happens *after* ship. Provider-side model swaps under a stable API name are a documented class of incident. Client code that keys off `model=` has nothing to notice. If there is no frozen probe set hitting production on a schedule, **there is no signal**.
- Golden sets that are edited every time the prompt fails them become a description of the prompt, not a test of it. That is Goodhart's law, not "iterating on quality."

The correct shape is: **a versioned, stratified, frozen golden set; a statistically defensible paired-comparison gate in CI; a calibrated judge with human agreement as a first-class metric; and a production canary that replays a frozen probe set against the live endpoint on a schedule, comparing score *and* behavioral fingerprints to a stored baseline.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under small samples, biased judges, shifting user traffic, and a vendor who does not owe you a version pin.

## Current State (Assumed Starting Point)

A typical first version of "we evaluated the prompt" looks like:

1. The prompt author pastes a few tickets into a playground (or a notebook).
2. They tweak until those tickets look better than last week.
3. Someone runs the new prompt against the old prompt on those same tickets and prefers the new one.
4. The prompt ships. The production `model=` string is treated as a stable identifier.
5. Quality is inferred from CSAT, ticket-escalation rate, or "nobody complained this week" — all of which lag, confound prompt quality with staffing and product changes, and will not fire on a quiet mid-week model swap that makes refunds slightly more generous or safety slightly looser.

That version will appear to work for a bot that handles FAQ paraphrases and has a human catching every money-adjacent answer. It will fail the first time a model upgrade looks fine on the author's five tickets and worse on angry-refund / policy-edge / multi-turn cases; the first time an LLM judge systematically prefers longer, more confident answers that are also more wrong; the first time the provider silently repoints the API name and CSAT takes three weeks to move.

This project documents the replacement, not a patch of that notebook.

## Target Users

- **Prompt owner / PM**: needs a gate they can defend when asked "why didn't we ship Friday," and a number that is not a vanity pass-rate.
- **Eval / ML engineer**: implements the harness; needs a data model, a judge calibration loop, and a drift detector that is not "plot the mean and squint."
- **Support ops / on-call**: needs an alert that means "the bot changed behavior," not "a dashboard exists," and a runbook that says freeze / sample live traffic / compare to last-known-good — not "look at a few chats."
- **Compliance / trust & safety**: needs the safety-sensitive stratum treated as a first-class slice (self-harm adjacent, data-exfil attempts, social engineering of the bot, unauthorized refunds/credits), not averaged away inside an overall quality score.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which intents the bot covers, which tone guidelines exist) are out of scope except as strata the golden set must cover.

1. **The golden set must be versioned, stratified, and frozen between declared refreshes.** Items have provenance (real anonymized ticket, synthetic, adversarial/safety). Strata include intent, difficulty, tone, multi-turn depth, and safety-sensitivity. A ship compares against a *named* golden-set version. Editing items to make the current prompt pass is a version bump with review, not a silent mutate.
2. **Regression detection must be a paired comparison with a statistical gate, not a threshold on a single aggregate score.** Same items, candidate vs baseline (current production prompt+model, or last-known-good run). The gate must be able to say "we cannot tell" as a first-class outcome, not only pass/fail. Sample size must be justified against a minimum detectable effect, not chosen because 50 felt like a round number.
3. **Judge reliability is a measured property, not an architectural assumption.** LLM-as-judge is allowed only after (and continuously with) agreement measurement against a human-labeled subset. Position bias, verbosity bias, and self-preference must have mitigations (rubric decomposition, order randomization / pairwise, length-normalized scoring where relevant). Safety-flagged items require human review; they are not delegated to the judge as the sole authority.
4. **Silent drift under an unchanged API name must be detectable without a vendor version signal.** A frozen canary probe set is replayed against the *live production endpoint* on a schedule. Drift is declared from a distributional shift in rubric scores **and** from behavioral fingerprints (latency, token counts, output-length/format signature) that often move before scores do. This detection is probabilistic. The design must not pretend it is certain.
5. **Human-in-the-loop calibration is part of the runtime, not a Phase 0 workshop that never repeats.** A sampled slice of eval outputs (and a mandatory slice of safety items) is labeled by humans on a cadence. Judge/human disagreement is a metric that can block trust in the gate, the same way a flaky test suite can block trust in CI.
6. **Safety / policy-violation coverage is a first-class stratum, not a bonus tag.** A quality improvement that buys higher helpfulness by loosening refund policy or leaking customer data is a failed eval, even if the mean rubric score went up.

## Success Criteria for the Design (Not Implementation Metrics)

1. A candidate prompt+model cannot ship without a named eval run against a frozen golden-set version, producing per-item and per-stratum results, not only a headline score.
2. A statistically significant regression on a safety stratum, or on an agreed overall quality dimension, blocks the ship. A non-significant change is reported as "inconclusive," not rounded into a pass.
3. Judge/human agreement on the calibration subset is measured and above a documented floor before the LLM judge is allowed to be the primary CI signal. Dropping below that floor pages the eval owner, it does not silently continue.
4. After a simulated silent model swap (candidate responses drawn from a different model while the API name field is held constant), the canary path produces a drift alert within a bounded number of scheduled runs — or the design documents the residual blind spot and the sample size at which that swap is *not* detectable.
5. Refreshing the golden set produces a new version; historical eval runs remain comparable against the version they were run on. There is no "the set changed under us" rewrite of past gates.

## Business Rules (Eval-Scoped)

1. The CI gate compares against a declared baseline run (production or last-known-good), not against an absolute "80% good" magic number invented in a meeting. Absolute thresholds rot; paired deltas are the regression signal.
2. Golden-set items derived from real tickets are anonymized before they enter the set. PII in a golden set is a data incident, not a realism feature.
3. Canary probes hitting production must be marked as synthetic / eval traffic so they do not create real tickets, real refunds, or real CSAT. If the bot's tools can mutate CRM/order state, the canary runs in a mode that cannot.
4. A drift alert does not auto-rollback the prompt by default in Phase 3. It pages a human with the evidence pack (shifted strata, fingerprint deltas, example transcripts). Auto-block of *new* ships is Phase 4; auto-rollback of production is a product decision with a kill switch, not a default.
5. Vendor changelog entries and `system_fingerprint` / equivalent headers are *inputs* to the drift detector when they exist. They are never the *only* input. Absence of a changelog is the normal case this architecture exists to survive.

## Non-Goals

- **Not a general LLM benchmark suite.** No MMLU, no public leaderboard, no "we also eval code and summarization." This harness is for one support bot's prompt+tooling+model bundle. A second bot is a second golden set and a second canary, not a platform designed up front.
- **Not fine-tuning, RLHF, or prompt-optimization infrastructure.** The harness *measures*. It does not search prompt space. Auto-tuning the prompt against the golden set is how you overfit and launder it as improvement.
- **Not a replacement for human QA or support QA sampling of live tickets.** Live-ticket review remains. The harness is the pre-ship gate and the silent-swap detector; it is not the whole quality program.
- **Not an implementation.** No pytest, no eval SDK, no Grafana JSON. Numbered steps and diagrams only.
- **Not a claim that this is cheap or that it closes the problem completely.** Silent same-name swaps are a statistical detection problem. Small, gradual drifts can hide inside noise. A golden set that does not contain the failure mode that will actually happen in production will not catch it. See [Architecture Document — Brutal Honesty](./02_architecture_document.md#brutal-honesty).
- **Not required for every prompt tweak.** A typo fix in a system prompt that cannot change tool-calling or policy is not worth a full paired run. The gate's *existence* is required for ships that change model, tools, or policy-bearing prompt text. Applying the full machine to a comma is architecture theater.
