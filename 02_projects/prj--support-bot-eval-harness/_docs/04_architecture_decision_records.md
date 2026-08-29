# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Statistical Paired-Comparison Gate vs Threshold on Aggregate Score

**Status**: Accepted

**Context**: The harness must block a ship when a new prompt or model version is worse than what is in production. The naive gate is `mean_score >= 4.0` or `mean_candidate - mean_baseline > -0.1`. Absolute thresholds rot when the judge, the golden set, or the rubric changes. A raw difference without an interval treats noise as a decision: with small n and noisy LLM judges, a 0.15 drop is often consistent with no change. Teams will still present a single percentage as proof. The coding-agent eval framework in this workbook already treats "10/10 succeeded" as statistically empty; this harness has the same disease.

**Decision**: The ship gate is a **paired per-item comparison** of candidate vs a declared baseline run on the same `golden_set_version` and the same `judge_id`. Report a point estimate and a confidence interval (bootstrap or equivalent) per pre-registered dimension and hard-fail stratum. Outcomes are `pass`, `fail`, and `inconclusive`. Model/provider changes do not ship on `inconclusive`. Fail-closed on harness incompleteness and on `judge_untrusted`. Absolute magic numbers are not the gate. See [System Design — Regression Detection](./03_system_design.md#4-regression-detection-across-model-version-upgrades).

**Consequences**:
- (+) A judge-prompt tweak cannot be laundered as "the bot got worse" if the baseline is re-judged with the same judge, or if the gate refuses mixed-judge pairs.
- (+) Inconclusive makes sample-size cowardice visible: if n cannot support the MDE, the gate says so instead of painting a checkmark.
- (–) PMs will hate `inconclusive`. Staff will pressure to "just use a threshold." That pressure is a sign the decision is doing work.
- (–) Requires a cached baseline on the same set version; set refreshes need bridging runs.
- **Alternative rejected**: `if mean < 4.0 then fail`. Cheap, stable-looking, and incomparable across rubric versions. Also rejected: unpaired two-sample tests that ignore that the same tickets were used.
- **Revisit trigger**: if the product only ever ships typo-level prompt edits, a cheaper smoke subset plus human QA may replace the full paired gate for *those* edits. Model/provider changes keep this ADR.

## ADR-002: Frozen Versioned Golden Set vs Continuously Updated Living Set

**Status**: Accepted

**Context**: A living set that authors edit whenever the bot fails an item becomes a description of the current prompt. Scores go up; production quality may not. A never-refreshed freeze diverges from live traffic (new policies, new scams, new SKUs). Both failure modes are common. The prompt author has an incentive to delete items the bot fails. Trust & safety has the opposite incentive on adversarial items.

**Decision**: Golden sets are **versioned and immutable** once an `eval_run` has pinned them. Curation follows a scheduled refresh plus hotfix-only exceptions. Prompt authors do not have veto to drop failing items. A canary/probe slice is kept off the authoring path. Refresh produces N+1 and a bridging comparison. See [System Design — Curation](./03_system_design.md#2-golden-set-curation-pipeline).

**Consequences**:
- (+) Historical gates remain auditable. "What did we measure when we shipped Tuesday" is answerable.
- (+) Goodhart pressure is reduced, not eliminated (the team can still overfit the frozen gate split).
- (–) Editorial process and bridging runs are real work. Teams will try in-place JSON edits "just this once."
- (–) Charts of quality over time break across versions unless overlap items are kept.
- **Alternative rejected**: a single mutable file in git with no version pin — CI always tests "whatever is on main," which moves under the candidate.
- **Revisit trigger**: a true hidden holdout with access control (prompt author tooling cannot read probe items) if honor-system splits are observed to leak. That is an implementation hardening, not a change of freeze policy.

## ADR-003: Calibrated LLM-Judge plus Sampled Human Review vs Pure Human or Pure Rules

**Status**: Accepted

**Context**: Human-grading every item on every ship and every canary does not survive contact with cadence and n. Pure rule-based scoring (string match, JSON schema) misses the majority of support quality (policy nuance, tone, partial answers) and still needs rules for the things rules are good at. Uncalibrated LLM-as-judge is the industry default and is known to exhibit position bias, verbosity bias, and self-preference; agreement with humans is often mediocre. Using the candidate to grade itself is circular.

**Decision**: **Decomposed rubric** scored by an LLM judge **plus** deterministic rules for schema/tool/leak patterns, with **human labels mandatory on safety (and money-adjacent) items before ship** and **sampled humans on a calibration subset** used to compute agreement. Below an agreed agreement floor, the judge is `untrusted` and the gate fails closed. Judge model should differ from the candidate family when cost allows. Pairwise order is randomized. Judge identity is pinned on paired runs. See [System Design — Judge Design](./03_system_design.md#3-judge-design).

**Consequences**:
- (+) Can actually run daily canaries and CI gates at n that statistics require.
- (+) Safety is not delegated to a model that can be talked out of a refusal.
- (–) Standing human labeling budget. If this is unfunded, the decision is a fiction — revert to a smaller n and slower cadence, or admit the gate is uncalibrated.
- (–) Judge-model cost is a line item. Changing the judge is an eval-system change.
- **Alternative rejected**: "GPT-as-judge, no humans" — cheaper, and you are measuring a second model's taste. Also rejected: "we'll QA live tickets instead of a gate" — that is lagging, confounded, and does not block a ship.
- **Revisit trigger**: if a high-stakes dimension (refund policy) never reaches usable κ, that dimension becomes **human-only** for ship gates, even if it slows the release. Do not average it into a noisy LLM score and call it gated.

## ADR-004: Production Canary as Silent-Swap Detector vs Vendor Changelogs

**Status**: Accepted

**Context**: Providers have changed behavior behind a stable API name. Changelogs are incomplete, delayed, or written for marketing. Fingerprint headers are inconsistent across vendors and can change for reasons that are not a model swap. A ship-time eval cannot see a Tuesday change when nobody shipped. Staging canaries that do not share production routing miss the event the scenario asks about.

**Decision**: Detect silent same-name drift by **replaying a frozen probe set against production routing on a schedule**, in non-mutating eval mode, comparing to an **explicitly frozen** `canary_baseline`. Vendor changelog scraping and fingerprint headers are **corroborating inputs**, never the sole detector and never a veto that suppresses a score/fingerprint alert. See [System Design — Silent Drift](./03_system_design.md#5-silent-drift-under-an-unchanged-api-name) and [Architecture — Canary](./02_architecture_document.md#4-canary-harness).

**Consequences**:
- (+) The only client-side mechanism that still works when the vendor says nothing.
- (+) Separates "we deployed a bad prompt" (ship gate) from "they changed the model" (canary without a our-side deploy).
- (–) Detection is probabilistic; residual false negatives remain. Certainty requires a pin/dedicated deployment the vendor may not sell.
- (–) Eval traffic on production routing, cost, and a pager. Staging-only is rejected as not answering the question.
- (–) Detection lag equals cadence × consecutive-run / CUSUM rules.
- **Alternative rejected**: "watch the vendor blog and Slack." Free, and how you explain the incident in the postmortem. Also rejected: trusting `model=` as a version.
- **Revisit trigger**: if the vendor offers a **cryptographically or contractually pinned** model-version-id and dedicated capacity, the canary becomes defense-in-depth rather than the primary control. Keep the canary; it still catches *your* prompt-store drift and router bugs.

## ADR-005: Behavioral Fingerprints Supplement Score-Based Drift vs Scores Only

**Status**: Accepted

**Context**: Rubric scores are noisy (judge), expensive (tokens), and slow to move if the swap preserves "average helpfulness" while changing verbosity, tool eagerness, or refusal boundaries. Infra-level swaps often move latency and token counts first. Score-only detectors miss those; fingerprint-only detectors page on CDN blips.

**Decision**: The drift detector consumes **both** score-distribution shifts **and** a small pre-registered fingerprint set (latency quantiles, length/tokens, tool-call rate, schema-fail rate, refusal rate on the adversarial slice, provider fingerprint header when present). Thresholds are calibrated in a Phase 3 drill that points the canary at a *different* model while holding the API-name field constant. Fingerprints do not replace the rubric; a latency page without score or refusal movement is correlated with infra status, not auto-declared a model swap. See [System Design — Behavioral Fingerprints](./03_system_design.md#53-behavioral-fingerprints).

**Consequences**:
- (+) Catches class of swaps that a mean-quality t-test will not.
- (+) The drill makes "we would have caught it" an empirical claim instead of a diagram.
- (–) More ways to false-alarm; requires conservative combination rules and a false-positive budget.
- (–) Optional embedding-centroid features add another model and another way to overfit the detector. Keep them optional until the drill shows they help.
- **Alternative rejected**: score-only monitoring — cheaper, slower, blinder. Also rejected: a large unsupervised "anomaly model" without labels — you will not know what it detected.
- **Revisit trigger**: if the Phase 3 drill cannot distinguish models on this probe set even with fingerprints, the probe set is the problem (wrong items, too small). Expand or accept a larger residual blind spot in writing; do not add features until the drill works.
