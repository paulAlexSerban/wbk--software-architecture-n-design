# LLM Answer Consistency: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a system that gives **consistent answers from a non-deterministic LLM**, under two product constraints that look mutually exclusive:

1. **Do not set temperature to 0.** Product wants some creativity. Sampling stays on.
2. **Do not cache answers.** Answers must reflect live data. The same question asked an hour later, against a changed world, must not return yesterday's completion.

The design must answer, concretely:

1. What "consistent" is allowed to mean, once byte-identical text is off the table.
2. How live data is fetched so that N parallel samples of the *same* request are voting over the same facts — without that becoming a cross-request cache.
3. How an answer that is allowed to *sound* different still produces the same downstream decision (the same label, the same number, the same action).
4. What happens when the samples disagree, and why silently picking sample #1 is not an architecture.
5. What is measured in production so "we are consistent" is a rate, not a slogan.

This is the consistency-under-contradiction trap. The naive answers — set temperature to 0 anyway, cache the completion, or claim the model is "pretty consistent at T=0.3" — are the failure. They either violate a stated constraint or they pretend a sampling distribution is a function. **A non-deterministic generator cannot emit byte-identical text on demand.** Temperature > 0 is a sampling distribution. "No cache" means every request pays a fresh generation against a fresh world. Asking that combination for literal reproducibility is asking for a contradiction.

The correct shape is: **consistency is enforced on a small, structured decision layer; creativity is left on the expression layer; live data is snapshotted once per request and shared across the ensemble of that request only; agreement is measured and bounded, never promised at 100%.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true without quietly setting T=0 or quietly caching the answer.

## The Trap, Stated Directly

"Consistent" in a product conversation is almost always used as if it meant **the same words, every time**. That is determinism. Determinism, for current decoder LLMs, is approximated by temperature 0 (and even then, not always — batched inference, floating-point non-associativity, and provider-side load can still diverge). Product has forbidden that approximation. Caching would give you the same words for free, and has been forbidden because the words would be about a stale world.

Those are independent systems of meaning:

| What people hear | What the constraint actually protects |
| --- | --- |
| "Consistent" | Usually: the *decision* the user or a downstream system will act on. Rarely: the exact wording. Almost never: a cryptographic hash of the completion. |
| "Temperature > 0 / some creativity" | The *expression* is allowed to vary. Tone, order of sentences, optional elaboration. Not: the approved/denied bit, the quoted price, the recommended SKU. |
| "No caching / live data" | Facts in the answer must come from a fetch that is current *as of this request*. Not: "never reuse a byte inside one request." Sharing one snapshot across N parallel samples of the same request is not an answer cache. |
| "The model will just agree with itself" | A hope. Self-consistency reduces *variance-driven* disagreement. It does not reduce *bias-driven* wrongness. N copies of a systematically wrong model vote the wrong answer with high confidence. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have under these constraints |
| --- | --- |
| Byte-identical completions | No. Forbidden by T>0 and by no-cache. Claim this and you are lying or you have violated a constraint. |
| The same decision given the same live snapshot | Yes, as a **measured probability**, via structured output + majority vote + a deterministic validator. Not as a guarantee. |
| Creative wording | Yes, on the expression layer, after the decision is locked. |
| Fresh facts every request | Yes. Live data is fetched per request, snapshotted, and injected. Cross-request answer cache is off. |
| Correctness | Not this system's product. Voting agrees on a wrong answer as easily as a right one. Correctness is evals, grounding, and product policy. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md). |

Capitulating to temperature 0 is how you pass the interview by cheating the product constraint. Capitulating to a cache is how you pass it by cheating the live-data constraint. Treating "consistent" as "the paragraphs look similar to a human" is how you ship a demo that fails the first time two users get different refund amounts for the same order.

## Current State (Assumed Starting Point)

A typical first version of "just call the model" looks like:

1. Request arrives. The handler fetches live data (CRM, inventory, prices, policy docs) inline, or worse, lets the model tool-call those sources itself during generation.
2. One completion is requested at T=0.7 with a prose prompt: "Answer the customer, be accurate and consistent."
3. The completion is a paragraph. A refund amount is buried in sentence three. A status label is implied, not stated.
4. The next identical request, a second later, fetches live data again (maybe different), samples again, and produces a different paragraph with a different number.
5. Someone files a ticket. Engineering sets T=0 "just for this route." Product notices the answers got stiff. Someone else adds a 5-minute response cache. Support notices the answers are about inventory that sold out four minutes ago.

That version will appear to work in a demo: one question, one fluent answer, live data in the prompt. It will fail in production the first time:

- two agents looking at the same customer get different recommended next actions,
- a quoted price in the prose does not match the price the checkout API will charge,
- a retry (client timeout, user double-click) produces a different decision than the first attempt,
- the model is "consistent" in tone and inconsistent in the one field that hits the ledger,
- finance asks why the bot approved a refund the policy would have denied, and the logs show three samples would have denied it and the one you returned approved it.

This project documents the replacement, not a patch of that single `chat.completions` call.

## Concrete Route Used Throughout These Docs

One product-shaped example, so the sequences are not abstract. The architecture is the same if the decision is "triage label + severity" or "recommended SKU + max discount"; only the schema changes.

**Route: `support.refund_guidance`.** A support agent (or the customer, via a bot) asks whether this order is eligible for a refund, how much, and what to tell the customer.

Live data fetched per request (illustrative):

- order record (status, amount, age, items),
- customer refund history,
- current refund policy version,
- current inventory / restocking flags if restocking affects eligibility.

Decision layer (must be stable given the same snapshot):

| Field | Type | Why it must not wander |
| --- | --- | --- |
| `eligible` | boolean | Downstream may auto-issue or block. |
| `refund_amount_minor` | integer | Money. Two different amounts is an incident. |
| `reason_code` | enum | Reporting, policy, audit. |
| `requires_human` | boolean | Routing. |
| `policy_version` | string | Provenance; copied from the snapshot, not invented. |

Expression layer (allowed to vary):

- the paragraph the agent reads to the customer,
- optional extra explanation, empathy, reordering of facts that are already in the decision.

Temperature stays at a product-chosen T>0 (working default in these docs: **0.7** — a real sampling temperature, not "0.1 which is 0 with extra steps"). N parallel samples of the same request see the **same** snapshot. They do not each refetch.

A genuinely open-ended ask ("write a launch poem for this SKU") is **out of this route**. It has no decision substructure to vote on. Forcing an ensemble on it is theatre. See Non-Goals and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## Target Users

- **Owning engineer**: implements the ensemble and the schema; needs a definition of "consistent" they can defend when two answers used different words but the same `refund_amount_minor`.
- **On-call / support**: needs to answer "why did we say $40 this time and $40 with different wording last time, and why did we escalate instead of answering when the model disagreed with itself."
- **Product**: wants creativity in the customer-facing paragraph and stability in the action. Must accept a numeric agreement-rate SLO instead of "always the same."
- **Finance / policy**: needs the refund amount and reason code to be attributable to a snapshot and a vote, not to whichever sample arrived first.
- **The end user / agent**: needs an answer that matches live data, does not contradict itself across a retry, and is allowed to read like a human wrote it.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which model, the refund policy text, the CRM schema) are out of scope.

1. **Consistency is defined on the decision layer, not the byte string.** A response is "consistent" when, given the same live-data snapshot and the same question, the structured decision fields agree across an ensemble at a measured rate, and the downstream action is a deterministic function of those fields. Prose may differ. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **The decision layer is schema-constrained.** The model must emit a typed object (JSON schema / constrained decoding / tool call) that can be voted field-by-field. Diffing two paragraphs is not an aggregation strategy. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Sampling stays at T>0. Stability comes from the ensemble, not from cooling the sampler.** N independent generations at the product temperature, same prompt, same snapshot. Not T=0. Not T=0.1 wearing a costume. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. **Live data is snapshotted once per request and shared across that request's N samples.** Cross-request answer caching is forbidden. Per-sample refetch is forbidden — it would make the ensemble vote across different worlds. Intra-request snapshot reuse is not an answer cache. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **A deterministic post-processor runs after the vote, before anything downstream consumes the decision.** Clamping, enum membership, business-rule checks, schema re-validation. The vote can still be illegal; the validator is the last gate. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **N is bounded. Failed quorum is a first-class outcome.** A tie, a split, or agreement below a configured threshold does **not** silently pick sample #1. It takes the low-confidence / escalate path. Unbounded "keep sampling until they agree" is forbidden. See [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **Agreement is a production metric, not a lab anecdote.** Per-field agreement rate, quorum-failure rate, and N-multiplier cost are monitored per route. Drift is an alert, not a retrospective. See [ADR-007](./04_architecture_decision_records.md#adr-007).

## Success Criteria for the Design (Not Implementation Metrics)

1. Same question, same live-data snapshot, two independent ensemble runs: decision fields match at a **measured** rate meeting the route SLO (working target for `support.refund_guidance`: ≥ 90% exact match on `{eligible, refund_amount_minor, reason_code, requires_human}`). The SLO is a number product signs. It is not 100%.
2. Same question, same snapshot: the customer-facing paragraph is **allowed to differ** in wording. Tests that fail because two phrasings are not string-equal are wrong tests.
3. Same question, **different** live-data snapshot (order status changed, policy version bumped): the decision is allowed — expected — to change. A test that requires stability across world-changes is a cache test in disguise and must fail.
4. One of N samples fails to parse: the vote proceeds on the remaining valid samples if a quorum is still possible; it does not crash the request; it does not fill missing fields from sample #1's prose.
5. All valid samples disagree on a decision field (no plurality at or above threshold): the response is `low_confidence` / `requires_human`, not a coin flip. The client is told that, not given a fluent wrong answer.
6. The validator rejects the voted decision (e.g. refund amount > order amount): the decision is not shipped. Escalate / fail closed. Do not "correct" it by picking a different sample in an unspecified way.
7. Cost per successful request is approximately **N × (decision-sample tokens) + 1 × (optional expression call) + 1 × (live-data fetch)**. That multiplier is visible on a dashboard. Hiding it in "LLM spend" is a failed design.
8. No temperature=0 path and no cross-request answer cache exist on this route "as a fallback." If those are the actual requirements, this project is the wrong project. See kill criteria in the [Phased Implementation Plan](./06_phased_implementation_plan.md).

## Business Rules (Consistency-Scoped)

1. Temperature for this route is a product parameter greater than 0. Engineering changing it to 0 to "fix consistency" is a constraint violation, not a hotfix. If product later wants T=0, that is a new ADR and this ensemble should be turned **off**, not stacked on top of a deterministic sampler (paying N× for samples that barely differ).
2. The live-data snapshot is the system of record for facts in the decision. The model may not invent `policy_version`, order amount, or inventory flags; those fields are copied from the snapshot or checked against it by the validator.
3. Intra-request reuse of the snapshot across N samples is required. Storing that snapshot as a **response cache key for later requests** is forbidden on this route.
4. Expression-layer text is not an input to downstream money / routing systems. If a number appears in the paragraph, it is rendered **from** the locked decision, not parsed back out of the prose.
5. Quorum failure is a product outcome (`requires_human: true`, or equivalent), not an infrastructure retry storm.
6. N, the agreement threshold, and the SLO are route parameters. They are not global. A classification route and a refund route will not share a sensible N.

## Non-Goals

- **Not byte-identical completions.** Forbidden by the prompt. Tests and SLOs that require it are out of scope on purpose.
- **Not a cross-request cache, semantic or exact.** The constraint is live data. Exact-match caching of the completion would satisfy "consistent" by violating "live." If a later product wants a short TTL cache **of the snapshot** (not the answer) that is a different design and a different ADR; it is not v1.
- **Not a guarantee of 100% decision identity.** Sampling residual, provider non-determinism, and genuine ambiguity in the question remain. The architecture bounds and surfaces disagreement; it does not abolish it.
- **Not a correctness system.** Self-consistency is a variance reducer. It is not a fact checker, not a hallucination detector, and not a policy engine (the validator is a policy engine for *form*, not for *truth*). See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not a solution for open-ended creative work.** Poems, brand copy, brainstorming lists have no stable decision substructure. "Consistency" there is constraint satisfaction (length, banned phrases, brand voice rules) enforced by a validator on a **single** sample — or it is "we don't mean consistent." Do not run an N-way vote on which metaphor is best. There is no majority of metaphors.
- **Not an implementation.** No Python ensemble runner, no JSON-schema library, no provider client. Numbered steps and diagrams only.
- **Not a claim that this is cheap.** The honest alternative — one sample, T=0.7, hope — is cheaper and will survive a demo. This design is justified when a **decision** is extracted from the answer and inconsistency of that decision is expensive (money, routing, legal, user trust). It is overkill for a chatbot that only chats. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
