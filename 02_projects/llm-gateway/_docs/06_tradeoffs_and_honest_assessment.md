# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes an OpenAI adapter.

The math, once: **you cannot know the dollar cost of a generation before it finishes.** Input tokens are estimable. Output tokens are not. Semantic similarity is not sameness. A Llama GPU does not become infinite because OpenAI is down. A retry after the stream started is a second invoice, not an idempotent GET.

## 1. What I would build

A **control plane with a ledger**, not a clever reverse proxy.

- **Stateless gateway fleet** with adapters for OpenAI, Anthropic, and the existing Llama pool. OpenAI-compatible facade so migration is a base URL and a team identity, plus mandatory metadata. Not a new prompt DSL.
- **Atomic budget reservation** (`limit` / `committed` / `reserved_outstanding`) with commit-on-usage and a sweeper for crashed holds. This is the product. The proxy is how you get into the product.
- **Exact-match cache** with a strict key (model + params + messages + tools). Coalesce identical in-flight misses if we have time; it pays for itself on batch.
- **Per-(provider, model) breakers** and a **written fallback table**, with `model_served` and `degraded` on every response. Llama behind a **concurrency semaphore**, not behind a $0 price tag.
- **Shared Redis + Postgres** (or one store at tiny QPS) because in-process counters are how five replicas each give away the full budget.
- **Auth per team**, origin keys only on the gateway, **rotate the old keys at cutover**.
- **Observe spend for a full billing period (or a dense slice of traffic) before hard-reject.** Caps invented in a meeting will be wrong.

I would not build a plugin marketplace, an "LLM OS," a vector database in week one, or seamless fallback that looks like OpenAI when it is Llama.

If Phase 0 shows monthly spend is small and the "shocking bill" was a one-off missing `max_tokens` in a loop, I would **not** build this. I would set provider billing alerts, fix the loop, and rotate keys. Architecture for a problem that was a missing `if` is how you get a platform team.

## 2. What I would give up

Be explicit. These are not "later" disguised as v1.

**Exact pre-call budget enforcement.** It does not exist. We give up the slide that says "no request ever exceeds the remaining budget." We keep a ledger that stops the next requests after a bounded overshoot. See [ADR-001](./04_architecture_decision_records.md#adr-001).

**Semantic caching as a default cost win.** Default off. Most routes never get it. The routes that do accept wrong-answer risk in writing. See [ADR-002](./04_architecture_decision_records.md#adr-002).

**Treating the three providers as interchangeable replicas.** No 33/33/33 load balance. No "the gateway will pick the best model." The team asked for a model; we may fail over along a ranked list and we will say so.

**Silent fallback.** Quality changes. Compliance may change. The response says so. Callers who want hard fail on outage set `allow_fallback: false`.

**Automatic retry after partial generation.** We give up "heal the stream." We keep the invoice sane. See [ADR-006](./04_architecture_decision_records.md#adr-006).

**Sub-10ms overhead as a promise.** Auth + canonicalize + Redis reserve + cache GET is tens of milliseconds when healthy, worse when Redis hiccups. Semantic lookup is an extra model call. Anyone who needs 2ms should not be on this path for that hop — or should accept exact-cache-only and a local sidecar, which is another design.

**A generic N-provider plugin framework.** Three adapters. When a fourth vendor appears, copy a folder. Premature SPI is how usage parsing — the ledger — gets an interface and a bug.

**Llama as infinite free capacity.** Fallback storms shed load. If the business wants Llama to absorb a full SaaS outage, they **buy GPUs for incident peak**, not for average utilization.

**A drop-in that needs zero caller changes beyond `base_url`.** Identity, metadata, and "your batch job now shares TPM fairly" are changes. Teams that refuse to migrate keep a side channel and the project fails.

**Real-time vendor invoice truth.** We reconcile what adapters parse from `usage`. Prefix discounts, rounding, and timeout holes remain. FinOps still looks at the invoice monthly.

**DLP as a gateway guarantee.** v1 may have a hook; it will not catch every secret in a prompt.

## 3. What I would ask for, even though I expect a no

Ask **once, in writing, in Phase 0**. A no does not block the gateway. A yes is a gift.

Ask OpenAI / Anthropic (or the account rep):

1. **Org-level spend caps and webhooks** that fire in near-real-time, plus **per-key caps** so a stolen gateway key cannot print money until Monday. Expected: coarse caps, delayed billing, maybe. Still the best backstop for [stolen-key blast radius](./05_security_architecture.md#identity-and-access-management).
2. **Dedicated TPM/RPM** per key so interactive and batch can be isolated without software fractions. Expected: pay more, or no.
3. **Usage API with low latency** for timeout reconciliation. Expected: hours-to-next-day, if that.
4. **Zero-retention / no-training** contractual terms if not already signed. Expected: paperwork, not a technical no.

Ask the Llama owners:

5. **Incident-peak capacity** if Llama is advertised as fallback. Expected: no, the cluster is sized for the cheap batch job. Then **do not advertise Llama as full failover** in the table; pin it as best-effort and shed. Honesty in the routing table.

Ask the five teams:

6. **Migrate and surrender keys.** Expected: stall. Make rotation a hard cutover date with an executive sponsor. Without this, stop the project.
7. **Accept labeled degraded fallback** or opt out per route. Expected: "just make it work." Refuse to hide the model.
8. **Named route owners** for cache policy and data-handling class. Expected: "use the defaults." Defaults are exact-cache-on, semantic-off, `unrestricted` only if they sign it.

Ask FinOps:

9. **Actual last-quarter spend by approximate team** (even a spreadsheet). Without this, caps are fiction.
10. **Whether internal chargeback for Llama GPU-time exists.** If not, Llama is politically "free" and will be overused; isolation must be concurrency, not dollars.

What I would **not** ask for: that vendors make output tokens knowable in advance; that embeddings be a legal anonymization boundary; that we skip Phase 2 soft-fail because "the board wants enforcement Friday."

## 4. Build vs buy

This is a live question, not an appendix. Building is justified when **control of the ledger, data-handling pins, and Llama integration** matter more than **adapter churn and UI**. Buying is justified when **spend is high enough to need a gateway but headcount is not**.

Illustrative options (names will rot; the *categories* will not):

| Path | You get | You give up | When it wins |
| --- | --- | --- | --- |
| **Do nothing + vendor billing alerts + fix runaway loops** | Cheap | No per-team enforcement, no shared cache, no coordinated fallback | Spend is small; the shocking bill was a bug |
| **Open-source proxy (e.g. LiteLLM-class) self-hosted** | Adapters, basic budgets, virtual keys, some caching | You still operate Redis, still own HA, still verify their budget math against [ADR-001](./04_architecture_decision_records.md#adr-001) honesty; semantic cache still dangerous if they default it on | Want speed-to-proxy, accept we might wrap or replace their ledger semantics |
| **Vendor AI gateway (Portkey, Cloudflare AI Gateway, Helicone, etc.)** | UI, analytics, someone else's adapters | Prompts may flow through *another* third party; Llama/VPC pin may be awkward; cost of the gateway itself; less control of reservation semantics | Headcount scarce, SaaS-heavy, legal accepts the extra processor |
| **Build this design** | Ledger semantics, Llama as capacity, cache policy, disclosure, security boundaries we can explain | We own on-call and every vendor API change | Llama + data-handling pins are central; we already run internal HTTP + Redis; spend is material; we will not skip Phase 0 |

**Brutal rule of thumb:** if the company cannot staff on-call for a new SPOF, **do not build**. Buy or do nothing. A half-operated gateway is worse than direct SDKs (extra outage mode, false confidence in budgets).

If we buy, we still need: per-team identity, key rotation, `model_served` disclosure, semantic cache off unless proven, Llama concurrency. If the vendor cannot do those, we are buying a dashboard and calling it a control plane.

## 5. Complexity vs the interview prompt

The prompt lists load-balance, per-team budgets, fallback, semantic cache. A demo can fake all four in a single Node process. Production fails on:

- reservation races and unknown output tokens,
- cache **correctness**,
- fallback **quality and storms**,
- retries **double-billing**,
- the gateway as **SPOF and prompt datastore**.

Under-building (stateless proxy, `if spend > cap` after the fact, round-robin three URLs, cosine > 0.9) **fails the actual tests**: token economics, exact vs semantic, circuit breakers, "just another flaky backend" with the extra economics.

Over-building (service mesh, custom vector DB, multi-region active-active, agent framework) fails the operator. Five teams do not need that.

The honest middle is this document set: **boring HA proxy, fussy ledger, conservative cache, explicit fallback, gated phases.**

## 6. Brutal summary

The clever design is not a similarity index in front of GPT. The clever design is **refusing to pretend cost is known up front**, **refusing to serve a nearby embedding as an answer by default**, **refusing to retry a generation that already spoke**, and **refusing to treat a GPU queue as a third identical cloud API**.

Ship a proxy that attributes spend and survives one vendor dying *loudly*. Turn on hard budget rejects after the numbers are real. Leave semantic cache off until a boring route proves it saves money without lying.

If the five teams will not stop using raw keys, none of the rest matters. Rotate the keys or stop calling this a gateway.
