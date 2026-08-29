# RAG Evaluation & Observability Platform: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a platform that wraps RAG pipelines with **evaluation, observability, and a CI quality gate**, under a brief that looks like a product:

1. **RAGAS metrics** on every (or any) pipeline: faithfulness, answer relevancy, context precision, context recall.
2. **Request tracing and a dashboard.**
3. **A CI pipeline** (GitHub Actions / pytest) that runs a **fixed eval set** on every change and **flags regressions** in answer quality / faithfulness.
4. **One eval backbone** across all projects, tying back to [`prompt-lab`](../../prj--prompt-lab/README.md).

The design must answer, concretely:

1. What a RAGAS score is allowed to mean, once "the LLM judged it faithful" is no longer treated as ground truth.
2. What a CI gate is allowed to **block**, versus what it is only allowed to **flag**, given that the interesting metrics are noisy, LLM-judged, and small-N.
3. How CI evaluation (small labeled set, per-PR, cares about "did we regress") and production tracing (every live request, high volume, cheap, cares about "what is happening now") stay related without becoming the same expensive pipeline.
4. How an eval set is versioned, stratified, and kept from being tuned into a description of the current prompt.
5. What is measured so "we have RAG evals" is an operated discipline, not a notebook that agreed 18/20 times the week before launch.

This is the score-as-truth / one-backbone trap. The naive answers — `if mean(faithfulness) < 0.85: fail CI`, run RAGAS on 100% of production, or claim "one backbone" by copying a script into every repo — are the failure. They either auto-block on a noisy judge, bankrupt the token budget, or produce three incompatible CSV schemas and call the copy-paste a platform.

The correct shape is: **deterministic structural checks may block a merge; LLM-judged RAGAS metrics are calibrated signals subjected to a paired statistical test, not a raw threshold; production tracing is a separate, cheaper pipeline that shares a run schema with the eval harness; the eval set is versioned and periodically refreshed; judge-vs-human agreement is a first-class metric that can revoke trust in the soft gate.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making evaluation-driven development a discipline instead of a slide.

## The Trap, Stated Directly

"RAGAS in CI" in a product conversation is almost always used as if it meant **the pipeline got smarter, and we can prove it on every PR**. That is three independent claims glued together with a library name.

| What people hear | What the constraint actually protects |
| --- | --- |
| "RAGAS metrics" | Four *different* instruments, two of which need ground-truth context you may not have, two of which are LLM-judged and therefore noisy. Not a single quality number. |
| "Flag regressions" | A **decision**: block the merge, warn a human, or record a trend. Those are different error costs. A false block burns an engineer-day. A missed regression burns a user-week. |
| "Fixed eval set" | A **test corpus**. Fixed is good (reproducible). Permanently fixed is how it becomes the prompt's training set. |
| "One eval backbone" | Shared **identity, logging, and gating contract** with `prompt-lab`. Not one process that scores prompts, RAG, and agents with the same scorer. |
| "Dashboard" | Evidence someone looked. Without a gate contract and a calibration loop, it is a screensaver. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| A number that is "the quality of the RAG" | No. Faithfulness ≠ correctness. Context recall ≠ the retriever is good. Answer relevancy ≠ the user got what they needed. Four metrics, four failure modes. See [System Design](./03_system_design.md). |
| Auto-fail CI when RAGAS drops | Only if the drop survives a paired statistical test **and** the judge is currently calibrated against humans. A raw `mean < threshold` on 30 items will flap or be tuned into theater. See [ADR-001](./04_architecture_decision_records.md#adr-001), [ADR-003](./04_architecture_decision_records.md#adr-003). |
| RAGAS on every production request | Unaffordable and mostly useless. Production needs traces (latency, tokens, retrieval hit shape, citation presence). LLM-judge sampling of live traffic is a later, cost-capped canary — not v1. See [ADR-004](./04_architecture_decision_records.md#adr-004), [ADR-007](./04_architecture_decision_records.md#adr-007). |
| One backbone that "just works" for every pipeline | A **plug-in contract** (Task + Dataset + Retriever/Generator adapter + Scorer + Run). The first consumer is naive RAG. The claim is false until a *second* pipeline plugs in without forking the runner. See [ADR-006](./04_architecture_decision_records.md#adr-006) and kill criteria. |
| Correctness | Not this system's product. Faithfulness can be high on a consistently wrong-but-grounded answer. Retrieval can be perfect for a question the corpus cannot answer. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md). |

Capitulating to a raw RAGAS threshold is how you pass the interview by shipping a flaky test. Capitulating to "we'll look at the dashboard" is how you pass it with no gate at all. Treating CI eval and production tracing as one RAGAS loop is how you either skip tracing (too expensive) or skip judging (too noisy) and still say you built both.

## Current State (Assumed Starting Point)

A typical first version of "we evaluate the RAG" looks like:

1. Someone runs 15–30 hand-picked questions in a notebook against the current pipeline.
2. They call RAGAS (or paste answers into a judge prompt). Mean faithfulness is 0.82. A screenshot goes in the PR.
3. A Streamlit page plots last week's CSV. It is titled "RAG Observability."
4. CI, if it exists, either does nothing or runs those same 20 questions and fails if the mean drops 0.05. The first flake is "RAGAS is flaky, skip the job." The second is a threshold lowered until it never fails.
5. Production has application logs. Nobody can answer "which chunks did we send, at what rank, for this user question" without grepping.
6. A chunking change, a model swap, or a prompt tweak ships because the author's examples still look good. Users start getting fluent, well-cited, wrong answers. CSAT moves three weeks later.

That version will appear to work in a demo: one corpus, one pipeline, a green mean, a chart. It will fail in production the first time:

- the eval set is the author's favorite questions and the real mix is policy-edge / multi-hop / "not in corpus,"
- a retriever change raises context precision and lowers recall, and a blended "quality" score hides which stage broke,
- the judge prefers longer answers and a more verbose prompt "wins" while faithfulness is unchanged and users bounce,
- CI flaps on a 28-item set and the team learns to ignore it,
- someone turns RAGAS on a 5% production sample, the bill shows up, and tracing is still missing.

This project documents the replacement, not a prettier notebook.

## Concrete Pipeline Used Throughout These Docs

One product-shaped example, so the sequences are not abstract. The architecture is the same if the consumer is hybrid+rerank (`retrieval-x`) or corrective RAG (`rag-selfheal`); only the adapter and the strata change.

**Consumer v1: `docqa-basic` internal-docs Q&A.** Naive RAG over a private knowledge base (internal wiki / runbooks / policy docs). Ingest → chunk → embed → retrieve top-k → generate with citations.

Eval-set strata (illustrative, required in Phase 0):

| Stratum | Why it exists |
| --- | --- |
| Factual lookup | Answer is a named entity / number in one chunk. Retrieval-floor checks can actually fire. |
| Multi-hop | Needs two chunks. Naive RAG will fail some of these; that is the point of later pipelines. |
| Not-in-corpus / abstain | The honest answer is "I don't know." Faithfulness can look fine on a hallucinated-but-fluent refusal *or* a hallucinated-but-fluent invention — the stratum must distinguish. |
| Policy / citation-sensitive | Citations required; a number in the answer must appear in retrieved context. |
| Adversarial / injection-ish | Query tries to override system instructions via retrieved or user text. Structural safety checks, not RAGAS. |

Hard-gate checks (may block CI) — working list, not a manifesto:

- output schema / citation object present when the route requires citations,
- at least one retrieved chunk on factual-lookup items (retrieval floor),
- PII / banned-pattern regex on the generation,
- abstain-on-empty-context: if retrieval returned nothing, the model must not invent a specific fact,
- eval-set and pipeline config hashes recorded (a run without identity is not a run).

Soft-signal metrics (do **not** auto-block in v1):

- faithfulness, answer relevancy (LLM-judged),
- context precision, context recall (need labeled relevant chunks / ground-truth context),
- citation-attribution rate (deterministic overlap of claimed facts vs. retrieved text — hybrid: cheap, not RAGAS).

A genuinely open-ended ask ("summarize the vibe of this wiki") with no labeled context is **out of the v1 eval set**. Scoring it with context recall is theater. See Non-Goals and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## Target Users

- **Owning engineer (RAG pipeline)**: implements the adapter; needs a gate they can defend when a PR is blocked, and a decomposition that says *retrieval* vs *generation* broke.
- **Eval / platform engineer**: implements the harness extension on `prompt-lab`; needs judge calibration, eval-set versions, and a cost cap.
- **PR reviewer**: needs CI that means "this change did not break structural contracts, and the soft metrics did not move enough to care — or they did, and here is the paired test."
- **On-call**: needs traces for a live incident ("what chunks, what model, how long, how much") without waiting for an offline eval job.
- **Product**: wants "quality did not regress" as a sentence. Must accept a non-100% story, a "cannot tell" CI outcome, and staffing for human labels.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which wiki, which embedding model, the RAGAS library version) are out of scope except as parameters the run record must pin.

1. **Hard gates and soft signals are different instruments with different permission to block.** Deterministic / structural checks may fail a merge. LLM-judged RAGAS metrics may not, until (and unless) Phase 4 evidence shows calibration and false-positive rate justify it. A blended "RAG quality" score consumed by a single `if` is forbidden. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **LLM-judge scores require continuous calibration against human labels.** Judge-vs-human agreement (and known biases: position, verbosity, self-preference) is a measured property. If agreement is below the floor, the soft signal is marked untrusted; it does not silently keep gating or alerting as if it were. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Regression detection is a paired, power-aware comparison against a named baseline, not a raw mean delta.** Same eval-set version, candidate vs last-known-good. Outcomes are pass / fail / **cannot tell**. Sample size is justified against a minimum detectable effect. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. **Production tracing and CI evaluation are separate pipelines that share a schema, not one system.** CI runs the labeled set through the pipeline under test. Production emits traces (spans for retrieve / rerank / generate) on live traffic. Optional later: a cost-capped sampled live canary that *reuses* scorers. RAGAS on 100% of production is forbidden as v1. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **Metrics are scoped per stage.** Retrieval metrics (context precision/recall, hit rate@k, MRR if labels exist) are not averaged with generation metrics (faithfulness, relevancy). A dashboard that only shows one number has failed the design. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **The eval set is versioned, stratified, provenance-tracked, and periodically refreshed.** Editing items to make the current pipeline pass is a version bump with review, not a silent mutate. A holdout slice is not used for prompt iteration. Goodhart is an explicit risk with an audit. See [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **Evaluation cost is bounded and visible.** Expensive judge calls are async and/or sampled. Cheap checks stay synchronous and blocking. Per-PR token spend has a cap; exceeding it fails the *budget* check, not by silently dropping items. See [ADR-007](./04_architecture_decision_records.md#adr-007).
8. **This platform extends `prompt-lab`; it does not fork it.** The Run / Variant / Scorer / Dataset identities are the backbone. RAG-specific fields (retrieved chunks, ranks, corpus version, ground-truth contexts) are extensions. If plugging in is harder than copying a script, the backbone has failed — that is a kill criterion, not a documentation footnote.

## Success Criteria for the Design (Not Implementation Metrics)

1. A PR that removes citations from a citation-required route **fails the hard gate**. A PR that slightly rephrases the generator prompt does **not** fail because two RAGAS means differed by 0.03 on 30 items.
2. Same eval-set version, two independent CI runs of the **same** pipeline commit: the paired test's "cannot tell" / pass region is characterized; flake rate of the **hard** gate is near zero. Soft metrics are allowed to move within sampling noise.
3. A retriever change that tanks context recall on the multi-hop stratum is **visible as a retrieval regression**, even if faithfulness on factual-lookup stays flat. A generator change that tanks faithfulness with retrieval held constant is visible as a generation regression.
4. Judge-vs-human agreement is reported on a labeled slice on a cadence. If it drops below the floor, soft alerts are marked untrusted. The system does not keep page-ing on an uncalibrated judge.
5. A live production request can be reconstructed from traces: query (redacted policy), retrieved chunk ids + ranks, model id, tokens, latency per span. This does **not** require a RAGAS score on that request.
6. Cost of a PR eval run is a first-class metric (tokens, $ at the pricing snapshot). It is on a dashboard. Hiding it in "LLM spend" is a failed design.
7. A second pipeline (`retrieval-x` or equivalent) can plug in with an adapter + dataset + scorer selection, without forking the runner. Until that happens, "one backbone" is a claim, not a result. See kill criteria in the [Phased Implementation Plan](./06_phased_implementation_plan.md).
8. No path exists that auto-fails merge on an uncalibrated LLM-judge mean, and no path exists that runs RAGAS on 100% of production "as observability." If those are the actual requirements, this project is the wrong project.

## Business Rules (Eval-Scoped)

1. Faithfulness is not correctness. A grounded wrong answer can score well. Product copy and alerts must not say "accuracy" when they mean faithfulness.
2. Context recall items without labeled relevant chunks are **out of the recall scorer**. Do not invent labels from the generator's citations.
3. The eval set used as a merge signal is frozen between declared refreshes. Prompt authors do not get a write path to "fix" failing items in the same PR as the prompt.
4. Safety / injection / PII checks are hard gates. They are not averaged into a quality score that can compensate with higher relevancy.
5. "Cannot tell" is a legal CI outcome for soft metrics. Forcing it to pass or fail to make the GitHub check green/red is a process bug.
6. Corpus version, chunker version, embedding model, retriever config, generator prompt hash, and generator model id are part of the run identity. Scoring two systems against each other without pinning these is not a comparison.
7. Production traces may contain user queries. Redaction / retention / access control are on the critical path, not a Phase 4 polish. If you cannot store the query, you cannot debug the retrieve span — design the redaction, do not skip the span.

## Non-Goals

- **Not a correctness oracle.** RAGAS and LLM judges estimate properties of (answer, context, question) tuples. They do not know the world. Ground-truth answers, where they exist, are a separate scorer family (exact match / factuality against a labeled answer), not a RAGAS rename.
- **Not a replacement for human review** on safety-sensitive or high-stakes answers. Calibration uses humans; it does not replace them.
- **Not RAGAS on every live request.** Cost and latency forbid it. Tracing is the production path.
- **Not a hosted eval SaaS.** No multi-tenant product, no prompt marketplace, no "optimize my prompt" loop. The consumer is this org's RAG pipelines.
- **Not a prompt-optimization engine.** The gate *detects* regressions. It does not search the prompt space. That is a different product and a Goodhart accelerator.
- **Not a replacement for `prompt-lab`.** This is the RAG-shaped consumer and the tracing/CI specialization. Identity, adapters, run logging, and change-scoped CI belong to the backbone. Rebuilding them here is how the backbone dies.
- **Not an implementation.** No Python RAGAS calls, no pytest fixtures, no Grafana JSON. Numbered steps and diagrams only.
- **Not a claim that this is cheap or that it makes RAG "scientific."** Offline eval on a small labeled set is a biased sample of production. Production traces without labels cannot compute recall. Both sentences stay true after this platform ships. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
