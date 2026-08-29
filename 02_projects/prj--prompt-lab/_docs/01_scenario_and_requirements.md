# Prompt Lab: Scenario and Requirements

## Problem Statement

A team needs to treat prompts the way they treat code: **versioned artifacts with a CI gate**. The same task must be runnable through:

- zero-shot
- few-shot (named exemplar sets)
- chain-of-thought
- structured-output (JSON schema / function-calling)
- system-prompt variants

against different models and providers. Every run is logged (prompt version, model, output, tokens, latency, cost) and scored (exact-match now, LLM-as-judge next, RAGAS later). A prompt change cannot merge if eval scores regress.

This is the **one-off notebook trap**. The naive answer — a Python script per project, a handful of hand-picked examples, a playground comparison, a CSV overwritten every Friday, and a Slack message that says "looks better on GPT-4o" — is the failure. It produces a demo that looks like evaluation and a prompt corpus whose quality is unobserved, incomparable across models, and ungated on merge.

The architecture angle is not "write a better script." It is: **design a pluggable evaluation-harness abstraction (provider-agnostic) that later projects can plug into** — without pretending that "provider-agnostic" is a clean interface, that "a prompt version" is a git tag, or that one blended score can stand in for exact-match, a noisy judge, and a retrieval metric that does not yet have a pipeline.

## The Trap, Stated Directly

Standard prompt-shipping culture treats **a handful of impressive completions** as evidence, and treats **the script that produced them** as infrastructure. If the eval is:

- a notebook that only the author can run
- unversioned (the prompt in the file moved; last week's numbers refer to a string that no longer exists)
- single-model (or "we tried Claude once")
- scored by vibe, or by exact-match on tasks that do not have a canonical answer
- run once at ship time, never in CI
- copied into the next project with the filenames changed

then the design has already failed the problem:

- **You cannot bisect a regression.** "Quality dropped in March" is not an artifact. There is no `(variant_hash, model, dataset_version, scorer_id)` tuple to re-run.
- **You cannot compare techniques.** Zero-shot vs few-shot vs CoT vs structured-output is a matrix. A notebook that ran two of them on one model is a conversation, not an experiment.
- **You cannot compare providers.** Token counts, cost, structured-output fidelity, and refusal behavior are not interchangeable. A "pass rate" copied from OpenAI onto Anthropic is a category error if the scorer, the tokenizer, or the JSON mode is different.
- **A prompt PR has no tests.** Merge is a vibe. The next person who "simplifies the system prompt" will not know they broke structured-output on the cheap model.
- **Goodhart arrives immediately.** If the only eval is the author's five examples, the prompt will be tuned to those five examples. Scores go up. Production does not.
- **"We'll make it a platform later"** is how every project grows a private harness with three incompatible CSV schemas, and the "eval backbone" never exists.

The correct shape is: **a content-addressable variant identity; a thin provider-adapter contract that is allowed to leak; pluggable scorers that do not share a statistic; a change-scoped CI matrix (smoke on PR, full on schedule/release); Postgres as the system of record for runs; and an explicit refusal to become a hosted eval SaaS or a prompt-optimization loop.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under combinatorial explosion, biased judges, vendor API drift, and the temptation to abstract before a second consumer exists.

This project is **not** [prj--support-bot-eval-harness](../../prj--support-bot-eval-harness/README.md). That harness is scoped to one support bot, one golden set, one canary, and it *rejects* being a platform. `prompt-lab` is the deliberate opposite: a general-purpose backbone. The honesty required here is the inverse — **do not over-build the platform for consumers that do not exist yet**, and **do not under-build the identity/logging/gating core** so that every later project has to reinvent it.

## Current State (Assumed Starting Point)

A typical first version of "we evaluated the prompt" looks like:

1. An engineer pastes the task into a playground or a Colab.
2. They try zero-shot, then paste three examples, then add "think step by step," then ask for JSON.
3. They pick the completion they like, maybe on one model.
4. The winning string is copied into the product. The losing variants are lost.
5. Cost and latency are "it felt fine." Tokens are whatever the UI showed that day.
6. Next quarter a different engineer tries a different model with a different script and cannot tell whether the prompt, the model, or the examples moved.

That version will appear to work for a classification task with a 20-item labeled set and one provider. It will fail the first time a structured-output change looks fine on GPT and produces unparseable JSON on the cheap model; the first time few-shot exemplars leak the answer format that exact-match was rewarding; the first time prices change and last quarter's cost chart is incomparable; the first time a prompt PR merges because CI has nothing to run.

This project documents the replacement, not a patch of that notebook.

## Target Users

- **Prompt / eval engineer**: owns the harness; needs a data model, an adapter contract, and a gate they can defend.
- **Downstream project teams** (RAG, agents, support bot, coding harness): supposed to *plug in* a Task + a Dataset + a Scorer, not fork the runner. If plugging in is harder than copying a script, they will copy a script.
- **PR reviewer / tech lead**: needs a CI check that means "this prompt change did not silently regress the smoke matrix," not a screenshot of a notebook.
- **FinOps-adjacent owner** (optional, later): needs cost per `(task, variant, model)` that still makes sense after a price change — which requires a **pricing snapshot on the run**, not a live lookup at dashboard time.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which demo task to use in Phase 1, which models are in the matrix) are out of scope except as parameters the harness must record.

1. **A variant is a composite, content-addressable identity, not a monotonic integer.** The unit of experiment is at least: task id, template text, technique tag, few-shot exemplar-set hash, output schema hash, system-prompt hash, model id, provider id, decoding parameters. Changing any axis is a new variant. Human-readable names (`fewshot-v3`) are aliases, not the primary key. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Providers are plugged in behind a thin adapter, not behind a fantasy of uniformity.** The harness calls `complete(request) → normalized result`. Tokenizers, JSON-mode, tool-calling, rate-limit errors, and streaming are **allowed to differ**. Differences must be labeled on the run (`structured_output_mode = native_json | tool_call | prompt_fallback`). A silent prompt-and-pray JSON path that reports the same `technique=structured_output` as native schema mode is a lie. See [ADR-003](./04_architecture_decision_records.md#adr-003).
3. **Scorers are pluggable and statistically non-fungible.** Exact-match, LLM-as-judge, and (later) RAGAS are different instruments. They must not be averaged into one "quality" number that a gate consumes. A task declares which scorers apply. A gate declares fail rules **per scorer family**. See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **Every run is an immutable log row**, including prompt/variant hashes, model, raw output (or a redacted pointer), usage tokens, latency, estimated cost against a **versioned pricing snapshot**, scorer identities, and scores. Overwriting last week's CSV is forbidden. Historical cost is computed from the snapshot pinned on the run, not from today's price list.
5. **CI is a change-scoped matrix, not "run everything" and not "run nothing."** A prompt PR runs a **smoke matrix** derived from which artifacts changed. A scheduled (or release) job runs the **full matrix**. Model/provider/scorer changes cannot hide behind the smoke path. Fail-closed on harness errors. See [ADR-002](./04_architecture_decision_records.md#adr-002).
6. **RAGAS is an extension point, not a v1 scorer.** RAGAS needs retrieval context, ground-truth context, and a RAG pipeline. Those fields do not exist until a consumer project has them. The Run record may grow optional context blobs; the harness must not invent a fake retriever so a slide can say "RAGAS ready." See [ADR-005](./04_architecture_decision_records.md#adr-005).
7. **The core contract is small and stable: Task, Variant, ProviderAdapter, Scorer, Run.** Speculative fields for agents, tools, multi-turn traces, and production canaries are deferred until a real second consumer requires them. If only one project ever plugs in, the platform is a failed bet — collapse to a single-purpose harness rather than keep a SPI nobody uses. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md) and [Phased Implementation Plan — Kill Criteria](./06_phased_implementation_plan.md#kill-criteria-for-the-harness-program).

## Success Criteria for the Design (Not Implementation Metrics)

1. Two prompt strings that differ by whitespace-significant template text, or by exemplar set, or by decoding temperature, produce **different variant hashes**. Two aliases pointing at the same bytes produce the **same** hash. A run can be reproduced from the hashes plus the pinned dataset version.
2. Adding a second provider does not require rewriting scorers or the run schema. Adding a second provider **does** require documenting adapter leakage (tokenizer, JSON mode, error mapping) in the run metadata — "it just worked" is not the success criterion; "differences are visible" is.
3. A PR that changes only a few-shot exemplar file runs the smoke cells that depend on that file, not the entire matrix, **and** a PR that changes a scorer or a shared template used by many tasks cannot skip those cells.
4. Exact-match regressions and judge-score regressions are reported **separately**. A rise in exact-match cannot launder a fail on a hard-fail judge dimension.
5. Cost numbers on a six-month-old run still match the pricing snapshot stored with that run after a vendor price cut.
6. RAGAS is not callable in Phase 1–4. The extension point exists as optional fields and a scorer interface. A design review that requires RAGAS charts in v1 fails this criterion.

## Business Rules (Harness-Scoped)

1. The CI gate compares a candidate variant (or matrix) against a **declared baseline run set** on the same dataset version and scorer ids, not against an absolute "80% exact-match" magic number. Absolute thresholds rot when the dataset or the judge prompt moves.
2. `inconclusive` is a legal gate output. For changes that alter prompts, models, or scorers, inconclusive does not merge. For typo-only comment changes in a markdown README, the gate may be skippable — write the exception list in Phase 0 so Friday night is not a debate.
3. One primary eval run per candidate artifact per matrix cell. Re-running because the scores were sad is p-hacking. Harness 5xx retries are allowed and must be distinguished in the log.
4. Judge-model and judge-prompt are part of `scorer_id`. Changing the judge is an eval-system change and cannot share a paired comparison with the old judge.
5. Prompts and few-shot exemplars that contain secrets or PII do not enter the registry. The run log is a datastore of prompts. Treat it like one.
6. Provider keys live in CI secrets / a secret store, not in the repo. Downstream projects do not get a copy of the lab's keys "to debug."
7. Pricing snapshots are dated. A run that cannot resolve a snapshot records `cost_status = unknown` rather than inventing a number from a blog post.

## Non-Goals

- **Not a hosted eval SaaS / observability platform.** No multi-tenant UI, no prompt playground product, no "LLM OS." Postgres + CI + a thin report artifact is the v1 surface. Dashboards are Phase 4, and they are tables of runs, not a startup.
- **Not prompt auto-tuning, DSPy-style search, or RLHF.** The harness *measures*. Searching prompt space against the eval set is how you overfit and launder it as improvement. [ADR-004](./04_architecture_decision_records.md#adr-004) forbids treating the gate as an optimizer.
- **Not RAG evaluation in v1.** No retriever, no chunking, no RAGAS charts. Extension point only ([ADR-005](./04_architecture_decision_records.md#adr-005)).
- **Not a production canary / silent model-swap detector.** That problem is solved (and scoped) in `prj--support-bot-eval-harness`. If a later consumer needs a canary, they plug a Task into this harness *and* own their production probe; this project does not grow a scheduler pointed at production APIs in v1.
- **Not fine-tuning, batch inference platforms, or model hosting.**
- **Not a universal N-provider plugin marketplace.** Two or three adapters, copy a folder for the fourth. A SPI for community plugins is how the usage/parser — the only thing that makes cost real — gets an interface and a bug ([ADR-003](./04_architecture_decision_records.md#adr-003)).
- **Not an implementation.** No pytest, no SDK, no GitHub Actions YAML. Numbered steps and diagrams only.
- **Not a claim that this is cheap, cleanly abstract, or that later projects will actually plug in.** Combinatorial cost is real. Adapter leakage is real. Platform bets fail. See [Brutal Honesty](./02_architecture_document.md#brutal-honesty) and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not required for every comma in a prompt comment.** A smoke-vs-full policy exists so the gate is not architecture theater on docs-only PRs. The *existence* of the gate is required for ships that change templates, exemplars, schemas, models, or scorers.

## Relationship to Other Workbook Projects

| Project | Relationship |
| --- | --- |
| `prj--support-bot-eval-harness` | **Consumer-shaped, not a duplicate.** That project is one bot, frozen golden set, production canary. If it were built after prompt-lab, its ship-loop would *call* this harness. Its canary loop would not. Do not merge the two designs. |
| `prj--coding-agent-harness` | Would plug in as a Task with a very different scorer (patch quality, tests). Multi-turn traces are **not** in prompt-lab v1; that is a contract change if/when this consumer is real. |
| `prj--rag-pipeline-at-scale` | The first plausible RAGAS consumer. Until that project actually integrates, RAGAS stays an extension point. |
| `prj--llm-gateway` | Orthogonal. Gateway is a control plane for spend and fallback in production. Prompt-lab is an offline (CI) measurement system. They may share provider keys operationally; they do not share a data model. |

If this workbook is documentation-only, "later projects plug in" is a **design claim**, not an observed fact. The phased plan's kill criterion exists because claims are not users.
