# Context Assembler (context-forge): Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

You must design a **library** that assembles the final context window from parts — system prompt, retrieved chunks, chat history, tool schemas, few-shot examples — under a **hard token budget**, with pluggable reduction strategies (truncate, summarize, prioritize-by-relevance).

The design must answer, concretely:

1. What "fits" is allowed to mean, once "concatenate everything and hope" is off the table.
2. How the budget is counted so the assembled prompt actually survives the provider's tokenizer — not a `chars/4` guess that overflows at the API, or a conservative guess that silently discards useful context every call.
3. Which parts are allowed to shrink or die, and who decides that (the library cannot know).
4. What happens when reduction still does not fit, and why silently truncating the tail of the concatenated string is not an architecture.
5. How ordering in the assembled prompt is decided separately from *what survived*, because the model does not attend uniformly.
6. What is measured so "this strategy is better" is a cost and quality delta, not a blog-post claim.

This is the **context-as-string-trimming trap**. The naive answers — `concat` then slice, estimate tokens as `len(text)/4`, always drop chat history first, always summarize until it fits, treat "it compiled into a prompt under the limit" as success — are the failure. They either overflow the real window, silently destroy the system prompt, pay an extra LLM call to compress something that should have been dropped, or ship a prompt that fits and answers worse.

The correct shape is: **the token budget is a scarce resource allocated across heterogeneous tenants; pinned parts never silently die; evictable parts shrink via a declared strategy in a bounded loop; leftover overflow is a deterministic hard-drop, not another summarizer call; placement is a separate policy; quality is measured outside the library.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true without pretending token counting is free, summarization is compression, or fitting equals helping.

## The Trap, Stated Directly

"Just assemble the context" in a product conversation is almost always used as if it meant **put everything the model might need into the prompt, up to the model's advertised window.** That is not assembly. That is packing a suitcase by sitting on it. The window is a hard ceiling *minus output reserve minus tokenizer slack*. The parts are not equal. The model is not a uniform reader of a byte array.

Those are independent systems of meaning:

| What people hear | What the constraint actually protects |
| --- | --- |
| "Assemble the context" | Usually: do not overflow. Rarely: do not drop the instructions. Almost never: measure whether the remaining tokens still answer the question. |
| "Hard token budget" | Input tokens **plus** reserved output **plus** a safety margin against tokenizer/provider mismatch. Not: the brochure context length. |
| "Truncate / summarize / prioritize" | Three *different* loss functions with different cost, latency, and failure modes. Not: three names for `text[:N]`. |
| "The 128k window will hold it" | A hope. Multi-turn tool results, RAG dumps, and "paste the PDF" fill 128k. Smaller/cheaper models fill at 8k. Cost fills even when the window does not. |
| "Summarize the extra bits" | An extra billed, latent, non-deterministic LLM call whose output token count is unknown until it returns — and which can drop the one fact the answer needed. |

The load-bearing distinctions:

| What people think they asked for | What they can actually have |
| --- | --- |
| A prompt that always contains every part, verbatim | No. The budget is a ceiling. Claiming this is how you overflow or you have no budget. |
| A prompt that always contains the *pinned* parts, verbatim | Yes, or a loud **impossible-budget** failure. Never a silent chop of the system prompt. |
| Cheap, deterministic fitting | Yes, via truncate and drop, with acknowledged semantic blindness. |
| "Quality-preserving" compression | No, not as a library guarantee. Summarize and relevance-rank can *sometimes* preserve the answer; that is an eval result, not a type. |
| One default priority order that is correct for every route | No. Priority is a caller/product policy. The library that guesses "history is always least important" will delete the constraint the user stated three turns ago. |
| A built-in judge of answer quality | No. Quality is task-defined. The library emits telemetry and a scoring hook. It does not ship a second model to grade itself. |

Capitulating to `chars/4` is how you pass the demo and 400 at the provider. Capitulating to "always summarize" is how you pass it by adding a hidden generation to every oversized request. Treating "it fitted" as "it worked" is how you ship a support agent that no longer sees the refund tool schema because the schema was at the end of the concat.

## Current State (Assumed Starting Point)

A typical first version of "just stuff the prompt" looks like:

1. Request arrives. The handler fetches RAG chunks (top-20), loads the last N chat turns (or "all of them"), serializes every tool schema the agent was given, prepends a system prompt and two few-shots, appends the user query.
2. Token count is `len(text) // 4`, or is skipped because "the model is 128k."
3. If someone added a length check, it slices from the **end** of the concatenated string — or from the start, which is worse — with no regard for part boundaries. A tool JSON is cut in half. A system-prompt sentence ends mid-word. The last RAG chunk survives because it was prepended; the user query is dropped because it was appended. Or the reverse, depending on who wrote `prompt[:budget]`.
4. The provider rejects with a context-length error, or accepts and the model ignores the middle 40k tokens, or accepts and the model never sees the tool it needed.
5. Someone files a ticket. Engineering "fixes" it by summarizing the chat history with another model call on every request. Latency doubles. The summary drops the SKU the user mentioned in turn 4. Cost goes up. The overflow rate goes down. Product calls it context engineering.

That version will appear to work in a demo: one short chat, five RAG chunks, two tools, a 128k model. It will fail in production the first time:

- a long support thread plus a PDF-sized retrieval set overflows a 32k (or 8k) model the cost team switched to,
- the silent tail-slice removes the current user query or the system prompt,
- the summarizer is invoked on every hot path because the naive concat is *always* over a budget that was never measured against real traffic,
- two strategies (truncate history vs drop extra RAG chunks) are never compared, so nobody knows which one kept answer quality,
- on-call debugs "the agent forgot it can refund" and finds the tool schema was evicted because it had no pin.

This project documents the replacement, not a patch of that `join` plus `[:N]`.

## The Memory-Management Analogy (and where it breaks)

The useful analogy: **the token budget is RAM; assembly is allocation under pressure.**

| OS concept | Context-forge analogue |
| --- | --- |
| Physical RAM | Hard token budget (window − output reserve − safety margin) |
| Kernel / locked pages | Pinned parts (system prompt, current query, often tool schemas) |
| User processes | Evictable parts (old turns, extra chunks, extra few-shots) |
| OOM killer heuristic | Caller-declared priority among evictable tenants |
| Truncate a heap | Truncate a part (cheap, semantically blind) |
| Compress then reclaim | Summarize a part (expensive I/O analogue: an LLM call) |
| Kill a process | Drop a part |
| Page placement / NUMA | Assembly order (lost-in-the-middle: some positions are worse) |
| Panic when kernel will not fit | Impossible-budget failure (pinned floor > budget) |

Where the analogy **breaks** — and the design must not pretend otherwise:

- **Bytes of RAM are fungible; tokens are not.** The 200th token of a tool schema and the 200th token of a stale RAG chunk do not have the same value. An allocator that treats them as a flat pool will make the wrong eviction.
- **Compression here is slower and more expensive than keeping the original**, and is non-deterministic. OS compression is a CPU/memory trade. Summarization is a money/latency/correctness trade. Defaulting to it is how a "budget assembler" becomes a hidden second model.
- **The consumer has position-dependent attention.** Surviving eviction is not the same as being read. Placement is a second policy.
- **Counting occupancy is not `sizeof`.** Tokenizers differ by model and by provider; the provider's billed count can still disagree with a local tokenizer. A safety margin is not optional fussiness.
- **Fitness is not success.** A process that fits in RAM can still be the wrong process. A prompt that fits can still answer worse than a smaller, better-chosen prompt. The library cannot score that itself.

Use the analogy to explain *allocation*. Do not use it to imply the problem is solved because operating systems solved paging.

## Concrete Route Used Throughout These Docs

One product-shaped example, so the sequences are not abstract. The architecture is the same if the parts are "policy PDF + ticket thread" or "codebase chunks + compiler errors"; only the part types and pins change.

**Route: `agent.answer_with_tools`.** A support-facing agent: RAG-grounded, tool-calling, multi-turn. It must answer from retrieved policy/order snippets, may call tools (order lookup, refund, ticket update), and must follow a system prompt that includes policy version and non-negotiable refusals.

Working budget math (illustrative, **not** a quote of any vendor; Phase 0 replaces the numbers with the actual model):

| Quantity | Working figure | Notes |
| --- | --- | --- |
| Advertised context window | 128,000 tokens | Brochure number. Not the budget. |
| Reserved for model output + tool-call payload | 4,000 | If you do not reserve this, a long completion or a fat tool call is a 400. Multi-round agents need this *per round* against a growing history. |
| Safety margin vs tokenizer/provider mismatch | 2% of remaining ≈ 2,480 | `chars/4` can drift 15–30%+; even a real tokenizer disagrees at the edges (special tokens, message wrappers, tool-call framing). |
| **Usable input budget** | ≈ 121,520 | This is `BudgetSpec.input_limit`. The assembler never "uses the full 128k." |

Typical parts on this route (sizes are order-of-magnitude, from a messy real session — not the demo):

| Part | Typical tokens | Pin? | If you get this wrong |
| --- | --- | --- | --- |
| System prompt | ~2,000 | **Pinned** | Agent ignores policy, leaks, or "forgets" refusals. |
| Tool schemas (8 tools) | ~3,000 | **Pinned** (default on this route) | Silent drop of `refund` is an incident, not a compression win. |
| Current user query | ~200 | **Pinned** | You answered a question nobody asked. |
| Few-shot examples (3) | ~4,000 | Evictable, high priority | Quality cliff if all three vanish; often better to keep 1 than to truncate all 3 mid-example. |
| Retrieved chunks (top-20) | ~15,000 | Evictable | Stale or low-relevance chunks are the cheapest sacrifice *if a relevance signal exists*. |
| Chat history (long thread + prior tool results) | 5,000–50,000+ | Evictable | Dropping the turn that contained the order id is how the next tool call hallucinates one. |

On a **32k** model (the one finance will switch you to), the same parts do not "mostly fit." On an **8k** model they do not fit at all. The architecture does not change with the window; the pin/evict policy and the overflow *frequency* do. Cost is proportional to input tokens even when 128k has room — assembling "because we can" is how a cheap question costs a fat-prompt tax.

A genuinely static template ("one system prompt, one user string, always under 2k") is **out of this route**. It has no allocation problem. A length check is enough. See Non-Goals and [Trade-offs](./05_tradeoffs_and_honest_assessment.md).

## Target Users

- **Library integrator**: wires parts into the assembler per route; needs a pin/evict contract they can defend when on-call asks why the refund tool is still present and turn 17 is gone.
- **ML / product engineer**: tunes quality vs cost; needs strategy-level telemetry and a scoring hook, not a claim that summarization "preserves meaning."
- **On-call**: debugging a truncated-system-prompt incident or a context-length 400. Needs `AssemblyResult` to show what was counted, what was reduced, what was hard-dropped, and whether the failure was impossible-budget.
- **Platform / cost owner**: sees input-token spend as a function of assembly policy, not as weather. Needs to know that turning on Summarize adds a second model call, not just "smaller prompts."
- **The end user / agent**: never sees the assembler. Sees answers that still have the instructions and the facts that were supposed to survive.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which embedding model retrieves chunks, the system-prompt wording, the tool list) are out of scope.

1. **Parts are tiered: pinned vs evictable, with caller-declared priority among the evictable.** The library does not infer that tool schemas beat chat history. A missing pin policy is a Phase 0 fail, not a default of "truncate from the end." See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Token counting uses a per-model tokenizer adapter plus a safety margin, and is re-run after every reduction.** `chars/4` is forbidden as the budget authority. Unknown target model → fail closed, do not guess. See [ADR-002](./04_architecture_decision_records.md#adr-002).
3. **Reduction is a pluggable per-part-type strategy interface.** Truncate, Summarize, RelevancePrioritize, and Drop are strategies the allocator invokes; they are not the allocator. See [ADR-003](./04_architecture_decision_records.md#adr-003).
4. **Fitting is a bounded shrink-until-fits loop with a deterministic hard-drop fallback.** Unbounded "keep summarizing until it fits" is forbidden. A single-pass "allocate percentages and hope the summary lands on budget" is insufficient because a summary's token count is unknown until it exists. See [ADR-004](./04_architecture_decision_records.md#adr-004).
5. **Assembly order is a separate policy from eviction priority.** Lost-in-the-middle is real enough to not use arrival order as placement. Surviving is not the same as being attended to. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. **Quality and cost effects are measured via telemetry plus an external scoring hook.** The library does not ship a quality judge. "This strategy is better" is an eval against the route's scorer. See [ADR-006](./04_architecture_decision_records.md#adr-006).
7. **Summarization is opt-in, budgeted as its own LLM call, and never a silent default or an unbounded chain.** Summary-of-summary requires an explicit decision. Summarize-fail does not become truncate-without-logging. See [ADR-007](./04_architecture_decision_records.md#adr-007).

## Success Criteria for the Design (Not Implementation Metrics)

1. Same parts, same `BudgetSpec`, same tokenizer adapter, **no Summarize strategy**: two assembler runs produce the **same** assembled prompt and the same `AssemblyResult` (deterministic). Tests that fail this with Truncate/Drop only are wrong tests of a different, non-deterministic design.
2. Pinned parts are present **verbatim** in the output, or the assembler returns **impossible-budget** and produces no prompt. There is no path that emits a prompt with a sliced system prompt "to be helpful."
3. Over-budget evictable parts are reduced only by their declared strategy, in priority order, with a **hard cap** on shrink-loop passes. After the cap, remaining overflow is hard-drop by priority, then impossible-budget if pins still do not fit (they should have failed earlier — this is belt and suspenders).
4. Token count of the emitted prompt, as measured by the same adapter, is `<= input_limit`. "We estimated it would fit" is not a success. Re-count after every pass is required; a design that counts once at the start will fail this the first time truncation boundaries or summarizer output surprise it.
5. Provider 400s for context length on this route, after a correctly configured adapter + margin, are treated as **tokenizer-drift incidents** (tighten margin or fix the adapter), not as "the assembler should have sliced more aggressively in the dark."
6. Enabling Summarize is a flag, not a default. When it is on, telemetry shows summarization call count, latency, token cost, and fail-over-to-truncate/drop. A hidden second generation is a failed design.
7. A scoring hook can be pointed at two strategies on the same traffic (shadow or A/B) and produce a **cost delta and a quality delta**. If the only metric is "overflow rate went to zero," the design has optimized the wrong thing — drop-everything also zeros overflow.
8. Impossible-budget, summarizer timeout, and unknown-tokenizer are **loud, typed failures**, not truncated prompts.

## Business Rules (Assembly-Scoped)

1. The usable budget is `window - output_reserve - safety_margin`, never the advertised window. Changing `output_reserve` without re-measuring multi-round tool payloads is a production bug.
2. Pin vs evict is a **route policy** signed in Phase 0. The library may provide an example policy for `agent.answer_with_tools`; it may not silently apply that example to every caller.
3. Tool schemas on this route default to pinned. Unpinning a tool is an explicit policy change, not an overflow side effect.
4. Current user query is pinned. Truncating the query to "make room for more RAG" is forbidden.
5. Strategies must not rewrite pinned parts. A summarizer that "helpfully" compresses the system prompt is a bug, not a feature.
6. Cross-request caching of assembled prompts is **not v1**. Identical parts may hash to a cache key later; that is a different ADR. Default is: every call assembles. Vendor prefix-cache of identical prefixes is their billing optimization, not this library's cache.
7. The assembler does not retrieve, embed, or rank. If RelevancePrioritize is used, the **ranking signal is an input** (scores already on chunks). Inventing a ranker inside the library recreates a RAG system in the wrong place.

## Non-Goals

- **Not a retriever, embedder, or reranker.** Chunks arrive with optional scores. If they do not, RelevancePrioritize is unavailable; Truncate/Drop still work.
- **Not a tokenizer implementation.** Adapters wrap an existing tokenizer for the target model. Shipping "our own BPE" is out of scope.
- **Not an eval framework.** The scoring hook is a callback. Golden sets, judges, and dashboards live with the route owner. See [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Not a prompt-compression research reimplementation.** LLMLingua-style learned compressors, extractive token pruning, and paper-quality "10x compression at 95% quality" claims are out of v1. If Phase 4 wants a fourth strategy, it is a plugin, not a rewrite of the allocator.
- **Not a built-in quality judge.** A second LLM that scores the assembly is the same design smell as a second LLM that judges an ensemble. Telemetry in, scorer out.
- **Not a guarantee that fitting preserves answer quality.** Truncate can split a fact. Summarize can drop it. Drop can remove it. The honest product is *controlled loss* plus measurement.
- **Not a cross-request prompt cache in v1.** See Business Rules.
- **Not a solution for prompts that always fit.** If Phase 0 shows overflow is ~0 and input-token cost is not a problem, you needed a length assertion, not this library. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not an implementation.** No Python/TS assembler, no tiktoken wrapper, no summarizer client. Numbered steps and diagrams only.
- **Not a claim that this is small.** A correct Truncate+Drop loop is a few hundred lines. The actual cost is tokenizer truth, pin policy fights, ordering, telemetry, and (if you turn it on) a second model on the hot path. The interview is whether you name that, not whether you can `join` strings.
