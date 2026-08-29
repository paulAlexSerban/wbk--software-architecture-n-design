# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone pays for N samples.

The expected clever answer is: **structured output + majority voting + deterministic post-processing**. Those words are correct. They are not free, they do not produce determinism, and they do not produce correctness. Passing the interview by quietly setting temperature to 0, or quietly caching, is capitulation. This page is the cost of not capitulating.

## 1. What I would build

A **request-scoped ensemble** over a **small typed decision**, with live data frozen once.

- **Snapshot fetcher**: one live fetch per request; no live tools on the samples. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Schema-constrained samples** at the product T>0, N of them in parallel. [ADR-002](./04_architecture_decision_records.md#adr-002), [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Per-field vote** with a harsh money default (dissent on amount → human). [System Design](./03_system_design.md).
- **Deterministic validator** against the snapshot. Reject, don't clamp. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Expression** from an agreeing sample, or one short re-phrase call locked to the decision. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Failed quorum as a product outcome**, not a coin flip. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Agreement and cost as production metrics.** [ADR-007](./04_architecture_decision_records.md#adr-007).

I would not set T=0. I would not cache the completion. I would not call a second model to "judge." I would not run this on a poem.

If Phase 0 shows there are **no gated decision fields** — the product only wanted nicer paragraphs — this whole system is overkill. Ship one sample at T>0, maybe a style validator, stop. The clever answer is for when a **decision** in the answer hits a ledger, a router, or a user who will quote you in a dispute.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Literal reproducibility.** Same question, same snapshot, two runs: the **paragraphs may differ**. The **decisions** should match at a measured rate, not 100%. Anyone who needs byte-identical output has already asked for T=0 or a cache. Give them that project instead.

**Single-call cost and single-call tail latency.** Cost is ~N× input (snapshot repeated) plus N× decision output, plus maybe one expression call. Latency p95 is the slowest of N. There is no encoding trick that makes five real draws cost like one.

**The comfort of "the same question always returns the same words."** Support macros, screenshot comparisons, and naive tests will break. The contract is the decision object. If QA keeps screenshot-diffing the paragraph, they will force T=0 through the back door.

**A guarantee of correctness.** Voting estimates the **mode** of the model's distribution. If the mode is wrong — bad prompt, bad snapshot, policy the model never learned — you get a **confident wrong agreement**. Self-consistency reduces variance-driven inconsistency. It does not reduce bias-driven wrongness. Selling this as a fact-checker is a different lie than selling T=0.

**Cheap repeats.** No answer cache means every request pays fetch + ensemble, including the user who asked the same thing 10 seconds ago against an unchanged order. That is what "live data, no cache" costs. If that bill hurts, they did not want live data; they wanted a TTL.

**Zero-ambiguity UX.** Failed quorum is an escalation, not a fluent guess. The lying bot that always answers will look better in a demo and worse in a dispute. Product must staff the human path or accept single-sample roulette.

**Running this as a platform default.** Wrapping every prompt in N=5 because "consistency" is how you 5× the company LLM bill for chat that nobody votes on. Per route, high-stakes only.

**Open-ended creative work as a vote.** There is no majority of metaphors. Constraint validators (length, banned phrases) on **one** sample are the honest tool there.

**Prefix-cache superstition as architecture.** Using the vendor's prompt-prefix discount is fine. Building an application cache because "the vendor does something cache-shaped" is how the constraint dies in a sprint.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence is not "they meant decision-level."

Ask product:

1. **What bits of the answer, if they changed between two phrasings, would be an incident?** Those are the gated fields. If the list is empty, stop this project. If the list is "the whole email," they want T=0 or a cache — make them pick. Expected: they say "consistent" and mean both the amount *and* the vibe. Write the amount into the schema; write the vibe out.
2. **Will you sign an agreement-rate SLO that is not 100%?** Working target 90% on the gated tuple is a starting number, not magic. If they require 100%, this design cannot help. Expected: "why wouldn't it always agree?" Answer: because you forbade T=0 and forbade cache.
3. **On money dissent, human or median?** Default in this design is human. Median is cheaper in support load and wrong more quietly. They must pick.
4. **Is "eligible, but we need a human because the model disagreed with itself" shippable UX?** If no, they are asking to hide disagreement, which is sample #1 with extra steps.

Ask finance / policy:

5. **Must a refund amount be attributable to a snapshot + vote, not to a paragraph?** If yes, audit records are on the critical path. If no, you will still want them after the first dispute.

Ask engineering / platform:

6. **Does the provider actually constrain JSON at T>0 at acceptable parse rates?** If Phase 0 says no, do not compensate with N=15.
7. **What is the RPM/TPM budget after multiplying by N?** A route that was "fine" at 1× will 429 at 5×.
8. **Confirm that "no cache" includes not adding a CDN/edge cache of the HTTP response**, which is the same constraint with a different logo.

What I would **not** ask for: a new model trained for consistency, a multi-agent debate, a vector database for v1, Kubernetes for the voter. Those asks spend calendar that belongs to the schema fight and the SLO.

## 4. Complexity inventory (what those clever words cost)

| You take on | You shed |
| --- | --- |
| Schema design + product fight over gated fields | The fantasy that "be consistent" is a prompt |
| N parallel provider calls, timeouts, N_valid | Single-sample simplicity |
| ~N× token bill, snapshot tokens × N | T=0 as a free stability hack |
| Aggregator + quorum + escalation UX | Silent sample #1 |
| Deterministic rule table + versioning | "The model knows the policy" |
| Production agreement/cost metrics | A notebook that agreed 19/20 times |
| Audit snapshot + votes for money routes | Regexing $ amounts out of emails |
| Explaining why two paragraphs differ | Byte-identical answers (you cannot have them anyway) |
| Human path when the model has no mode | Fluent guesses on ambiguous cases |

Net: **more parts, in the right places.** The naive design is simple *and does not satisfy the constraints.* The clever design satisfies a **bounded reading** of the constraints and still cannot give 100% identity or correctness. The interview is whether you name that bound instead of hiding it.

### What is not worth building

- A second LLM judge of the N samples.
- Multi-agent devil's-advocate as v1. Cost and theatre.
- Embedding-cluster voting for fields that should have been enums.
- Application-level answer cache "just for identical questions in a 30s window" unless product explicitly reopens ADR-004.
- T=0 "fallback when N disagrees" — that is two architectures glued together so neither is honest.
- Company-wide consistency middleware.

## 5. When I would not do this

- **No decision substructure.** Brand copy, poems, brainstorming, "chat with the docs" where the user is not about to act on a number. One sample, optional style checks.
- **The SLO must be 100% identical decisions *and* identical prose.** They want T=0 and/or a cache. Do not build an ensemble to launder that requirement.
- **Cost per request at the minimum N that hits a tolerable agreement rate is unacceptable.** Then the route cannot afford consistency under these constraints. Options: fewer gated fields, a cheaper model that still emits schema (quality risk), T=0 (constraint drop), cache (constraint drop), or **don't automate the decision**.
- **Parse rates at T>0 are garbage** and will not improve. Different model, or stop.
- **QPS is a firehose** (batch enrichment of millions). N× will dominate. That is a different design (maybe T=0 is acceptable there; maybe the "creativity" constraint was only for user-facing copy).

When I **would** do this: a user-facing or agent-facing route where (a) T>0 is a real product ask, (b) live data matters, (c) a small decision in the answer is expensive when it wanders, (d) product will sign a non-100% SLO and a human path. Then structured output + vote + validator is the design, and this document is the bill.

## 6. Pushing back on the constraints (the actual interview)

The prompt is constructed so you either **push back**, find a **middle**, or **capitulate**. This project is the middle, with the pushback stated:

1. **"Consistent" is ambiguous.** We will not promise identical text. We will promise measured agreement on named fields.
2. **"No caching" forbids serving yesterday's answer, not sharing today's snapshot across today's N samples.** Intra-request snapshot reuse is required for the vote to be about the model rather than about a race. If they later call that a cache, they are playing word games; write it down now.
3. **Temperature 0 is not a little bit on the table.** If they need it, they should drop the ensemble and the creativity ask together.
4. **N× cost is not optional cleverness.** It is the price of estimating a mode while still sampling. If they will not pay, they must drop a constraint or drop the automation.

Capitulation looks like: `temperature=0` in the PR, or `Cache-Control` on the response, or a comment that says `N=1  # cheaper, still pretty consistent`. Call those by name in review.

## 7. Brutal summary

You cannot have byte-identical, creative, always-fresh completions. Physics and the prompt both say so.

What you can have is: **a small decision that usually agrees with itself, measured, validated against live facts fetched for this request, with wording that is allowed to move, at about N times the cost, with a human when the model does not have a mode.**

That is structured output + majority vote + deterministic post-processing. It is the right clever answer. It does not make the sampler a function. It does not make the model honest. It does not make the bill smaller.

If the decision does not exist, do not vote. If 100% is mandatory, do not vote — set T=0 or cache, and admit which constraint you killed. If N× is unaffordable at the N that actually agrees, you do not have a consistency architecture; you have a constraint set that does not fit the budget. Say that before you ship a five-call fan-out that still escalates 30% of the time.
