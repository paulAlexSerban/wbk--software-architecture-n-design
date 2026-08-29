# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Composite Content-Addressable Variant Identity vs Flat Version String

**Status**: Accepted

**Context**: Teams version prompts as `v3`, a git tag, or a filename (`prompt_fewshot.txt`). None of those say which bytes were composed: template, technique, exemplars, schema, system prompt, decoding. A CI gate that says "prompt v3 failed" cannot be reproduced when v3 was a folder that moved. Two aliases can point at different bytes a week apart. The support-bot harness versions a *golden set*; this harness must version the *stimulus*, which has more axes.

**Decision**: The unit of identity is a **composite content hash** of task id, template, technique, system prompt, exemplar pack, schema, and decoding parameters, after a frozen normalization spec. Aliases are pointers with history. Provider and model are **run** dimensions, not variant axes, so the same prompt bytes can be compared across models. Dataset version and scorer id are also run pins, not variant axes. See [System Design — Variant Identity](./03_system_design.md#2-variant-identity).

**Consequences**:
- (+) Reproducible: a run cites hashes; you can see whether the exemplar pack moved.
- (+) Cross-model comparison does not fork the prompt identity.
- (–) Normalization will be bikeshed. Wrong normalization either collides different behavior or churns hashes on every save.
- (–) Humans will still say "fewshot-v3" in Slack; the artifact must print the hash or the conversation is not evidence.
- **Alternative rejected**: monotonic `prompt_version` integer in a YAML header — easy, and it lies as soon as two axes change in one PR. Also rejected: git SHA of the whole repo as the only identity — a README change would look like a new prompt, or worse, a prompt change buried in a mixed SHA would be invisible without path-aware hashing anyway (the scoper handles paths; identity still needs bytes).
- **Revisit trigger**: if render bugs dominate (Jinja), promote `rendered_hash` from optional run field to a gate pin. That does not replace template hashing.

## ADR-002: Change-Scoped Smoke on PR vs Always-Full Matrix vs Author-Picked Cells

**Status**: Accepted

**Context**: `tasks × techniques × models × items` will not fit a PR check. Always-full on every PR will be skipped or broken into "optional CI." Author-picked cells ("I ran the three examples I care about") is the notebook trap with a green checkmark. A smoke set that never includes the changed technique is a disabled gate.

**Decision**: PRs run a **manifest-mapped smoke matrix** (affected tasks/variants/models, `split=smoke` items). Unmapped paths fail-closed. Shared templates, adapters, and scorers upgrade to `smoke_wide`. The **full matrix** runs on a schedule and/or release candidate. Baseline cells are cached by hash. Authors do not choose smoke cells ad hoc. See [System Design — Change-Scoped Matrix](./03_system_design.md#5-change-scoped-matrix-and-gate).

**Consequences**:
- (+) PR time stays in "minutes if we keep smoke small."
- (+) Adapter/scorer changes cannot hide behind a docs skip.
- (–) The scoper will be gamed (behavior in a file classified as docs). Fixture tests on diffs are mandatory.
- (–) Nightly full matrix will be ignored unless someone owns it; residual risk is "PR passed, full would have failed."
- **Alternative rejected**: always-full — honest, and the gate dies. Also rejected: optional check — equivalent to no gate. Also rejected: "run whatever the PR author lists in a checkbox."
- **Revisit trigger**: if smoke timeouts persist after caching, cut in-scope models in the smoke *declaration* in writing (raise residual risk), do not silently drop cells.

## ADR-003: Thin Adapters for a Few Providers vs Generic N-Provider Plugin SPI

**Status**: Accepted

**Context**: "Provider-agnostic" is in the scenario. The failure mode is a plugin interface so generic that usage parsing, JSON mode, and error taxonomy become optional callbacks — i.e. the only parts that make logs comparable. Four providers is copy-paste. Forty providers is a product we are not building.

**Decision**: Implement a **thin complete() contract** with **explicit leakage fields** (`structured_output_mode`, `token_count_source`, `error_class`, `other_tokens_json`). Ship OpenAI and Anthropic (a third only when a real task needs it). The next provider is a copied folder plus fixtures. No community plugin SPI, no "LLM driver" marketplace. See [System Design — Adapter Contract](./03_system_design.md#3-provider-adapter-contract).

**Consequences**:
- (+) Usage and JSON-mode differences stay visible; scorers stay provider-ignorant.
- (+) Adapter bugs stay in one folder.
- (–) Not "any OpenAI-compatible endpoint works" until someone writes the adapter and the fixture that proves usage parse.
- (–) Local/OpenRouter/Gemini wait their turn; that is acceptable for a lab.
- **Alternative rejected**: LiteLLM-as-the-adapter-layer on day one — it may be a fine *implementation* later, but architecturally we still need leakage fields and fixtures; wrapping a mega-adapter without those is how cost becomes fiction. If Phase 0 buy-vs-build picks a vendor, this ADR is about *semantics*, not about writing SDK calls by hand.
- **Revisit trigger**: a fourth production provider with a truly different paradigm (e.g. only batch, or only on-prem with no usage) — extend the usage schema; still no SPI.

## ADR-004: Pluggable Scorers with Separate Gate Statistics vs One Blended Quality Score

**Status**: Accepted

**Context**: Exact-match is a Bernoulli on a canonical target. LLM-as-judge is a noisy ordinal/pairwise instrument. RAGAS is a retrieval-faithfulness family that needs context. Averaging them produces a number nobody can defend and a gate that can pass by improving the easy instrument. Prompt auto-tuning against a blended score is Goodhart.

**Decision**: Scorers are **strategies** behind one interface that write typed score rows. The gate applies **per-family** statistical tests (proportion/CI for exact-match family; paired bootstrap for judge family). Overall fail-rules are boolean combinations, not an average. The harness measures; it does not search prompt space. See [System Design — Scoring](./03_system_design.md#4-scoring).

**Consequences**:
- (+) A schema-parse collapse cannot be hidden by a friendlier judge on prose.
- (+) Tasks without targets cannot pretend to have exact-match.
- (–) PR artifacts are tables, not one badge. People will ask for the badge anyway.
- (–) More code paths; more ways to mis-declare which family is in-scope.
- **Alternative rejected**: single 0–1 "quality." Also rejected: using the candidate model as the only judge. Also rejected: auto-prompt-optimization loops in v1.
- **Revisit trigger**: a consumer that truly has a single binary product metric (e.g. "JSON accepted by downstream API") may gate **only** that rule scorer for that task — still not a blend.

## ADR-005: RAGAS as a Deferred Extension Point vs Building Retrieval Scoring Now

**Status**: Accepted

**Context**: The scenario says "later RAGAS." RAGAS (and cousins) assume retrieved context, often ground-truth context, and a RAG pipeline. This lab's v1 tasks will be closed or rubric-graded generations without a retriever. Building a fake retriever so a dashboard can say RAGAS is how you ship a metric that does not measure the product. Designing the entire run schema around RAGAS fields nobody fills is premature abstraction.

**Decision**: Optional `retrieved_context` / `ground_truth_context` on items. A RAGAS (or retrieval) scorer **refuses** if those fields are empty. No gate rule consumes it until a real consumer (e.g. a RAG project) fills them and Phase 5's entry gate fires. Do not vendor-lock the interface to one library name internally — "retrieval family" is the slot; RAGAS is the likely first implementation. See [System Design §4.3](./03_system_design.md#43-ragas--retrieval-family-reserved).

**Consequences**:
- (+) v1 stays honest: exact-match + later judge.
- (+) A RAG team can plug in without a harness rewrite *if* they can populate context fields.
- (–) The slide "eval backbone including RAGAS" is false until Phase 5. Say so.
- (–) If the first real consumer is RAG, we will have built EM-first and must retrofit item fields — acceptable, cheaper than fake RAGAS.
- **Alternative rejected**: bundle RAGAS in Phase 1 with synthetic context. Also rejected: a standing vector DB in the lab "just in case."
- **Revisit trigger**: `prj--rag-pipeline-at-scale` (or another consumer) actually integrates. That *is* Phase 5's entry gate, not a docs-only promise.

## ADR-006: Job-Shaped Runner in CI vs Standing Eval Service

**Status**: Accepted

**Context**: A standing service would allow interactive playgrounds, web UIs, and multi-tenant teams. It is also an always-on SPOF, an auth surface, and on-call. The scenario's control plane is GitHub Actions on PR. Volume in Phase 1–4 is batch.

**Decision**: The harness is a **job** invoked locally and in Actions. Postgres is the only standing store (managed). No eval microservice until a consumer needs interactive submit-or-wait APIs or the matrix cannot finish inside CI limits even after scoping.

**Consequences**:
- (+) No new on-call in v1 besides "CI is red."
- (+) Same code path locally and in CI.
- (–) No nice UI; artifacts are files/PR comments.
- (–) Long full-matrix jobs fight Actions timeouts — mitigate with batching/sharding jobs, not a platform rewrite, until that is not enough.
- **Alternative rejected**: Kubernetes eval workers on day one.
- **Revisit trigger**: CI cannot shard the full matrix, or three teams need a queue API. Revisit together with [Trade-offs §4](./05_tradeoffs_and_honest_assessment.md#4-build-vs-buy) — buying a hosted eval product is the other way to get a UI.
