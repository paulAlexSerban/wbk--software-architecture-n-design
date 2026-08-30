# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Decision Layer vs. Expression Layer

**Status**: Accepted

**Context**: The scenario asks for "consistent answers" while forbidding temperature 0 (product wants creativity) and forbidding caching (answers must reflect live data). If "answer" means the entire completion string, the constraints contradict: a sampler at T>0 will not emit identical strings, and without a cache you cannot *return* an identical string either.

Most product pain that people label "inconsistent LLM" is not about synonyms. It is about the **decision** buried in the prose: eligible vs not, $40 vs $90, route to human vs auto-issue. That subset is small, typed, and expensive when it wanders. The rest is tone and explanation — the part product actually meant by "creativity."

Treating the whole string as the thing to stabilize forces a capitulation: T≈0 (stiff prose, constraint violated) or cache (stale facts, constraint violated) or a fuzzy "similarity" threshold that will pass two emails with different refund amounts because they both say "sorry."

**Decision**: Split every response into a **decision layer** (gated, schema-typed fields that downstream systems or the user's next action depend on) and an **expression layer** (wording, tone, optional elaboration). This architecture enforces consistency **only** on the decision layer. Expression is allowed — expected — to vary across requests. Numbers and enums that appear in the paragraph are rendered from the locked decision, not trusted as a source of truth.

**Consequences**:
- (+) The contradiction becomes a scoping problem, not a physics problem. Creativity and stability can coexist because they are not applied to the same bits.
- (+) Tests and SLOs can be stated without requiring string equality.
- (+) Downstream money/routing integrations consume the decision object, not a regex over the email.
- (–) Product must name the gated fields. That conversation is uncomfortable; it is also the work. If they refuse, there is nothing to vote on. See Phase 0 kill criteria.
- (–) Users who wanted identical paragraphs will still complain. That is a documentation and contract problem, not a reason to set T=0.
- **Alternative rejected**: Byte-identical completions. Forbidden by T>0 and no-cache. Claiming it is a lie.
- **Alternative rejected**: "The prose should be roughly similar (embedding cosine > 0.9)." Two refund emails can be cosine-similar and financially different. Similarity is not a ledger.
- **Alternative rejected**: Stabilize everything, including jokes. Pays N× for no decision value; fights the creativity constraint.
- **Revisit trigger**: a route whose only deliverable *is* the prose (marketing copy, poems) and whose "consistency" means brand-voice constraints. Then drop the ensemble; use a validator on a single sample. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## ADR-002: Schema-Constrained Output as the Voting Substrate

**Status**: Accepted

**Context**: Self-consistency as originally popularized compares chains of thought or final answers as text. Text is a bad ballot. "Approved for $40 because the item is unopened" and "Yes — refund 40 dollars, unopened" are the same decision and a failed string vote. The reverse also happens: identical-looking prose with a different buried number.

Constrained decoding / JSON schema / tool-calling exists specifically to make the model emit typed objects. Using it is how votes become field-wise. Not using it is how you build a paraphrase detector and call it architecture.

**Decision**: Every ensemble sample must emit a **schema-constrained decision object**. Aggregation is per field on parsed values. Unparseable samples are **dropped**, not repaired from surrounding prose (beyond trivial deterministic fence-stripping). Prompt-only "please return JSON" is a degraded fallback with worse parse-fail rates, not the design.

**Consequences**:
- (+) Votes are well-defined. Enums and booleans have exact match after canonicalization.
- (+) Parse failures become a measurable provider/schema health metric instead of silent garbage in a string majority.
- (+) The validator can re-check types mechanically.
- (–) Schema design is now on the critical path. A bad schema (free-text "reason" as gated) recreates the prose problem inside JSON.
- (–) Some models/providers are worse at constrained decoding at T>0. If Phase 0 shows unusable parse rates, this route may be unfit — raising N will not fix a model that cannot emit the schema.
- **Alternative rejected**: Diff or embed two full completions and pick a cluster. Fails the buried-number problem; expensive; un-auditable for finance.
- **Alternative rejected**: One unconstrained essay plus an extraction model. Two models, correlated errors, extra latency. Extraction can still disagree with the essay. Prefer one constrained sample (times N).
- **Revisit trigger**: a provider that cannot constrain output at all. Then the honest options are: different model, or reject this route, not a hero parser.

## ADR-003: N-way Self-Consistency at Fixed T>0 with Per-Field Aggregation

**Status**: Accepted

**Context**: Temperature 0 is the standard engineering move when someone says "make it consistent." Product forbade it. A single sample at T=0.7 is a draw from a distribution; treating it as *the* answer is how retries and double-clicks produce different refunds.

Self-consistency (Wang et al., and the industry pattern that followed) estimates the mode of that distribution by voting multiple samples. It does **not** require lowering T. Lowering T shrinks the distribution you were asked to keep for creativity, and at the limit it is the forbidden capitulation.

Picking sample #1, or picking the highest logprob sample, is not an ensemble. It is a single sample with extra bill.

**Decision**: For each request, draw **N independent samples at the product temperature (T>0, same T for all)**. Aggregate with type-specific rules: plurality for categorical/boolean/enum; for money, default **any dissent fails quorum** (stricter than median — see [System Design](./03_system_design.md#42-numeric)). Do not lower T to make the vote easier. Do not set T=0. Do not "just take the first completion."

**Consequences**:
- (+) Creativity constraint is honored at the sampler. Stability is purchased statistically on the decision layer.
- (+) Agreement rate is a function of the actual model+prompt+schema, measurable in production ([ADR-007](#adr-007)).
- (–) Cost ≈ N× (plus duplicated snapshot tokens in every prompt). This is the bill. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- (–) Latency p95 is the slowest of N, not the mean.
- (–) **Bias is not reduced.** N copies of a wrong mode vote the wrong answer confidently. Correctness remains evals, grounding, validator, humans.
- **Alternative rejected**: Temperature 0 (or T=0.1 "for stability"). Capitulation. Also: if you ever *do* set T=0, turn the ensemble **off** — paying N× for near-identical samples is waste.
- **Alternative rejected**: Single sample at T>0. Cheaper. Does not answer the scenario. Fine for chat that does not drive a ledger.
- **Alternative rejected**: Unbounded sampling until agreement. Cost and latency unbounded; can still agree on wrong; under provider 429 becomes an outage.
- **Alternative rejected**: A second, different model as judge of the N samples. Extra cost, correlated or anti-correlated errors you cannot explain, another provider in the SLO. The vote is the judge.
- **Revisit trigger**: product revokes the T>0 constraint. Then this ADR is void; ship T=0 single-sample and delete the ensemble.

## ADR-004: Once-Per-Request Live Snapshot Shared Across the Ensemble; No Cross-Request Answer Cache

**Status**: Accepted

**Context**: "No caching / answers must reflect live data" forbids serving a stored **completion** (or a stored decision) to a later request. It does not forbid using the same fetched facts for the N samples *of this request*. If each sample tool-calls live systems independently, they may see different inventory/policy mid-fan-out and the vote is across **different worlds** — which looks like model inconsistency and is actually a race.

Refetching per sample also multiplies load on live systems by N, which is a gift nobody asked for.

An application-level TTL cache of answers would give cheap "consistency" by violating freshness. A cache of the **snapshot** reused across requests is a softer form of the same sin unless the live systems are known-static for that TTL — which "live data" is defined not to be.

Vendor **prefix caching** of identical prompt prefixes *within* a request (or even across requests with the same prefix) is a billing optimization on bytes the vendor already saw. It must not be used as an excuse to skip a fresh fetch. Each request still fetches; if the new snapshot serializes identically, the vendor may charge less for the prefix. That is allowed.

**Decision**: **Fetch live data once per request, freeze a snapshot, inject that snapshot into all N samples.** Samples have **no live tools**. Do **not** cache the answer or the snapshot as a way to skip a later request's fetch. Persist the snapshot on the audit record for money routes (provenance), with retention — that is not serving it as an answer.

**Consequences**:
- (+) The ensemble votes in one world. Disagreement is then actually the model's.
- (+) Live-system QPS stays 1× per user request, not N×.
- (+) Later requests see a new world. Freshness constraint honored.
- (–) Every request pays a full fetch + full ensemble. No cheap repeat. That is the constraint. Budget it.
- (–) The same snapshot is sent N times as prompt tokens unless the vendor prefix-caches. Input-token tax is real.
- **Alternative rejected**: Cross-request answer cache (exact or semantic). Capitulation on live data. Semantic cache is worse: consistent *and* possibly about the wrong order.
- **Alternative rejected**: Each sample fetches/tools live. Votes across mismatched facts; N× read amplification.
- **Alternative rejected**: Cache the snapshot for 5 minutes "because orders don't change that fast." Then an order that does change in 5 minutes — the case live data was protecting — is stale by policy. If product wants that, they are asking for a cache and should say so in a different ADR, with a TTL and an invalidation story, not as a footnote here.
- **Revisit trigger**: a legally required "quote valid for 15 minutes" product. That is a **quote object** with its own id and expiry, not an LLM answer cache. Design that explicitly; do not reuse this ensemble cache-shaped.

## ADR-005: Deterministic Post-Processing After the Vote, Before Downstream Use

**Status**: Accepted

**Context**: A majority can still be illegal: refund > order amount, `eligible=false` with a positive amount, unknown `reason_code`, `policy_version` hallucinated. Shipping the vote because "the model agreed" is how you automate a confident policy violation.

The validator is also the only place in this design that is a **true function** — same snapshot, same aggregate, same accept/reject. That is the determinism people wanted, applied where it is actually available: business rules, not sampling.

Clamping illegal values into range feels helpful and hides the fact that the model did not understand the constraint. For money, that hide is expensive.

**Decision**: After quorum, run a **pure, deterministic validator** (`validate(snapshot, aggregated_decision)`). Business rules, type checks, provenance equality (`policy_version`). **Reject by default** on violation; escalate. Do not LLM-judge the vote. Do not clamp a vote into legality unless product listed that exact clamp as a rounding rule.

**Consequences**:
- (+) Illegal majority does not hit the ledger.
- (+) Replayable: given stored snapshot + aggregate, anyone can re-run the rules.
- (+) Rules are the right home for "refund cannot exceed order," which should never have been left to sampling.
- (–) Rule tables must be kept in sync with policy. Stale rules are a different incident (false reject or false accept). Version them with `policy_version`.
- (–) Validator rejects will look like "the consistency system is broken" if product expected every vote to ship. They are the system working. Track `validator_reject_rate`; if it is high, the model or the prompt is bad, not the validator.
- **Alternative rejected**: Trust the vote. Cheaper. False.
- **Alternative rejected**: Another LLM call to "check the decision." Not deterministic; not cheaper; correlated errors.
- **Alternative rejected**: Silent clamp of amount to `min(vote, order.amount)`. Changes the decision without a human. Forbidden as default.
- **Revisit trigger**: none for the existence of the validator. Individual rules change with policy.

## ADR-006: Bounded N and Explicit Low-Confidence on Failed Quorum

**Status**: Accepted

**Context**: Without a cap, "they disagreed, sample more" becomes an unbounded bill and an unbounded tail latency. Without a floor, parse failures leave you with N_valid=1 and a unanimous vote that is just sample #1 wearing a costume. Without an explicit failed-quorum path, engineers will pick a winner anyway — first sample, highest logprob, median despite spread — because the user is waiting.

The scenario's honest outcome when the model does not have a mode is **not to invent one**. Product already has a `requires_human` concept on this kind of route. Use it.

**Decision**:
- N is a **route cap**. The sampler does not add extra draws because of disagreement.
- Quorum requires `N_valid >= N_min` and every gated field meeting its threshold. Ties fail. Money-field dissent fails by default.
- Failed quorum (or validator reject) terminates as **`low_confidence` / `requires_human`**. The client is told. No refund amount is shipped to execute. **No silent pick of sample #1.**
- Majority-of-1 is forbidden regardless of how confident that one sample's logits look.

**Consequences**:
- (+) Cost and latency are bounded by N (plus one optional expression call).
- (+) Disagreement is visible in product, not only in logs.
- (+) `low_confidence` rate is a health metric: high means schema/prompt/model unfit, or the questions are genuinely ambiguous (both are useful facts).
- (–) Users get escalations instead of fluent guesses. Product must staff that or accept a worse single-sample bot. There is no third thing that is both fluent and honest under disagreement.
- (–) Support load may rise vs. the lying-fluent bot. That is a cost of honesty.
- **Alternative rejected**: Unbounded resample until agreement. Bill and latency unbounded; still not correctness.
- **Alternative rejected**: Silent sample #1. The entire ensemble was theatre.
- **Alternative rejected**: Hash(request_id) to break ties. Deterministic, still arbitrary, still ships a coin flip. Honesty requires not shipping.
- **Revisit trigger**: a route where "say something" is better than escalate (pure chat). Then this project should not apply; use one sample.

## ADR-007: Continuous Consistency Measurement as a Production Metric

**Status**: Accepted

**Context**: Self-consistency is easy to demo on ten handwritten prompts. Production mix drifts: new policy versions, seasonal order shapes, prompt edits, model swaps, provider-side decoding changes. An agreement rate measured once in a notebook is not an SLO. Without production metrics, the team will learn the ensemble "stopped working" from refund-mismatch tickets, which is the expensive detector.

Prose variation must **not** be a metric that pages. If it is, the team will set T=0 to silence the pager and violate ADR-003.

**Decision**: Treat **per-field agreement rate**, **quorum-failure rate**, **validator-reject rate**, **parse-fail rate**, **realized N token multiplier**, and **fan-out latency** as first-class production metrics per route. Alert on SLO burn for agreement and on cost/latency burn. Persist ensemble runs for money-shaped routes so a single decision is auditable. Do not alert on expression differences.

**Consequences**:
- (+) "We are consistent" has a number. Phase 3 tunes N against that number instead of folklore.
- (+) Parse-fail alerts catch provider/schema regressions before quorum collapses into low_confidence storms.
- (+) Cost multiplier is visible; N cannot creep in a config PR unnoticed.
- (–) Telemetry and audit storage are real work. Skipping them ships a science fair.
- (–) An SLO below 100% must be signed by product. If they refuse to sign anything but 100%, this design cannot help — they want T=0 or a cache. Kill criterion.
- **Alternative rejected**: One-time offline eval as the only proof. Stale by next model swap.
- **Alternative rejected**: Logging prose only. Cannot reconstruct a vote; cannot compute agreement without re-parsing.
- **Revisit trigger**: none. If you cannot measure it, you are not operating this architecture; you are hoping.
