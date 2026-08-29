# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone wraps every prompt in a "context engine."

The expected clever answer is: **treat the token budget as a resource-allocation problem with pinned vs evictable tenants, pluggable reduction strategies, and measurement of cost vs quality.** Those words are correct. They are not a small library, they do not make truncation lossless, and they do not make summarization free. Passing the interview by shipping `concat` plus `text[:N]` plus `len/4` is capitulation. Passing it by making every overflow an extra LLM summarize call is capitulation the other way. This page is the cost of doing neither.

## 1. What I would build

A **priority-tiered iterative allocator**, in-process, deterministic until someone opts into Summarize.

- **Pins vs evictable**, caller-declared, ImpossibleBudget when pins will not fit. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Real tokenizer adapters**, safety margin, re-count after every pass and after serialize. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Strategies as plugins**: Truncate at structure grains, Drop, RelevancePrioritize if scores exist. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Bounded shrink loop + hard-drop**, not `while True` and not a single fictional compression ratio. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Orderer** as a separate policy from eviction. [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Telemetry + external scoring hook.** No built-in judge. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Summarize off by default**; if ever on, one bounded call, fallback, no silent chain. [ADR-007](./04_architecture_decision_records.md#adr-007).
- **Re-assemble each agent round**, because history grew. One assemble at the start of a tool loop is the old bug.

I would not use `chars/4` as the budget. I would not tail-slice a mashed string. I would not summarize pinned instructions to "make it fit." I would not ship a second model to grade assemblies. I would not fill 128k because the window exists — I would want a `target_input` cost cap as soon as finance cares.

If Phase 0 shows **overflow ≈ 0** and input-token cost is not a problem, this whole system is overkill. Ship a length assertion against the adapter and stop. The clever answer is for when parts **vary**, windows **bite**, or the bill **tracks leftover RAG**.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Exact agreement with the provider's token count at the last token.** Margin exists because adapters and wrappers lie a little. Anyone who needs bit-exact pre-flight accounting wants the provider's own counter on the critical path, with its latency, or they want to live with 400s. We pick margin + incident-on-residual-400.

**"Quality-preserving" truncation or summarization as a type.** Truncate is semantically blind (except grain). Summarize is lossy and non-deterministic. RelevancePrioritize is as good as the ranker. The library preserves **pins** and **budget**. It does not preserve meaning. Meaning is an eval.

**Free, instant compression.** Summarize costs a generation *before* the generation the user wanted, and can cost more than keeping the extra tokens. If that is surprising, the strategy was sold as magic.

**Deterministic assemblies once Summarize is on.** Replay requires storing summaries. Tests that assert exact prompts must disable Summarize or freeze summary fixtures.

**A single correct ordering for every model.** Lost-in-the-middle is real enough to not use dict order, not real enough to tattoo one layout on the company.

**A built-in score for "this context is good."** Cosine and LLM judges will be offered. They measure the wrong thing or they duplicate the task model.

**Application-level prompt cache as v1.** Identical prefixes may get **vendor** prefix-cache discounts. Building our own assembled-prompt cache reintroduces staleness for RAG and history. Different ADR.

**Using the advertised window as the budget.** Output reserve and margin eat tokens. Packing "to 128k" is how completions 400 and bills peak.

**Inference of what matters.** If product will not sign pins vs evictable, the library will not guess. Guessing is the concat-tail bug with extra steps.

**Solving retrieval.** Garbage chunks in, well-allocated garbage out. Top-k belongs in the retriever.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence is not "they meant drop history first."

Ask product / route owners:

1. **If we must delete tokens, what disappearing would be an incident?** Those are pins (system, query, usually tools here). If the list is "nothing, just fit," they want a trimmer — make them take ImpossibleBudget off the table in writing, including sliced instructions.
2. **Among evictable parts, what is the priority order?** History vs RAG vs few-shots is a product call. Expected: "keep as much as possible." That is not an order. Force a ranking.
3. **Is a cost cap (`target_input`) below the window required?** If no, you will fill the window and pay for it. If yes, the same loop, tighter number.
4. **Will you staff evals** so "strategy A vs B" has a quality number? If no, we can still stop 400s; we cannot honestly tune Summarize vs Truncate.

Ask engineering:

5. **Which `model_id`s are real, and which tokenizers match production wrappers?** If they plan to swap to a cheap 8k/32k model next quarter, Phase 0 measures **that** window, not only 128k.
6. **Does the agent re-assemble every tool round?** If they assemble once and then append tool results unbounded, this library is a sticker on a leak.
7. **Who owns the relevance scores?** If "the assembler will embed," that is a no. If the retriever already scores, RelevancePrioritize is cheap.

Ask finance / platform:

8. **Is summarizer spend allowed on the hot path?** Show them: overflow_rate × (summarizer input+output $ + latency). Often worse than Truncate.

What I would **not** ask for: a learned compressor, a context-gateway microservice, a vector DB, Kubernetes for the allocator, an LLM judge. Those asks spend calendar that belongs to tokenizer truth and the pin fight.

## 4. Complexity inventory (what those clever words cost)

| You take on | You shed |
| --- | --- |
| Pin/evict policy fight per route | The fantasy that concat-and-slice is context engineering |
| Per-model tokenizer adapters + wrapper accounting | `chars/4` and surprise 400s (you get residual 400s as incidents instead) |
| Re-count-after-every-pass discipline | Trusting a summarizer's claimed length |
| Bounded loop + hard-drop | Unbounded summarize-until-fit |
| Structure-aware Truncate grains | Mid-JSON tail cuts |
| Orderer as a second policy | Accidental mash order |
| Telemetry + someone else's evals | "Quality-preserving" as a slogan |
| ImpossibleBudget as a user-visible/ops failure | Silent instruction amputation |
| Optional Summarize as a *product* flag with a bill | Hidden second model on every fat prompt |
| Re-assemble each agent round | One-shot pack that slowly explodes over tools |

Net: **more parts, in the right places.** The naive design is simple *and either 400s or silently ruins the prompt.* The clever design satisfies a **bounded** reading of "assemble under a budget" and still cannot promise quality or exact provider counts. The interview is whether you name that bound.

### What is not worth building

- A company-wide context microservice that intercepts every prompt without a pin policy.
- An in-library embedder / reranker.
- LLM-as-judge quality inside the assembler.
- Learned token-pruning as v1 core.
- Summary-of-summary chains.
- `target_input = window` forever because "the model can take it."
- Caching assemblies across users or tickets "for speed."

## 5. When I would not do this

- **Static small templates** that always sit at 2k on a 128k model and are not a cost problem. Length check. Stop.
- **One part, already sized.** There is nothing to allocate.
- **Product refuses to name pins** and also refuses ImpossibleBudget. They want silent trim. Do not launder that through a library with a README about memory management.
- **No tokenizer you can actually match**, and they will not let you fail closed. Then you cannot honestly claim a hard budget.
- **The only pain is retrieval quality.** Fix top-k and chunking. An allocator will only decide *which* bad chunks to keep.
- **QPS is a firehose and someone wants Summarize on every call.** The compressor becomes the product. Use Truncate/Drop/pre-caps, or a batch-offline compressor with different SLAs — not this hot-path design.

When I **would** do this: a route with **heterogeneous, variable-size parts**, a **real** chance of overflow or of wasting a fat-prompt tax, a **signed** pin policy, and (if you want strategy claims) **evals**. Then a tiered allocator is the design, and this document is the bill.

## 6. Pushing back on the brief (the actual interview)

The prompt is constructed so you either **build a trimmer**, **build a summarizer**, or **frame allocation**. This project is the third, with the pushback stated:

1. **Fitting is not helping.** Overflow rate is a necessary metric and a gameable one. Quality lives outside the library.
2. **Priority is not a default the library gets to pick.** If they will not sign it, there is no architecture, only `[:N]`.
3. **Summarize is not compression in the OS sense.** It is another model call. Opt-in, or you have not designed an assembler; you have designed a pipeline.
4. **Token counting is part of the architecture**, not a detail. `chars/4` is how you fail the hard-budget requirement while sounding quantitative.
5. **128k does not cancel the problem.** Cost, smaller fallback models, and tool-loop growth all still bite.

Capitulation looks like: `prompt[:max_chars]`, `tokens = len/4`, `if too_long: summarize(history)` with no cap, or dropping the system prompt because it was last in the join. Call those by name in review.

## 7. Brutal summary

You cannot have every part, verbatim, in every call, under a hard budget, with lossless meaning, counted for free, compressed for free, ordered perfectly for every model, and scored for quality by the same library that packed the string.

What you can have is: **pins that never silently die, evictable tenants that shrink by a declared loss function in a loop that always halts, a real tokenizer plus margin, placement as a named policy, cost you can see, and quality if — and only if — the route already knows how to score answers.**

That is context engineering as resource allocation. It is the right clever answer. It does not make truncate kind. It does not make summarize cheap. It does not make the 128k window a personality.

If the prompt always fits and the bill is fine, do not allocate — assert length. If they need lossless everything, they need a bigger window or fewer parts, not a library. If they will not measure quality, you may still stop 400s; do not pretend the strategy bake-off happened. Say that before you add a summarizer to the hot path and call it memory management.
