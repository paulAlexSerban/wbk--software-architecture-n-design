# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Hard Deterministic Gates Block Merges; LLM-Judged Metrics Do Not (v1)

**Status**: Accepted

**Context**: The scenario asks for a CI pipeline that "flags regressions in answer quality/faithfulness." Teams hear "fail the build." RAGAS faithfulness and answer relevancy are LLM-judged: they move with judge model, judge prompt, position, verbosity, and sample size. A required GitHub check of the form `mean(faithfulness) < 0.85` either flaps (engineers skip the job) or is tuned until it never fires (theater).

Deterministic checks — citations present, fabricated citation ids, retrieval floor, PII regex, abstain-on-empty, identity hashes — are repeatable. They catch a large class of the dumb failures that notebooks miss. They do not catch "the answer got slightly less grounded on multi-hop."

**Decision**: **Only hard, deterministic checks (plus harness health and token-budget) may block merge in v1.** RAGAS-family and other LLM-judged scores are computed, stored, and **annotated**. They may generate Phase 3 human-reviewed alerts. They do not own the required CI check. Promotion of a soft metric to a blocking gate is a Phase 4 decision with an evidence bar (calibration floor held, false-positive rate on replayed good PRs below a signed threshold). Default of Phase 4 is still "do not auto-block."

**Consequences**:
- (+) CI is trusted enough not to be skipped. Flakes belong to the pipeline/adapter, not to a sampling judge.
- (+) Reviewers still see soft regressions instead of discovering them in production only.
- (–) A real faithfulness regression can merge if hard gates pass. That is the explicit trade: missed-soft vs false-block. Mitigation is alerting + nightly full suite, not a quieter threshold.
- (–) Product may feel the gate is "weak." The alternative is a gate nobody believes.
- **Alternative rejected**: Raw RAGAS threshold as required check. Flake or theater. Both kill eval culture.
- **Alternative rejected**: No CI gate at all; dashboard only. The scenario's "every change" clause dies; this becomes a screensaver.
- **Alternative rejected**: Block on "cannot_tell." Incentivizes shrinking the suite until the test always has an opinion.
- **Revisit trigger**: Phase 4 evidence bar met *and* product signs the remaining false-block rate. Until then, this ADR holds under incident pressure.

## ADR-002: LLM-Judge Scores Require Continuous Human Calibration

**Status**: Accepted

**Context**: LLM-as-judge is the only practical way to estimate faithfulness/relevancy at eval-set scale. It is also biased (length, position, self-preference for its model family) and prompt-fragile. A judge that is never checked against humans will agree with itself. Shipping "we have RAGAS" without a κ is how you automate the author's taste in a different model.

Human labels are slow and expensive. That does not make them optional. It makes the labeled slice smaller than the full set — which is acceptable if agreement is measured and trust can be revoked.

**Decision**: A judge is **untrusted** until a CalibrationSnapshot exists for that `(judge_model, judge_prompt_hash, metric, stratum)` tuple, and it **returns to untrusted** on any judge-model or judge-prompt change. Cadence continues after first trust. Agreement below the Phase 0 floor marks the signal untrusted: scores are still stored; they do not produce alert-class `fail`. Humans are the authority on safety-adjacent items.

**Consequences**:
- (+) Soft metrics have a meaning that can be withdrawn. Dashboards show trust state.
- (+) Judge prompt tweaks cannot silently re-baseline history.
- (–) Labeling is a standing cost. If nobody labels, the soft suite is a research log. That is honest; pretending otherwise is not.
- (–) κ floors will be argued. Phase 0 must pick numbers and a "barely usable vs excellent" distinction. See [System Design](./03_system_design.md#6-judge-calibration).
- **Alternative rejected**: Trust the library defaults. RAGAS is not a metrology lab.
- **Alternative rejected**: One Phase 0 workshop, never repeat. Drift in judge and in pipeline output distribution is the whole problem.
- **Alternative rejected**: Ensemble of three judges instead of humans. N× cost, correlated taste, still no human anchor.
- **Revisit trigger**: none for the existence of calibration. Floors and rubric grain may change with evidence.

## ADR-003: Regression Detection Is Paired, Power-Aware, and Three-Valued

**Status**: Accepted

**Context**: "Flags regressions" implies a detector. A mean delta on 20 items cannot distinguish a real drop from judge noise. Thresholds like 0.85 are not properties of RAG. Unpaired comparison across eval-set versions confounds dataset change with pipeline change.

Statistical tests can be cargo-culted too: p < 0.05 on four metrics × five strata will fire. Power is usually the actual constraint: small N only detects large effects.

**Decision**: Compare **the same items** (same `eval_set_version`) candidate vs a **named baseline** batch. Use a pre-registered paired test; report effect size, interval, p, and whether N can detect the MDE. Outcomes are `pass` / `fail` / **`cannot_tell`**. Pre-register which metric×stratum slices may emit `fail`; the rest are diagnostic. Incomplete coverage or untrusted judge → `cannot_tell`, not a silent pass. `cannot_tell` does not fail the hard merge check ([ADR-001](#adr-001)).

**Consequences**:
- (+) "We cannot tell" is a first-class, honest CI annotation.
- (+) Dataset refreshes cannot masquerade as pipeline regressions.
- (–) People hate `cannot_tell` because GitHub likes green/red. Training and annotation UX are required.
- (–) MDE vs N will force either a larger labeled set or humility about what CI can see.
- **Alternative rejected**: Absolute threshold with no baseline. Not regression detection; a mood.
- **Alternative rejected**: Only report means and "looks down." Not a detector.
- **Alternative rejected**: Require `fail` to be merge-blocking. Conflicts with ADR-001 until Phase 4.
- **Revisit trigger**: eval set grows enough that a specific metric's MDE is routinely detectable *and* ADR-001 is reopened.

## ADR-004: Production Tracing and CI Evaluation Are Separate Pipelines Sharing a Schema

**Status**: Accepted

**Context**: "One eval backbone" plus "request tracing and a dashboard" is easy to implement as: run RAGAS on production, plot it. That path has the wrong cost (judge × QPS), the wrong latency (must not sit on the user), the wrong labels (no ground-truth contexts on live traffic), and the wrong sampling (production mix ≠ eval set, but you still will not have recall labels).

CI evaluation needs a frozen labeled set and expensive scorers. Production needs reconstructable retrieve/generate spans and operational SLOs (latency, empty retrieval, cost). They share **identity fields** (corpus_version, model, prompt hash, chunk ids) so a canary can later promote a sampled trace into a Run. They do not share an execution path.

**Decision**: **CI eval** runs the adapter on the eval set, writes `prompt-lab` Runs, scores offline. **Production** emits OpenTelemetry-style spans with redaction; no judge on the hot path. Optional Phase 4: a **cost-capped** sampled canary that copies traces into Runs and scores them async. `prompt-lab` remains the backbone for runs/scores/variants; tracing is a sibling telemetry pipeline, not a second RAGAS.

**Consequences**:
- (+) On-call can debug a request without a judge budget.
- (+) CI remains statistically structured; production remains cheap.
- (–) Two systems to operate. "One backbone" is a schema and a harness, not one process. Teams looking for a single container will be disappointed on purpose.
- (–) Dashboards must join two stores. That is work; it is less work than a unified wrong system.
- **Alternative rejected**: RAGAS on 100% of production. Bill and still no recall labels.
- **Alternative rejected**: Skip tracing because CI exists. CI will not see the live failure mode of empty index or a bad deploy.
- **Alternative rejected**: Skip CI because tracing exists. Traces without labels cannot compute faithfulness.
- **Revisit trigger**: a legally required online moderation step (do not answer unless judged faithful). That is a **different** product with a latency SLO; design it explicitly, do not reuse the CI scorer in the request path by accident.

## ADR-005: Per-Stage Metrics; No Blended Quality Score as Gate or Page Input

**Status**: Accepted

**Context**: Retrieval and generation fail independently. Rerank can raise precision and drop recall. A generator can become more relevant and less faithful. Averaging into "RAG quality = 0.82" produces a number that always moves and never attributes. It is also the easiest thing to put in a dashboard and a slide.

**Decision**: Metrics are **named and stored per stage** (retrieval: hit@k, MRR, context precision/recall; generation: faithfulness, relevancy, citation overlap). Gates and alerts consume **named** metrics and strata. A blended score, if computed at all, is decorative and **forbidden** as input to Hard-Gate, RegressionDetector `fail` slices, or paging. Dashboards default to a decomposed view.

**Consequences**:
- (+) A retriever regression is visible when generation metrics are flat.
- (+) Product cannot "make quality green" by improving the wrong stage.
- (–) More charts. Reviewers must learn four names. That is the job.
- **Alternative rejected**: One quality KPI for execs as the system of record. They can have a slide; the system cannot be that slide.
- **Alternative rejected**: Only RAGAS faithfulness, because it is famous. Blind to retrieval.
- **Revisit trigger**: none for decomposition. Additional stage metrics (rerank) may be added as named series.

## ADR-006: Eval-Set Governance (Versioned, Refreshed, Provenance, Goodhart Guard)

**Status**: Accepted

**Context**: A "fixed eval set" is required for paired comparison. A *permanently* fixed set becomes the prompt's unofficial training data. Silent edits to make the current pipeline pass destroy the baseline. Twenty hand-picked items cannot support a regression claim ([ADR-003](#adr-003)) and are the demo trap.

This platform also claims to wrap **any** of the RAG projects. The second consumer is the test of the adapter/registry, not a larger set for the first pipeline.

**Decision**: Eval sets are **immutable versions** with strata, provenance, and splits (`gate` / `iterate` / `holdout`). Refreshes are reviewed diffs with reason codes for removals. Pipeline PRs cannot mutate `gate`. Context-recall labels are bound to `corpus_version`. "One backbone" means a second pipeline plugs into the same runner/store without a fork; until that happens, the claim is unverified (kill criterion). Goodhart audits are scheduled, not optional folklore.

**Consequences**:
- (+) Pairing is well-defined. History is replayable.
- (+) Holdout exists as a pressure valve against teaching to the gate.
- (–) Refresh and labeling are the real product. Engineering the runner is smaller.
- (–) A second pipeline may need different strata (graph-RAG multi-hop). The registry must allow per-`pipeline_family` sets, not one global 80 questions.
- **Alternative rejected**: One shared 20-question set for all RAG repos. Meaningless comparisons; easy Goodhart.
- **Alternative rejected**: Authors fix failing items in the prompt PR. Instant Goodhart.
- **Alternative rejected**: Never refresh. Permanent overfitting.
- **Revisit trigger**: if two consumers never appear, collapse to a single-purpose harness for `docqa-basic` rather than maintain a SPI. See [Phased Implementation Plan](./06_phased_implementation_plan.md).

## ADR-007: Cost-Bounded Evaluation — Cheap Checks Synchronous; Judges Async and Capped

**Status**: Accepted

**Context**: RAGAS-style scoring is multiple LLM calls per item. Full-suite × every PR × several engineers is a token firehose. If the job is slow or expensive, it will be skipped — the same failure as a flaky hard gate. Conversely, silently scoring a prefix of the set and publishing a mean is how you bias toward easy strata.

Production tracing must stay cheap (ADR-004). Sampling live traffic for judges, if it exists, needs a hard $ cap.

**Decision**: Hard-gate checks run in the blocking CI path. Judge scorers run **async** relative to the merge-blocking check (the PR can merge on hard pass while soft is still running; the annotation updates). A **per-batch token budget** is pinned; exceeding it fails the budget check and **does not** publish partial soft means. Smoke vs full matrix follows `prompt-lab` change-scoping. Live canary (Phase 4) has a separate monthly cap; hitting the cap stops the canary, not user traffic.

**Consequences**:
- (+) Merge velocity is not held hostage to judge RPM.
- (+) Finance sees eval $ as a line, not a surprise.
- (–) Reviewers may merge before soft annotation exists. Process: if the change is retriever/prompt/model, wait for soft or merge with explicit "soft pending" and a follow-up. Do not pretend the annotation was there.
- (–) Smoke sets can be gamed (ADR-006). Full nightly is mandatory, not "if we remember."
- **Alternative rejected**: Full RAGAS blocking every PR. Will be skipped or shrink the set.
- **Alternative rejected**: Unlimited judge spend. Not an architecture.
- **Alternative rejected**: Drop items silently to keep the mean on time.
- **Revisit trigger**: judge becomes locally cheap and fast enough that blocking on the full suite no longer harms velocity — still does not override ADR-001's evidence bar for *failing* merge on judge scores.
