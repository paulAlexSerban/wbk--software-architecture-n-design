# LLM Gateway: Business Overview
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Product Vision
A single internal HTTP(S) endpoint that five teams call instead of calling OpenAI, Anthropic, and a self-hosted Llama cluster directly. The gateway load-balances, enforces per-team budgets, falls back on provider outage, and caches *where it is safe to cache* — and it does all of that while treating every LLM as **just another flaky backend**, with the extra constraint that a retry costs money and a fallback changes answer quality.

This is not an "AI platform." It is a **cost-and-availability control plane** in front of three generation APIs that the company already uses. Teams keep writing prompts. They stop holding provider keys, stop discovering outages independently, and stop blowing a shared bill that nobody can attribute.

## Business Context
- **Current state**: five internal teams each hold (or share) provider credentials, each pick models ad hoc, each retry in their own client, and the finance team finds out about spend when the monthly invoice arrives. There is no per-team budget, no shared cache, no coordinated fallback. A OpenAI incident is five independent outages, not one.
- **Why this exists now**: someone got a shocking bill. That is the actual forcing function. Availability and "we should cache" are the secondary justifications that get attached afterwards. Architecture that forgets the bill is the reason will over-index on routing cleverness and under-index on the ledger.
- **Five teams**: they are not interchangeable tenants. Some run user-facing latency-sensitive completions. Some run overnight batch enrichment. Some run internal copilots where a wrong-but-plausible cached answer is worse than a slow live call. Per-team policy is load-bearing, not a nice-to-have.
- **Three providers, three different failure and cost shapes**:
  - **OpenAI**: billed per token, separate input/output prices, RPM/TPM rate limits that are not the same as the bill, regional incidents, content-policy 4xx that are *not* outages.
  - **Anthropic**: same shape as OpenAI with different prices, different rate-limit headers, different error taxonomy, different streaming protocol.
  - **Self-hosted Llama**: **not billed per token**. Billed as GPU capacity that is either idle (wasted money) or queued (latency). Fails as capacity exhaustion, not as HTTP 429 from a vendor. No vendor SLA. Cold-start and queue-depth are first-class failure modes. Treating it as a fourth interchangeable node in a round-robin pool is how fallback storms melt the one backend you still control.
- **Operator**: a platform/infra owner who does not want to become a prompt engineer for five teams, and who will be paged when the gateway — now a single chokepoint — is down.
- **Organizational reality**: teams will resist migrating off direct provider SDKs. The gateway has to be *strictly better* (keys they don't manage, budgets they can see, fallback they don't have to write) or they will keep a side channel and the "single audit trail" dies.

## The Math (the actual requirement)

This is the constraint every other document exists to respect. It is not a performance target. It is why "reject this call if it would exceed the budget" is a sentence that does not describe a real system.

### You cannot know the cost of a generation before it finishes

| Quantity | Knowable before the call? | Notes |
| --- | --- | --- |
| Input tokens | **Yes**, if you tokenize locally with the same tokenizer the provider uses (or a close-enough estimate). Tokenizer mismatch is a real error source. | Countable. |
| Output tokens | **No.** Bounded above by `max_tokens` / `max_output_tokens`. Unbounded below that except by "the model stopped." | This is usually the expensive half. |
| Cached prompt-prefix discount (provider-side) | **No**, not from the client, not reliably. | Providers sometimes discount prefixes; you find out on the bill. |
| Tool-call / multi-round agent loops | **No.** One user request can become N billed generations. | The gateway sees one HTTP call or many, depending on whether the team loops client-side. |
| Self-hosted Llama "token cost" | **Not in dollars-per-token.** The GPU was already paid for this hour. Marginal cost is electricity and opportunity cost of the queue slot. | Different unit entirely. |

A team with a $500 remaining monthly budget and a request whose input is $0.02 and whose `max_tokens` implies a worst-case output of $0.80 **might** cost $0.03 or $0.80. A hard pre-flight gate that uses the worst case will reject work that would have fitted. A hard pre-flight gate that uses the typical case will let through a long completion that blows the budget. **Both are wrong as "exact enforcement."** The design is therefore **optimistic reservation against an estimate, then reconciliation against actual usage**. See [ADR-001](./04_architecture_decision_records.md#adr-001) and [System Design — Budget](./03_system_design.md#2-budget-enforcement).

### Provider prices are not close enough to ignore

Illustrative 2026-era numbers, **not a quote, not a contract**. Use them to see the *spread*. Phase 0 replaces this table with the company's actual contracted rates.

| Route (illustrative) | Input / 1M tokens | Output / 1M tokens | Rough cost of 2k in + 500 out |
| --- | --- | --- | --- |
| Frontier SaaS (OpenAI-class) | ~$2.50 | ~$10.00 | ~$0.010 |
| Frontier SaaS (Anthropic-class) | ~$3.00 | ~$15.00 | ~$0.014 |
| Mid-tier SaaS | ~$0.15 | ~$0.60 | ~$0.0006 |
| Self-hosted Llama (fully utilized GPU) | n/a (capacity) | n/a (capacity) | ~pennies of GPU-time; **$0 if the GPU would have been idle** |
| Self-hosted Llama (saturated GPU) | n/a | n/a | **queue wait, not a price** — the cost is latency and dropped work |

Two facts follow, and they are not optional:

1. **Routing is a financial decision, not just a technical one.** Moving a chatty batch job from a frontier model to a mid-tier or to Llama can be a 10–50× cost change. A gateway that load-balances "evenly" across OpenAI, Anthropic, and Llama is spreading *quality and dollars* evenly, which nobody asked for.
2. **The gateway's own infra is cheap relative to the bill it sits in front of.** A pair of small instances plus Redis is tens-to-low-hundreds of dollars a month. The LLM bill this company is trying to control is (if this project exists) thousands-to-tens-of-thousands. ROI is "did we stop the unbounded invoice," not "did we shave 20ms of proxy overhead." See [Architecture Document — Cost Analysis](./02_architecture_document.md#cost-analysis).

### Rate limits are a second budget, in a different unit

OpenAI and Anthropic will 429 you for **requests-per-minute** and **tokens-per-minute** even when the team's dollar budget is healthy. Llama will queue or 503 you when GPUs are full, even when the dollar budget is healthy. **Dollar budget ≠ capacity budget.** A design that only tracks dollars will still take five teams down on a TPM cap. See [System Design — Rate Limiting](./03_system_design.md#5-rate-limiting).

### Cache savings are real, and so is cache harm

- **Exact-match cache**: if two requests are byte-for-byte the same after normalization (model, sampling params, messages, tools), serving the stored completion is free of provider cost and *correct for that key*. Hit rate on real product traffic is often **embarrassingly low** unless the workload is "the same prompt template with the same retrieved docs." Batch jobs and FAQ-like internal tools can see high exact-hit rates. User-facing chat usually does not.
- **Semantic cache**: an embedding similarity > threshold is **not** "this is the same question." It is "these vectors are close." Close vectors can be opposite intents ("delete the account" vs "do not delete the account"), time-shifted facts ("what's the latest status of X"), or personal ("what's *my* remaining balance"). Serving a cached answer here is a **correctness incident**, not a cost win. Semantic cache also **costs an embedding call on every lookup**, which can erase the savings on short completions. See [ADR-002](./04_architecture_decision_records.md#adr-002).

## Core Value Propositions
1. **Per-team budgets that are enforced as a reservation ledger, not as a wish.** Teams get a monthly (or weekly) dollar cap. The gateway reserves estimated cost, calls the provider, commits actual cost. Overshoot is possible and is treated as a measured error to tune, not as a bug we pretend we solved.
2. **One outage path instead of five.** Circuit breakers sit in front of each (provider, model). Fallback is quality-ranked and **labeled in the response**. Silent substitution is a product defect.
3. **Cache-driven cost reduction *where it is safe*.** Exact-match on by default. Semantic match opt-in per route, with a wrong-answer rate that is measured before it is celebrated.
4. **A single audit trail of who spent what, on what, with which model actually answered.** Finance and security both get this for free if the gateway is the only path. If it is not the only path, the audit trail is theater.
5. **Teams do not hold provider keys.** The gateway does. Key rotation, leak blast radius, and "which team did this $4k day" become one operator's problem instead of five.

## Success Metrics
All numeric targets below are **starting points to be calibrated in Phase 0 against real spend**, not facts. Inventing a $2,000/month team cap before measuring last month's invoice is how you either starve a team or fail to cap anything.

1. **Attributed spend coverage**: fraction of the company's LLM invoice that can be mapped to a `(team, route, model, day)` in the gateway ledger. If this is not ~100% of *gateway-path* spend, the ledger is wrong. If this is a small fraction of the *company* invoice, teams are bypassing the gateway and the project has failed its reason for existing.
2. **Budget breach rate**: dollars committed above a team's cap in a period, as a fraction of the cap. Target: small and *explained* (estimate variance, in-flight reservations, a single long completion). Target is **not** zero — zero usually means the reservations are so pessimistic that real work is being rejected. Track **false-positive rejects** (reservation denied, actual would have fitted) separately; that number going up is the gateway eating the product.
3. **Cache hit rate, split**: exact-match hit rate and semantic-match hit rate are **different metrics**. A blended "cache hit %" is how you hide that semantic cache is serving wrong answers, or that exact cache is doing all the useful work. Also track **semantic cache override/complaint rate** (caller or eval says the cached answer was wrong).
4. **Fallback activation rate and quality signal**: how often a request was served by a model other than the requested one, and whether the caller marked it degraded / retried / abandoned. Fallback that nobody notices in the metadata is not a success.
5. **Gateway availability vs provider availability**: the gateway's own SLO should be **strictly better** than any single provider, because that is the point of fallback. If the gateway is down more than OpenAI, we have added a worse SPOF. Track gateway 5xx/timeout separately from origin 5xx.
6. **Reservation-vs-actual variance**: distribution of `(reserved_cost - actual_cost)`. This is the health metric of the budget system. Persistent large over-reservation means we are blocking capacity we aren't using. Persistent under-reservation means we are lying about remaining budget.

## Business Rules
1. **No silent model substitution.** If the caller asked for model A and got model B (fallback, cost-downgrade, or operator pin), the response metadata says so. The caller is allowed to reject a degraded response. Hiding the substitution to "keep the API clean" is forbidden. See [ADR-007](./04_architecture_decision_records.md#adr-007).
2. **No team's traffic starves another on a shared resource without a documented policy.** Dollar budgets are per-team. The Llama GPU pool is **shared and finite**; it needs a separate isolation policy (priority, concurrency caps per team) or a batch job will queue a user-facing team into a timeout. See [ADR-005](./04_architecture_decision_records.md#adr-005).
3. **Self-hosted Llama is not an infinite fallback.** When SaaS providers are down, five teams will all hit Llama at once. That is a fallback storm. Llama's concurrency cap is part of the routing table, not an afterthought.
4. **Semantic caching is off unless a route owner opts in and accepts the failure mode in writing.** Default is exact-match only. See [ADR-002](./04_architecture_decision_records.md#adr-002).
5. **The gateway is the only supported path to provider keys.** A team that "just needs to debug with the raw SDK" gets a time-boxed exception or a gateway passthrough debug header, not a copy of the production key in a Slack message.
6. **Budgets are observed before they are enforced.** Phase 1 tracks; Phase 2 alerts; Phase 2-exit then hard-fails. Flipping on hard-fail against guessed caps is how you become the most hated internal service in a week. See [Phased Implementation Plan](./07_phased_implementation_plan.md).
7. **Data-residency / sensitivity pins beat cost-optimal routing.** A team whose prompts cannot leave the building is pinned to Llama (or to a provider with a signed DPA), even if that is more expensive or slower. Cost-aware routing is not allowed to "helpfully" send those prompts to the cheapest SaaS model. See [Security Architecture](./05_security_architecture.md).

## Gateway Consumers
This is internal platform infrastructure, not a product with a marketing site; its surface area is operational:

1. **Calling team (service identity)**: sends OpenAI-compatible (or documented gateway) HTTP requests, receives completions plus metadata (`provider`, `model_served`, `cache_status`, `budget_remaining_estimate`, `degraded`). Owns its route policies and its budget.
2. **Platform operator**: owns credentials, breaker state, routing table, budget caps, pages when the gateway is the outage.
3. **Finance / FinOps**: reads the ledger, not the provider invoice, as the source of "which team spent what." If those disagree, the ledger is the bug (or the bypass is).
4. **Security / compliance**: cares that prompts are logged, retained, and routed according to data-handling class — and that the cache is treated as a copy of production data.
