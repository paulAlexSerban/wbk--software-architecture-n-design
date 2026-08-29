# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Tiered Pinned vs Evictable Allocation (No Flat Token Pool)

**Status**: Accepted

**Context**: A hard token budget invites a flat allocator: one pool, shave from the concatenated string or from the largest part until the number fits. That is how operating systems would treat anonymous pages. Context parts are not anonymous pages. The system prompt, the current query, and (on `agent.answer_with_tools`) the tool schemas have a different failure mode than "one more RAG chunk." Silently trimming them produces a prompt that **fits and is wrong in a way the model will not report**.

Callers and library authors both want a default: "history goes first, it is the least important." That default is sometimes right and often a production incident (the order id was in turn 4; the refund tool was "just another JSON blob at the end of the concat"). The library cannot know. A guessed default is an unstated product decision.

A single truncation point (the tail of the mash) also ignores part **boundaries**: half a tool schema is worse than no extra few-shot.

**Decision**: Every part is **pinned** or **evictable**. Pinned parts are allocated first; if `pinned_floor > working_limit`, the assembler returns **ImpossibleBudget** and emits **no prompt**. Evictable parts consume the remainder under caller-declared **priority** (higher = kept longer). The library ships an **example** `TierPolicy` for the running route; it does not infer pins from type-size heuristics, and it does not apply that example unless the route binds it.

**Consequences**:
- (+) Instruction and query loss become a loud failure or an explicit unpin, not a silent slice.
- (+) Priority is reviewable policy, not an accident of concat order.
- (–) Phase 0 must actually name pins. Teams that refuse will ask for "just truncate the end." That request is this ADR's rejected alternative.
- (–) Impossible-budget will happen when someone inflates the system prompt past a small-window model. That is a prompt-size incident, correctly.
- **Alternative rejected**: Flat pool + tail truncate of the concatenated prompt. Cheap. Destroys whatever was last. Famous in every tutorial. Forbidden.
- **Alternative rejected**: Always evict history first, globally. A hidden policy. Wrong for many routes.
- **Alternative rejected**: Learned importance scorer inside the library. Moves the problem into an opaque model; no v1.
- **Revisit trigger**: a route where *everything* is equally droppable (pure playground concat). Then this library is overkill; a length check suffices. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## ADR-002: Per-Model Tokenizer Adapters, Safety Margin, Re-Count After Every Reduction

**Status**: Accepted

**Context**: Provider context limits and bills are in **tokens**, not characters. The folklore estimator `len(text)/4` drifts badly on JSON, code, and chat wrappers — often 15–30%+, enough to 400 a "tight" pack or to over-evict. Different models use different tokenizers. The same string is a different occupancy on model A vs model B. Message templates and tool framing add tokens that inner-string counts miss.

Counting once at the start, then trusting Truncate/Summarize to have produced the claimed size, fails because (1) truncation grains are whole turns/chunks, not exact token knives, and (2) summarizers lie about length.

Unknown model + "use cl100k anyway" is how CI passes on a tokenizer the production model does not speak.

**Decision**:
- Token counts that gate the budget come **only** from a **per-`model_id` adapter** (official tokenizer + documented wrapper overhead).
- `working_limit` includes a **safety margin** against residual provider disagreement.
- **Re-count** after every reduction pass, after hard-drop, and after final serialize. Adapter is authority; strategy `claimed_tokens` is telemetry.
- Missing adapter → **fail closed** (`UnknownTokenizer`). `chars/4` may be logged as a drift metric, never as the gate.

**Consequences**:
- (+) Fit means "our best local model of the provider's count," not a folk formula.
- (+) Residual 400s become adapter/margin incidents, not "the assembler should have guessed lower."
- (–) Each supported model is an engineering artifact. "We added a model" is not a one-line config if the tokenizer is new.
- (–) Margin over-evicts. Phase 0 must measure; a lazy 20% margin is a quality bug.
- **Alternative rejected**: `chars/4` (or any fixed chars-per-token) as authority. Demo-friendly. Production-hostile.
- **Alternative rejected**: Count once, trust claimed sizes. Fails on grains and summarizers.
- **Alternative rejected**: Remote tokenize API on the hot path. Extra RTT, extra failure mode, sometimes extra bill.
- **Alternative rejected**: Use the advertised window with no output reserve and no margin. Packs that 400 on long completions or wrapper tokens.
- **Revisit trigger**: a provider that returns exact pre-flight token counts you can trust. Still keep output reserve; still fail closed on unknown models.

## ADR-003: Pluggable Per-Part-Type Strategy Interface

**Status**: Accepted

**Context**: "Truncate, summarize, or prioritize-by-relevance" are not three knobs on one function. They have different inputs (scores vs not), different costs (CPU vs an LLM call), different determinism, and different failure modes (split facts vs dropped facts vs ranker errors). Baking one of them into the allocator core ("the library is a summarizer") makes the other two awkward and makes the default expensive.

Different part types need different **grains** even under the same strategy name (oldest turns vs whole chunks vs whole few-shots). That grain belongs with the strategy+type, not with a generic `text[:N]`.

**Decision**: The allocator is **strategy-agnostic**. A registry maps `(part, policy) → strategy`. v1 strategies: **Truncate**, **Drop**, **RelevancePrioritize** (requires scores), **Summarize** (opt-in, [ADR-007](#adr-007)). Each strategy returns a reduced part or a tombstone; it does not select the next victim and does not re-enter planning. Type-specific grains are specified in [System Design](./03_system_design.md#4-strategy-interface).

**Consequences**:
- (+) New loss functions (a future compressor plugin) do not fork the loop.
- (+) Truncate+Drop can ship without a summarizer or a ranker.
- (–) Integrators must declare a strategy per type. "Do something smart" is not a strategy.
- (–) RelevancePrioritize without a real ranker is Truncate in costume; the collector refuses missing scores rather than inventing them.
- **Alternative rejected**: One built-in algorithm (always summarize history, always drop RAG). Policy masquerading as code.
- **Alternative rejected**: `text[:N]` as the only truncate grain. Corrupts JSON and splits facts.
- **Alternative rejected**: Library-owned embedder for "priority." Wrong layer; recreates RAG.
- **Revisit trigger**: a learned compressor as a **plugin** strategy after Phase 3 measurement. Not a rewrite of ADR-003.

## ADR-004: Bounded Shrink-Until-Fits Loop with Deterministic Hard-Drop Fallback

**Status**: Accepted

**Context**: Summarize (and even whole-turn Truncate) does not produce a known occupancy until after the fact. A single-pass "give each tenant a percentage of the remainder" therefore either undershoots (still over budget) or must assume compression ratios that are fiction.

The other attractor is `while over_budget: summarize_again()`. That is unbounded cost, unbounded latency, and summary-of-summary loss. It is the same trap as unbounded resampling in other systems in this workbook.

If the loop gives up by slicing whatever is left — including pins — the pin invariant is theater.

**Decision**:
- Reduce in a **bounded** loop (`max_passes`, working 8). Each pass: pick lowest-priority evictable victim, apply its strategy with an aggressive target (try to close the deficit), **re-count**.
- If still over: **hard-drop** whole remaining evictable parts by priority until fit or only pins remain.
- If only pins remain and still over: **ImpossibleBudget**, no prompt.
- No unbounded re-summarize. No single-pass-only design as the sole path (a Truncate-only equivalent fast path is allowed if observable survivors match).

**Consequences**:
- (+) Termination is guaranteed. Finite parts, bounded passes, then drops.
- (+) Unknown summary size is handled without fiction ratios.
- (–) Aggressive deficit targeting can delete an entire history blob in one pass when a shave would have fitted. That is the cost of convergence; tune grain, not `while True`.
- (–) `max_passes` too low → more hard-drops (usually fine). Too high + Summarize on → more LLM calls. Keep Summarize off until Phase 3.
- **Alternative rejected**: Unbounded summarize-until-fit. Bill and tail latency unbounded; compounding loss.
- **Alternative rejected**: Single-pass percentage allocation only. Cannot know summary tokens; under-counts wrappers.
- **Alternative rejected**: "If still over, truncate the serialized string from the end." Pin-breaking.
- **Revisit trigger**: none for the bound. Individual `max_passes` values are route config.

## ADR-005: Assembly Order Independent of Eviction Priority

**Status**: Accepted

**Context**: Priority answers *who survives*. Concat order in naive clients is *fetch order* or *eviction order* (whatever was reduced last sits last). Models do not attend uniformly across long contexts; "lost in the middle" is documented enough to forbid treating serialization as an accident.

Putting tools after 40k tokens of RAG, or putting the query somewhere other than the user slot, is a different bug than dropping those parts. A library that only evicts and then `join`s in map iteration order has done half the job.

There is **no universally optimal layout**. Claiming one is a blog post. Making layout a **named policy** is the architecture.

**Decision**: After the survivor set is known, an **Orderer** applies an explicit placement policy. Working default for `agent.answer_with_tools` is specified in [System Design](./03_system_design.md#6-ordering-placement) (system and tools first; recency/relevance toward the query; query last; history chronological among survivors). Eviction sequence is not the serialization sequence. After serialize, **count again**; residual overflow hard-drops evictable parts, never pins.

**Consequences**:
- (+) Placement can be A/B'd in Phase 2 without changing eviction.
- (+) Wrapper tokens introduced by structure are caught.
- (–) Another policy surface to bikeshed. Phase 2 measurement is the tie-break, not taste.
- (–) Lost-in-the-middle magnitude varies by model; the default may be wrong for the next model. That is a policy swap, not an ADR void.
- **Alternative rejected**: Serialize in eviction order or dict order. Accident.
- **Alternative rejected**: Always put the "most important" (pinned) parts in the middle because a paper said middles are weak — pins still need to be valid **instructions**, typically system-first. Do not bury the system prompt to "protect" it; that is folklore colliding with API structure.
- **Alternative rejected**: One mashed string to "save wrapper tokens." Loses role structure the model was trained on; penny-wise.
- **Revisit trigger**: a model/API that imposes a fixed message shape (tools out-of-band). Then the Orderer maps onto that shape; it does not fight the API.

## ADR-006: Quality and Cost Measurement via Telemetry plus External Scoring Hook (No Built-in Judge)

**Status**: Accepted

**Context**: The prompt asked to "measure the effect of each strategy on cost and answer quality." Cost is almost native (tokens in/out, summarizer calls). Quality is **not**. Correctness on `agent.answer_with_tools` is groundedness, tool choice, policy compliance — owned by the route's evals. A library that ships "quality" as cosine(summary, original) or as an LLM-as-judge call has substituted a convenient metric for the real one, and has added a second model with correlated errors (the same smell as a second model judging an ensemble).

Fit rate is the metric that will be gamed: Drop-everything zeros overflow and destroys the product.

**Decision**: The library **always** emits assembly telemetry (tokens, strategies, drops, summarizer cost/latency, impossible-budget). It exposes a **scoring hook** invoked by the **app after** the user-facing completion, with assembly telemetry + answer + task labels. It does **not** ship a quality model, does not block assemble on a judge, and does not treat embedding similarity of prompts as answer quality.

**Consequences**:
- (+) "Summarize vs Truncate" can be an A/B with **the route's** scorer plus a cost delta.
- (+) Fit is a gate metric; quality is a product metric. Both required to call a strategy "better."
- (–) Phase 2 is blocked on the app actually having evals. If they have none, this library can still prevent 400s; it cannot honestly claim quality wins. Say that.
- (–) Hook misuse (synchronous LLM judge on the hot path) is an app failure mode; document it as forbidden in the integration contract.
- **Alternative rejected**: Built-in LLM judge of assemblies. Cost, latency, false metric.
- **Alternative rejected**: Cosine(summary, source) as quality. Measures extractive overlap, not answer correctness.
- **Alternative rejected**: Optimize only overflow rate. Games to empty prompts.
- **Revisit trigger**: none for "no built-in judge." Additional **telemetry fields** can be added without a new philosophy.

## ADR-007: Summarization Is Opt-In, Budgeted, Non-Deterministic, and Not Silently Chained

**Status**: Accepted

**Context**: Summarize is the strategy people name first because it sounds like lossless-ish compression. It is an **extra LLM call**: latency on the path *before* the user-facing generation, extra bill (often comparable to keeping a moderately oversized part), non-determinism in a layer that otherwise can be a pure function, and a new way to drop the one fact that mattered. Summary-of-summary compounds the loss.

Making it the default reduction — or looping it until fit — turns a budget allocator into a hidden second agent. Tests become flaky. Incidents become "the compressor omitted the SKU."

Temperature 0 on the **summarizer** is allowed (compressor, not the creative user-facing route) and still does not restore cross-provider determinism.

**Decision**:
- Summarize is **off** unless the route enables it on specific evictable types.
- Each invocation is at most **one** call, with timeout, `max_output_tokens` derived from the target, and a **fallback** (working: Truncate) on failure or inflation.
- **No summary-of-summary** unless `allow_summary_of_summary` is explicit (default false).
- Telemetry must show summarizer calls, tokens, latency, fallbacks. A hidden generation is a failed design.
- If summarizer error rate spikes, **disable the strategy** (circuit breaker), do not retry harder.

**Consequences**:
- (+) v1 (Phase 1–2) can be deterministic and cheap.
- (+) When Summarize is on, the bill is visible and killable (Phase 3 gate).
- (–) People will want it on "because context engineering." Phase 3 exists to make them **measure**. If quality delta does not beat Truncate+Drop, it stays off.
- (–) Deterministic replay of production assemblies is false once Summarize is on unless summaries are stored and reused (that storage is a cache of *compressed parts*, not of user-facing answers; still a freshness/policy question — not v1).
- **Alternative rejected**: Summarize as default for any overflow. Hidden second model.
- **Alternative rejected**: Unbounded re-summarize. [ADR-004](#adr-004).
- **Alternative rejected**: Silent fallback to truncate without `fallback_used` in telemetry. Makes Phase 3 unmeasurable.
- **Alternative rejected**: Summarizing pinned parts "a little" to avoid ImpossibleBudget. Pin invariant dies; prompt-size problem is misdiagnosed as an assembly problem.
- **Revisit trigger**: a **CPU-only**, deterministic compressor with measured quality on this route. Then it is a new strategy, still not a reason to mutate pins.
