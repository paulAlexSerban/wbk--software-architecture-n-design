# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes an OpenAI adapter.

The constraints, once: **a prompt version is a composite of bytes**, **providers are not interchangeable**, **exact-match and a judge are not one number**, **the matrix will explode**, and **"backbone for every later project" is a bet, not a user.**

## 1. What I would build

A **narrow experiment runner with a ledger**, not an eval platform.

- **Content-addressable variants** (template × technique × exemplars × schema × system prompt × decoding). Aliases are pointers. Models are run dimensions.
- **Two adapters** (OpenAI, Anthropic) with leakage fields. Fixtures for usage parse, 429, safety 4xx, malformed JSON. A third adapter only when a task needs it.
- **One or two pilot tasks** with a real labeled set sized for an MDE you write down. Prefer a closed task so exact-match is valid, plus one slightly open task if you need the judge path — not ten tasks to look like a suite.
- **Exact-match family first.** LLM-judge second, with a human calibration slice or an explicit `uncalibrated` label that **cannot** be the only merge gate.
- **Postgres run log** (JSONL only long enough to prove hashing). Pricing snapshots pinned on runs.
- **GitHub Actions**: manifest-mapped smoke on PR, full matrix nightly/release. Fail-closed on harness errors and unmapped paths. Artifact is a table, not a badge.
- **Seams** for Task / Scorer / Adapter so a later project *can* plug in. No plugin marketplace, no RAGAS charts, no auto-prompt search.

I would not build a playground UI, a multi-tenant SaaS, a vector DB, an agent trace debugger, or "seamless provider abstraction."

If Phase 0 shows there is **one** prompt, **one** provider, and a human still reads every output, I would **not** build this. I would version the prompt in git, pin a pytest that calls one SDK, and log JSONL. Architecture for a problem that is a missing test is how you get a platform team.

## 2. What I would give up

Be explicit. These are not "later" disguised as v1.

**A clean provider-agnostic interface.** It does not exist. We give up the slide that says "swap OpenAI for Anthropic, scores mean the same thing." We keep leakage fields and separate runs. See [ADR-003](./04_architecture_decision_records.md#adr-003).

**The full combinatorial matrix on every PR.** We give up "every technique × every model on every commit." We keep smoke + scheduled full. Residual: nightly ignored. See [ADR-002](./04_architecture_decision_records.md#adr-002).

**A single quality score.** We give up the dashboard everyone wants. We keep per-family pass/fail/inconclusive.

**RAGAS in v1.** We give up the sentence "eval backbone including RAGAS." We keep optional context fields and a scorer that refuses. See [ADR-005](./04_architecture_decision_records.md#adr-005).

**Calibrated judges without humans.** If nobody labels, the judge is untrusted. We give up "LLM-as-judge is the gate" in that world — exact-match and schema-valid only, or stop calling it gated.

**Prompt optimization / DSPy loops.** Measuring is the product. Search against the eval set is overfitting with extra steps.

**Sub-minute PR gates on a wide matrix.** Adapter + N items × models is minutes. Anyone who needs 30-second CI should not put generation in that check — or should accept a tiny smoke and a large residual blind spot, in writing.

**A standing eval service and a pretty UI.** Jobs + artifacts. See [ADR-006](./04_architecture_decision_records.md#adr-006).

**Certainty that later projects will plug in.** We give up "platform success" as a Phase 1 metric. We keep a kill criterion: if after two consumer-shaped opportunities nobody integrates, collapse the SPI ([§6](#6-brutal-summary), [Phased Plan — Kill Criteria](./06_phased_implementation_plan.md#kill-criteria-for-the-harness-program)).

**Exact cost.** We estimate from `usage` × a snapshot. Cache tokens, rounding, and missing usage remain. `cost_status=unknown` is allowed; a fake cent is not.

## 3. What I would ask for, even though I expect a no

Ask **once, in writing, in Phase 0**. A no does not block the lab. A yes is a gift.

Ask the model vendors (or whoever pays the bill):

1. **A CI spend cap / separate project key** so a looping job cannot print money until Monday. Expected: org cap with delay, or nothing.
2. **Stable usage fields** including cache and reasoning tokens, documented. Expected: the schema will change twice this year; adapters will break; fixtures must be replayable.
3. **Deterministic decoding that is actually deterministic.** Expected: no. Then pin temperature 0, seed if any, and accept residual flap — or n-sample and pay.

Ask the downstream teams who are supposed to plug in:

4. **One real Task in the next quarter**, not a letter of intent. Expected: stall. Without a date, the backbone is a hobby.
5. **Ownership of their dataset** (labels, PII rules). Expected: "use the lab's 20 examples." Then their gate is not about their product.

Ask whoever owns CI:

6. **Actions minutes and a Postgres** (even a small managed instance). Expected: "use a spreadsheet." Then Phase 2 is blocked; stay on JSONL and admit history will hurt.

Ask FinOps:

7. **Whether eval spend is a budgeted line** or stolen from the product key. If stolen, the first shocking bill will kill the nightly matrix — which kills the only wide signal.

What I would **not** ask for: that vendors make providers comparable; that RAGAS work without retrieval; that a 12-item smoke detect a 2-point regression.

## 4. Build vs buy

This is a live question, not an appendix. Building is justified when **identity, leakage honesty, and CI-as-gate on our git** matter more than **UI and adapter churn**. Buying is justified when **headcount is the scarce resource** and a vendor already is the run log.

Illustrative options (names will rot; the *categories* will not):

| Path | You get | You give up | When it wins |
| --- | --- | --- | --- |
| **Do nothing + git + one pytest + JSONL** | Cheap, honest for one prompt | No matrix, no cross-provider ledger, no scoper | One task, one provider, human still reads outputs |
| **Open-source runner (promptfoo-class, eval harnesses, pytest plugins)** | YAML matrices, some providers, some CI examples | Their variant identity may be filenames; leakage fields may be missing; you still own Postgres/CI if you want a ledger; easy to run a matrix that you cannot statistically defend | Want speed; will wrap *their* runner with *our* hashing and gate math |
| **Hosted eval (LangSmith, Braintrust, etc.)** | UI, tracing, someone else's adapters, collaboration | Prompts in another vendor; CI gate is their API; cost; harder to pin composite hashes *our* way; lock-in | Multiple prompt authors, need UI, legal accepts another processor |
| **Build this design** | Composite identity, leakage fields, per-family stats, git-native scoper, killable SPI | We own adapters, Actions, Postgres, and every vendor API change | Recurring multi-model decisions; more than one future consumer with a date; we will not skip Phase 0 |

**Brutal rule of thumb:** if nobody will look at a PR artifact table, **do not build**. Buy a UI or do nothing. A harness whose gate is muted is worse than a notebook (false confidence).

If we buy, we still need: content identity (even if implemented as vendor metadata), no blended score as the only gate, RAGAS not fake, smoke vs full policy. If the vendor cannot do those, we are buying screenshots.

LiteLLM-class **proxy** layers are not eval harnesses. Do not confuse "we can call 100 models" with "we can gate a prompt PR."

## 5. Complexity vs the interview prompt

The prompt lists zero-shot through structured-output, multiple providers, logging, scoring, CI. A demo can fake all of that in a notebook with five loops. Production (even "lab production") fails on:

- **what a version is** when five axes move independently,
- **combinatorial cost and CI time**,
- **adapter leakage** (especially structured output and usage),
- **unlike scorers**,
- **scoper gaming**,
- **platform YAGNI**.

Under-building (one script, `v3`, exact-match on prose, optional CI) **fails the actual tests**: versioning, provider-agnostic *honesty*, evals as a merge gate.

Over-building (eval SaaS, plugin SPI, RAGAS, agent traces, auto-tuning) fails the operator. One engineer and two models do not need that.

The honest middle is this document set: **fussy identity, leaky adapters, two scorer families, scoped CI, deferred RAGAS, explicit kill.**

## 6. Brutal summary

The clever design is not a YAML file with every prompting trick. The clever design is **refusing to call a filename a version**, **refusing to pretend providers are replicas**, **refusing to average exact-match with a judge**, **refusing to run the universe on every PR**, and **refusing to keep a platform SPI when nobody plugged in**.

Ship a runner that logs hashes and can fail a PR on a smoke matrix you could explain to a skeptic. Add the second provider to prove the adapter story. Add a judge only with an agreement plan. Leave RAGAS off until a retriever exists. If the second team never comes, delete the seams and keep the job — that is a successful collapse, not a failed platform, as long as you do it on purpose.

If the team will not fail-closed when Actions is red, none of the rest matters. A merge gate that is optional is a notebook with extra steps.
