# LLM Gateway — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. Phases 0–4 are sequential. Phase 5 is conditional and may never trigger.

This order is load-bearing: **measure before caps, track before block, exact cache before semantic, labeled fallback before anyone trusts fallback.** Flipping all of the scenario features on in one deploy is how you false-reject production and serve the wrong cached answer in the same week.

## Phase 0 — Measure the Actual System

**Objective**: Replace invented prices, invented QPS, and invented team caps with numbers from the company's last invoices and traffic. Confirm how Llama actually fails.

**Deliverables**:
- Last 1–3 months of OpenAI and Anthropic invoices, mapped *as well as possible* to the five teams (keys, projects, org dashboard, or a spreadsheet of shame).
- Current rate-limit tiers (RPM/TPM) **as observed** (a 429 today beats the brochure).
- Llama: replica count, `max_in_flight`, queue behavior, who already uses it, what happens at saturation.
- Data-handling constraints per team (what must not leave the building).
- Decision record: **build vs buy vs do nothing** using [Trade-offs §4](./06_tradeoffs_and_honest_assessment.md#4-build-vs-buy), with a named owner.
- Written asks (vendor caps, extra keys, GPU peak capacity, team migration date) sent in parallel; do not wait for answers to start Phase 1 unless the decision was "do nothing."

**Exit Gate**:
- [ ] Spend-by-team table exists, even if ugly and incomplete; gaps are labeled as gaps, not filled with guesses presented as facts.
- [ ] A first-pass monthly cap **range** per team exists as a *hypothesis* (e.g. 1.2× last month), not as an enforced number.
- [ ] Llama capacity and pin requirements are written down.
- [ ] Build/buy/do-nothing is an explicit choice. If "do nothing," this plan stops here.

## Phase 1 — Proxy, Identity, Exact Cache, Observe-Only Ledger

**Objective**: Become the path to the origins without yet rejecting anyone for budget. Prove adapters extract `usage` correctly. Put exact-match cache in front of identical traffic.

**Deliverables**:
- Gateway deployed multi-instance, internal-only, with **per-team identity**.
- Adapters: OpenAI, Anthropic, Llama. Streaming works. Error taxonomy mapped.
- Exact-match cache (per-team namespace) with TTL config; default on, opt-out header/route flag.
- Ledger writes **commit-only** (or reserve-and-always-succeed): every request records estimated vs actual cost; **reserve never rejects**.
- Audit events without turning info logs into a world-readable prompt dump ([Security](./05_security_architecture.md#audit-logging)).
- Price table dated and checked against a sample of invoice lines.
- One production route from **one** team migrated; old key for that traffic rotated if it was dedicated.

**Exit Gate**:
- [ ] Invoice-vs-ledger drift on the migrated traffic is understood (documented %, causes: tokenizer, prefix cache, missing usage).
- [ ] Gateway overhead p50 is within the "tens of ms" budget on cache miss, excluding origin.
- [ ] Exact-cache hit rate is reported **separately**; a low number is acceptable if traffic is unique.
- [ ] Missing `usage` on HTTP 200 is alertable and rare.
- [ ] Multi-instance: killing one replica does not drop in-flight ledgers on the others (store is shared).
- [ ] **No hard budget rejects in this phase.**

## Phase 2 — Budget Enforcement, Soft then Hard

**Objective**: Make the reservation lifecycle real. Alert before block. Then block.

**Deliverables**:
- Atomic `reserve` / `commit` / `release` / TTL sweeper / `unconfirmed_spend` path ([System Design §2](./03_system_design.md#2-budget-enforcement)).
- Dashboards: remaining estimate, committed, reserved, overshoot, false-positive reject counter (once hard-fail is on).
- Spend-velocity alerts per team.
- **Soft-fail window**: reserve would have failed → serve anyway + page/alert + header `budget_soft_exceeded`.
- Per-route output reservation policy chosen (`max_tokens` vs p95) using Phase 1 variance histograms.
- Cutover plan for remaining teams; origin key rotation completion.

**Exit Gate (soft-fail)**:
- [ ] Soft-exceed events correlate with real near-cap behavior, not with a wildly wrong estimate (if they do, **do not** go hard-fail).
- [ ] Reservation leak after crashes is bounded by TTL (tested: kill gateway mid-request).
- [ ] All five teams on the gateway **or** a documented exception with an expiry.

**Exit Gate (hard-fail)** — separate, after a chosen quiet period of clean soft-fail:
- [ ] Hard reject enabled per team with the measured cap.
- [ ] False-positive reject rate is reviewed with each team and is acceptable to them.
- [ ] Vendor-side org/key cap configured if Phase 0 got a yes; if no, documented residual stolen-key risk.

## Phase 3 — Circuit Breakers, Ranked Fallback, Llama Isolation

**Objective**: Survive a provider incident without melting Llama and without silent quality substitution.

**Deliverables**:
- Breakers per `(provider, model)` with the classification table in [System Design §4](./03_system_design.md#4-circuit-breakers).
- Fallback tables per requested model, respecting `no_egress` pins.
- Response metadata: `model_served`, `degraded`, `allow_fallback` honored ([ADR-007](./04_architecture_decision_records.md#adr-007)).
- Origin RPM/TPM limiter; Llama `max_in_flight` global and per team; gateway admission shedding.
- Retry policy implemented as [ADR-006](./04_architecture_decision_records.md#adr-006) (no mid-stream retry). Game-day: kill origin after first byte, confirm no second generate.
- Optional: per-team TPM fraction or a second vendor key for batch vs interactive.

**Exit Gate**:
- [ ] Game day: OpenAI marked down (or real incident) → traffic follows the table, Llama stays within semaphore, excess gets 503, metadata is correct.
- [ ] Content-policy 4xx does **not** open the breaker and does **not** fallback to a "more helpful" model.
- [ ] Teams that forbade fallback get errors, not Llama by surprise.
- [ ] Fallback activation is a dashboard, not a log-line nobody reads.

## Phase 4 — Semantic Cache, One Low-Risk Route

**Objective**: Prove or kill semantic caching on a workload where a wrong hit is cheap (internal FAQ, repeated non-personalized drafts), not on checkout, medical, or "my account."

**Deliverables**:
- Opt-in config on **one** route: pinned embed model, per-team index, high similarity threshold, TTL, kill switch.
- Embedding cost in the ledger.
- Measurement: hit rate, **net** $ (embeds + remaining origin vs Phase 3 baseline), sampled wrong-hit rate (human or eval set).
- Deny-list enforced (personalized/time-sensitive/high-stakes never accidentally inherit this via a default).

**Exit Gate**:
- [ ] Net cost is down **or** the feature is turned off. Hit rate alone is not a pass.
- [ ] Wrong-hit rate is below the route owner's written tolerance (if they cannot name a tolerance, the route is ineligible).
- [ ] Kill switch tested.
- [ ] No expansion to a second route without repeating this gate.

If the route cannot pass, **semantic cache stays off company-wide**. That is a successful Phase 4 outcome.

## Phase 5 — Conditional Scale-Out or Buy

**Objective**: When the system outgrows "five teams, one Redis, three adapters," choose deliberately instead of bolting on a mesh.

**Entry Gate (any one of)**:
- [ ] Ledger contention or Redis CPU is a material fraction of overhead budget.
- [ ] Team count or QPS grows such that config-as-tickets is the bottleneck.
- [ ] Adapter churn (new vendors, schema breaks) exceeds what one operator can own.
- [ ] Llama needs hard isolation (dedicated GPUs per team) beyond semaphores.
- [ ] Invoice-vs-ledger operations demand a product UI FinOps will actually use and we will not build a good one.

**Deliverables** (pick one path, do not do all):
- **Scale-out build**: shard/hot-key work, cache size policy, maybe separate cache vs counter clusters; still no semantic-by-default.
- **Buy**: migrate to a vendor/OSS proxy that satisfies [Trade-offs §4](./06_tradeoffs_and_honest_assessment.md#4-build-vs-buy) constraints (disclosure, Llama pins, semantic off, reservation honesty). Reuse Phase 0–3 policy, do not restart from a vendor demo.

**Exit Gate**:
- [ ] Chosen path preserves audit continuity (historical spend still attributable).
- [ ] Cutover does not re-issue origin keys to teams.
- [ ] Fallback and budget semantics are re-validated against the same game days as Phase 3.

## What is explicitly not a phase

- Prompt CMS, agent framework, fine-tune pipeline, customer-facing metering.
- "Make outputs identical across providers."
- Global semantic cache.
- Single-instance "we'll add Redis later" for Phase 1 production. Later never comes; the budget will be wrong on the first deploy of a second replica.

## Suggested calendar (illustrative, not a promise)

| Phase | Elapsed (honest) | Dominant risk if rushed |
| --- | --- | --- |
| 0 | 1–2 weeks | Caps and buy/build decided on folklore |
| 1 | 2–6 weeks | Usage parse bugs become "the official numbers" |
| 2 | 2–4 weeks including soft-fail | Hard-fail false rejects; political failure of the gateway |
| 3 | 1–3 weeks + game day | Fallback storm; silent Llama |
| 4 | 2+ weeks of measurement | Cannot be calendared as "sprint: add embeddings" |
| 5 | if ever | |

If leadership wants "all of the scenario" in two weeks, give them Phase 1 plus a spreadsheet of caps, not a semantic index. The rest of this plan is how you avoid becoming the outage.
