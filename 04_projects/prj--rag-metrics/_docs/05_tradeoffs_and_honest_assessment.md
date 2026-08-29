# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone pays for RAGAS on every PR or installs a dashboard titled "AI Quality."

The expected clever answer is: **RAGAS + tracing + CI + one backbone**. Those words are correct as a *stack sketch*. They are not a gate, they are not ground truth, and they are not free. Passing the interview by treating a faithfulness mean as a unit test, or by running the judge on production and calling it observability, is capitulation. This page is the cost of not capitulating.

## 1. What I would build

A **tiered evidence platform** that extends [`prompt-lab`](../../prj--prompt-lab/README.md), wrapping RAG pipelines without owning retrieval.

- **Hard-gate CI**: deterministic contracts that may block merge. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Soft RAGAS-family scorers** as plugins, with **human calibration** and a trust bit. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Paired, power-aware regression reports** with `cannot_tell`. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Production tracing** as a sibling pipeline, same identity fields, no judge on the hot path. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Per-stage metrics**, no blended quality KPI as the system of record. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Versioned eval sets** with a Goodhart guard and a second-consumer test of the backbone. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Cost caps**: judges async; incomplete suites do not publish partial means. [ADR-007](./04_architecture_decision_records.md#adr-007).

I would not auto-fail merge on `mean(faithfulness)`. I would not run RAGAS on 100% of production. I would not call faithfulness "accuracy." I would not build this for a 15-document demo corpus whose only user is the author.

If Phase 0 shows **nobody will label**, **the eval set is 20 author questions**, or **the org already has LangSmith/promptfoo covering the same loop and will not switch**, this whole system is overkill or the wrong buy-vs-build outcome. Ship hard-gate pytest + basic traces, stop. The clever answer is for when **multiple RAG pipelines will change** and a silent quality drop is expensive (users, policy, support load) — and someone will staff labels.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**A correctness oracle.** Faithfulness is groundedness in *retrieved text*. Context recall is coverage of *someone's labels*. Neither is "the answer is true." Selling this as accuracy is a different lie than skipping eval entirely.

**A 100%-reliable auto-block on "quality."** v1 will let a soft regression merge. That is the price of a CI check people still run. If product requires that no worse answer ever ships, they need a different process (human review of all changes, or T=0 + tiny corpus + frozen prompt — not this platform).

**Cheap eval.** Judge tokens scale with items × metrics × PRs. Human labels do not scale with a credit card. Tracing storage is the only cheap part, and only if you redact and TTL.

**An unbiased eval set.** The gate set will be gamed, slightly, no matter how many ADRs you write. Holdout and refresh slow that down. They do not repeal Goodhart.

**"One backbone" as a single running service.** Shared schema + runner + store with `prompt-lab`. Two execution paths (CI vs traces). If the hiring-panel story needs one box, draw the schema, not a lie about RAGAS-in-prod.

**Coverage of production.** Offline eval is a biased sample. Production traces lack labels. The union is still not "we measured quality." It is "we measured contracts, a labeled slice, and operational health."

**Same RAGAS scores across judge models.** Changing the judge is a new instrument. Historical means are not a continuous time series across that cut.

**Prompt optimization as a feature.** A gate that also searches prompts will overfit the gate set faster. Out of scope on purpose.

**Library independence as a selling point.** "We use RAGAS" is a scorer plugin. The architecture is the gates, the pairing, the calibration, and the traces. If RAGAS the library bit-rots, the design should survive with equivalent judge prompts.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence is not "they meant auto-block on RAGAS."

Ask product / pipeline owners:

1. **Which failures, if they shipped, would be an incident?** Those are hard-gate candidates (missing citations, answering from empty context, PII). If the list is "the answers should be better," they have not named a gate.
2. **Will you sign that LLM-judged metrics will not block merge until an evidence bar?** If they require blocking now, they will skip CI after the first flake. Make them pick: trusted hard gates, or a flaky required check.
3. **Who labels, on what cadence, with what SLA?** If the answer is "the intern will do 20 items at launch," calibration dies in month two. Name a role.
4. **Is "cannot tell" an acceptable CI annotation?** If no, they want a boolean more than they want science. Do not invent one.

Ask finance / platform:

5. **What is the monthly eval token budget?** Full RAGAS on a 200-item set on every PR may already exceed it. Smoke/full split is not optional if the number is small.
6. **Confirm production traces may store redacted queries and chunk ids.** If legal says no queries at all, on-call debugging is chunk ids + user complaint only — design that, do not skip tracing.

Ask engineering:

7. **Is `prompt-lab` actually the store we will extend, or is this the first consumer that will fork?** If prompt-lab is vapor, either build the small store here *and drop the backbone claim*, or sequence prompt-lab first. Do not pretend a SPI exists.
8. **Build vs buy:** promptfoo, LangSmith, Braintrust, Phoenix, etc. already do pieces of this. The honest build reason is: adapters to *our* pipelines, our hard-gate policy, our identity tied to `prompt-lab`, data residency, and not sending eval items to a SaaS. If those do not matter, **buy**. Phase 0 includes a written buy-vs-build. A portfolio project may still *document* a build; a company should not duplicate LangSmith for sport.

What I would **not** ask for: a custom GPU judge, a real-time faithfulness interceptor on the user path, Kubernetes for pytest, a "quality GPT" that explains the dashboard. Those asks spend calendar that belongs to labeling and the first adapter.

## 4. Complexity inventory (what those clever words cost)

| You take on | You shed |
| --- | --- |
| Eval-set curation, strata, labels, refresh | The fantasy that 20 examples are a test suite |
| Judge calibration as a standing process | "RAGAS is ground truth" |
| Paired tests and `cannot_tell` UX | A single threshold from a blog |
| Two pipelines: CI runs + traces | One RAGAS-on-prod loop |
| Adapter contract + second consumer | Copy-paste scripts called a backbone |
| Token budgets and incomplete-run rules | Silent partial means |
| Redaction and retention on traces | Debugging from application logs only |
| Explaining faithfulness ≠ accuracy | One "quality score" slide |

Net: **more parts, in the right places.** The naive design is simple *and does not survive contact with a noisy judge or a production incident.* The clever design still cannot tell you the model is correct, and still cannot see most of production. The interview is whether you name that bound instead of hiding it behind a library name.

### What is not worth building

- A real-time LLM judge in the user request path "for observability."
- A blended quality index as the architecture.
- Auto-prompt optimization against the gate set.
- Multi-tenant eval SaaS.
- A second backbone that reimplements `prompt-lab` because RAG "feels different."
- Ensembling judges to avoid humans.
- Failing CI when the dashboard is down.

## 5. When I would not do this

- **Toy corpus, one author, no users.** Hard-gate a few pytest cases if you want hygiene. A platform is résumé-driven.
- **No one will label, ever.** Then you may have hard gates + traces + citation overlap. You do not have RAGAS-as-discipline. Do not staff a judge to admire itself.
- **The only "regression" that matters is exact string match on a FAQ.** Use exact-match in `prompt-lab`. RAGAS is overhead.
- **QPS is a firehose and legal forbids storing queries.** Tracing shrinks to counters. Offline eval still works if you have a set. The "observability" half of the brief is then mostly metrics, not request reconstruction. Say so.
- **A vendor already covers this and the org will use it.** Integrate; write ADRs about *policy* (what blocks merge), not a greenfield runner.
- **The brief is secretly "make the RAG better."** Eval does not raise recall. It tells you whether a change did. Budget belongs to retrieval/generation work (`retrieval-x`, `rag-selfheal`) if quality is currently bad and unmeasured *only* because nobody looked at 30 questions.

When I **would** do this: two or more RAG pipelines that will keep changing, a quality drop that costs real users or policy, a team willing to staff labels, and a signed split between hard blocks and soft signals. Then RAGAS + tracing + CI is the stack, and this document is the bill.

## 6. Pushing back on the brief (the actual interview)

The prompt is constructed so you either **wrap RAGAS around everything**, **build a dashboard and call it a day**, or **push back**. This project is the pushback, with a middle:

1. **RAGAS is not a test boolean.** We will use it as a calibrated instrument with pairing and power, or we will not claim regression detection.
2. **"One backbone" means `prompt-lab` identity and plugins, not one process scoring live traffic.** CI and tracing share a schema. They do not share a judge.
3. **"Fixed eval set" forbids silent mutation, not forever-frozen items.** Refresh is part of the architecture. Permanently fixed is how you overfit.
4. **Flag ≠ fail.** GitHub can display both. Only contracts fail the merge until evidence says otherwise.
5. **Build vs buy is in scope.** "We used RAGAS in GitHub Actions" is not an architecture if the org should have bought a tracing product.

Capitulation looks like: `continue-on-error: true` on the eval job, a Streamlit mean, RAGAS in the request path, or a comment that says `threshold = 0.70  # was flaky`. Call those by name in review.

## 7. Brutal summary

You cannot have a cheap, auto-blocking, unbiased, production-complete, correctness-proving eval of RAG. The brief's nouns (RAGAS, CI, dashboard, backbone) describe instruments. They do not repeal noise, Goodhart, or token bills.

What you can have is: **merge-blocking contracts, a labeled slice scored by a calibrated judge and compared as a paired test with permission to say "cannot tell," operational traces that make incidents reconstructable, at a visible eval cost, with a backbone that is real only when a second pipeline plugs in without a fork.**

That is evaluation-driven development as a discipline. It is the right clever answer. It does not make RAG scientific. It does not make the user happy. It does not make the bill smaller.

If nobody labels, do not judge. If 100% merge-block on faithfulness is mandatory, they will skip CI — refuse rather than fake a threshold. If N items cannot detect the MDE they care about, you do not have a regression gate; you have a ritual. Say that before you ship a dashboard that says Quality: 0.82.
