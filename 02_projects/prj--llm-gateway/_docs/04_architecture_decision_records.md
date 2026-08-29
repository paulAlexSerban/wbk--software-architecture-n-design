# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Optimistic Budget Reservation with Post-Hoc Reconciliation

**Status**: Accepted

**Context**: The gateway's reason to exist is per-team dollar caps. Input tokens can be estimated before the origin call. Output tokens cannot; they are bounded only by `max_tokens` (or the vendor default). Provider prefix-cache discounts and mid-stream disconnects are also unknown up front. A design that claims to "reject the call if it would exceed the budget" is describing a number that does not exist yet. The alternatives are (a) always reserve the worst-case `max_tokens` cost, (b) reserve a typical/p95 cost and accept overshoot, or (c) track spend only after the fact (observability, not enforcement).

**Decision**: Use a ledger of `limit`, `committed`, and `reserved_outstanding`. Atomically **reserve** an estimated cost (route policy: `max_tokens` ceiling and/or historical p95), call the origin, then **commit** actual usage and **release** unused hold. Overshoot (`actual > hold`) is allowed, metered, and causes subsequent reserves to fail if `committed` has breached `limit`. Timeouts after send go to `unconfirmed_spend` rather than a silent full release. See [System Design §2](./03_system_design.md#2-budget-enforcement). Hard, exact, pre-call enforcement is rejected as a fiction.

**Consequences**:
- (+) Enforcement is real enough to stop a runaway loop; it is honest about the error bar.
- (+) Atomic reserve prevents two concurrent requests from both seeing "plenty left."
- (–) Teams will still sometimes overshoot a cap on a long completion. FinOps must hear this in Phase 0, not after the first breach.
- (–) Worst-case reservation will false-positive reject. p95 reservation will under-reserve. Route policy is a trade-off, not a solved equation.
- (–) Vendor billing after a timeout may never be reconcilable in real time. Caps need a small pad or a periodic invoice-vs-ledger reconciliation.
- **Alternative rejected**: post-only metering with a Slack alert. That is how the shocking bill happened.
- **Alternative rejected**: block until `max_tokens` worst-case always fits. Starves legitimate short completions near the end of a period.
- **Revisit trigger**: a provider offers a guaranteed pre-debit or a hard server-side budget API that matches our team split. Use it as a backstop; do not delete the ledger until it is proven.

## ADR-002: Exact-Match Cache On by Default; Semantic Cache Opt-In per Route

**Status**: Accepted

**Context**: Caching is in the scenario because it is the obvious cost lever. Exact-match (hash of normalized request including model and sampling params) is correct for that key; hit rates may still be low on chatty traffic. Semantic cache (embedding similarity) can return a fluent answer to the *wrong question*, costs an embedding on every lookup, and is unsafe for personalized, time-sensitive, or high-stakes routes. A global "turn on semantic caching" flag optimizes a dashboard and creates incidents.

**Decision**: Exact-match caching is default-on with per-route TTL and opt-out. Semantic caching is **default-off**, enabled only per route, with a documented threshold, a deny-list of request classes, per-team/per-class indexes, and a kill switch. Phase 4 may enable it on **one** low-risk route after measuring wrong-answer rate and net cost (embed + remaining generations vs baseline). A semantic hit is never stored as, or served as, an exact hit for a different requested model.

**Consequences**:
- (+) Exact-match savings where they actually exist (batch templates, repeated internal FAQs) without a vector product in v1.
- (+) Semantic risk is accepted by a named route owner, not by the platform by default.
- (–) Headline "cache hit rate" will look disappointing on user-facing chat. That is traffic shape, not a failed cache.
- (–) Semantic cache can *increase* spend at low hit rates. Phase 4 exit gate is net savings and quality, not "feature shipped."
- **Alternative rejected**: semantic cache globally with a single similarity cutoff. Opposite intents embed close.
- **Revisit trigger**: a route's exact-hit rate is already high; semantic adds little. Do not add it there for fashion.

## ADR-003: Per-(Provider, Model) Circuit Breakers and a Quality-Ranked Fallback Table

**Status**: Accepted

**Context**: OpenAI, Anthropic, and Llama fail independently and differently. A generic load balancer that sends the next request to "any healthy backend" will serve Llama (or a cheaper/weaker model) as if it were the requested frontier model. Content-policy 4xx and bad-request 4xx are not outages; treating them as breaker failures either flaps the breaker or "fixes" a policy refusal by asking a more compliant model to do the forbidden thing.

**Decision**: Circuit breaker per `(provider, model)` (Llama: per pool). Trip on timeouts, connection errors, 5xx. Do not trip on 4xx policy/bad-request; send 429s to the origin rate limiter. Fallback walks an **explicit ranked table** configured per requested model and constrained by data-handling pins. There is no "healthy = eligible." See [System Design §4](./03_system_design.md#4-circuit-breakers).

**Consequences**:
- (+) SaaS incidents degrade along a known path instead of a random one.
- (+) Policy errors stay visible.
- (–) Config burden: tables must be kept honest as models are added.
- (–) Cross-provider fallback will break tool-calling / prompt assumptions. Metadata exists so teams can fail the degraded path ([ADR-007](#adr-007)).
- **Alternative rejected**: round-robin across the three providers for "load balancing." That is a quality and cost lottery.
- **Alternative rejected**: one breaker for "OpenAI" as a whole.

## ADR-004: Stateless Gateway Instances; Shared Store for Budget and Cache

**Status**: Accepted

**Context**: The gateway is on every LLM call. It must run more than one process (availability and rolling deploys). In-process budget counters and in-process caches split reality: each replica thinks the team has a full cap, and cache hit rate dies. A distributed in-memory gossip cache is a research project.

**Decision**: Gateway processes are stateless. Budget reservations and exact-match cache live in a shared store (Redis for hot atomic counters and cache; Postgres for durable audit and period records — collapse to one store only if Phase 0 QPS is trivially low, with a documented migration). Breaker counters are shared (or at least eventually consistent with a bias toward *more* open, not *more* closed). Config is versioned and read from the config store, not baked only into an image without a kill switch.

**Consequences**:
- (+) Horizontal scale and a restart do not reset budgets or the cache.
- (+) Fail-closed on ledger unavailability is implementable (the dependency is obvious).
- (–) Redis/Postgres are now production dependencies of *all* LLM traffic. They need the same care as the gateway. This is the real HA design, not "run three pods."
- (–) Hot-team reservation contention on one key. Acceptable at five teams; watch it.
- **Alternative rejected**: sticky sessions + per-instance caps ("each replica owns 1/N of the budget"). Uneven load makes this either leaky or overly tight.
- **Revisit trigger**: QPS or team count where Redis reserve latency or contention violates the overhead budget; then shard by `team_id` (the key already does) or move admission locally with periodic refill (more leaky — only with eyes open).

## ADR-005: Self-Hosted Llama Is a Capacity-Constrained Pool, not a Peer Node

**Status**: Accepted

**Context**: SaaS providers fail as HTTP errors and billing meters. Llama fails as GPU saturation, queue delay, and operational faults. Its marginal dollar cost at idle is near zero; its marginal cost at saturation is *other teams' latency*. Naive round-robin or "fallback to Llama for everything" during an OpenAI incident is a stampedes onto the only backend the company can physically melt.

**Decision**: Llama appears in the routing table as a pool with `max_in_flight` and `max_in_flight_per_team`. It is a fallback or a pin (data-residency / cost policy), never an equal weight in a three-way balance unless a route explicitly declares Llama as primary. Dollar reservation of $0 (if policy) does **not** bypass the semaphore. Fail fast when the pool is full; do not grow an unbounded HTTP wait queue on the gateway. See [System Design §5.3](./03_system_design.md#53-llama-concurrency).

**Consequences**:
- (+) Fallback storms degrade to 503s instead of taking down Llama *and* the gateway thread pool.
- (+) Sensitive routes can pin to Llama without competing "fairly" with a 33% share of frontier traffic they never wanted.
- (–) During a dual SaaS outage, some traffic is shed. That is correct. Capacity is finite.
- (–) Operators must size the pool for *incident* load if they want Llama to be a real fallback, not for average load. Sizing for average and advertising fallback is a lie.
- **Alternative rejected**: treat Llama as a zero-dollar OpenAI-compatible origin with the same retry/load-balance rules.

## ADR-006: No Automatic Retry After Partial Generation

**Status**: Accepted

**Context**: Retries are the default instinct for flaky backends. Generative HTTP is not a read replica. A retry after tokens have been produced (a) bills a second generation, (b) may not be idempotent in content even with vendor idempotency keys, (c) cannot splice two streams into one coherent answer for the client. Blind retry-on-any-failure is how a timeout becomes a double invoice and a duplicated side effect if tools were called.

**Decision**: Automatic retry/fallback is allowed only in the pre-generation failure class (never sent, or sent but **no** tokens forwarded to the client — and even then, timeouts after send are `unconfirmed_spend` risks). Once any completion content has been forwarded, **do not** retry or fallback. Finish the stream with an error if the origin dies. Client `Idempotency-Key` may coalesce *in-flight duplicates* and replay a completed response; it does not authorize a second generate. See [System Design §6](./03_system_design.md#6-retry-semantics).

**Consequences**:
- (+) Stops the most expensive failure mode of an LLM proxy.
- (+) Client behavior is understandable: you got what you got, or a clean error.
- (–) Mid-stream origin death is a user-visible failure instead of a magical second try. Good. Magical second tries were the bug.
- (–) "Timeout before first byte" remains an uncomfortable maybe-double-bill. Document it; do not paper over it with retries.
- **Alternative rejected**: retry budget of N for all 5xx including mid-stream.

## ADR-007: Response Metadata Always Discloses Provider and Model Served

**Status**: Accepted

**Context**: Seamless fallback is a tempting API aesthetic ("the caller shouldn't care"). The caller *should* care: quality, latency, tool-calling behavior, and compliance all change when the model changes. Silent substitution trains teams to treat Llama output as GPT output and makes incidents undebuggable. Cache hits that served a different model than requested have the same problem.

**Decision**: Every gateway response includes `model_requested`, `provider`, `model_served`, `degraded`, and `cache_status`. The gateway never omits these to "look like OpenAI." Teams may strip fields before *their* end users; that is a product choice downstream. `allow_fallback: false` (or route forbid) is supported and returns an error instead of a silent substitute. Exact-match cache keys include the model identity so a fallback answer is not reused for a later primary request.

**Consequences**:
- (+) Callers can refuse degraded answers, metrics can split quality, security can see egress.
- (+) Honest SLOs: "OpenAI path p95" vs "fallback path p95."
- (–) Not a drop-in clone of `api.openai.com` in every header. Migration is a base URL **plus** reading metadata. Acceptable.
- **Alternative rejected**: transparent compatibility mode that hides `model_served` unless a debug header is set. Debug headers are how production lies.
