# prj--llm-gateway

Architecture and system design documentation for a rate-limited, cost-aware LLM gateway that five internal teams call instead of calling OpenAI, Anthropic, and a self-hosted Llama cluster directly.

Documentation-only project: no proxy code, no provider SDKs, no cache implementation lives here. This is the design specification a build phase would implement against.

The defining constraint is not routing. Routing is the easy part. Token cost is **unknowable before a generation completes**, semantic similarity is **not a correctness signal**, a retried generation is **not an idempotent retry**, and falling over to Llama is **not the same service, slightly slower**. The gateway exists because someone got a shocking bill and because provider outages currently take five teams down independently. It is a control plane sitting in front of three flaky, differently-priced, differently-failing backends — not a load balancer with an LLM sticker on it.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Security Architecture](./_docs/05_security_architecture.md)
- [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the token-economics math, why a naive "reject if this call exceeds budget" gate cannot exist, and the isolation rules the five teams actually need.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* the gateway is a stateful control plane rather than a stateless reverse proxy.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": reserve/commit/release budgets, exact vs semantic cache keys, per-(provider, model) circuit breakers, and retry rules that do not double-bill.
4. Read [Trade-offs and Honest Assessment](./_docs/06_tradeoffs_and_honest_assessment.md) before arguing for semantic caching, seamless fallback, or building this instead of buying LiteLLM/Portkey.
5. [Security Architecture](./_docs/05_security_architecture.md) covers the fact that this box now sees every prompt in the company, and that a cache of those prompts is a datastore of those prompts.
6. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/07_phased_implementation_plan.md) cover the locked decisions and the gated rollout — budget tracking before budget blocking, exact cache before semantic cache, observed spend before invented quotas.
