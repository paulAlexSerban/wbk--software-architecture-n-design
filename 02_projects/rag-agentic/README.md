# prj--rag-agentic

Architecture and system design documentation for an **agentic RAG runtime**: an agent that *decides* its own retrieval strategy per query (naive vs hybrid vs graph — the Tier 1 services as tools), reformulates and iterates until a typed grader is confident, self-corrects, and persists both **short-term** (session, Redis) and **long-term** (Postgres + embeddings of extracted memories) memory across sessions. The open-ended loop is bounded by max iterations, token/wall-clock budget guards, and circuit breakers.

Documentation-only project: no LangGraph graph, no Redis schema migration, no tool adapters, no memory extractor live here. This is the design specification a build phase would implement against.

This is a scenario showcase (the "one-strategy, no-memory, unbounded-loop trap"), not a general agent platform and not a new retriever. The indexes already exist: [`prj--docqa-basic-naive-rag`](../prj--docqa-basic-naive-rag/), [`prj--retrieval-x`](../prj--retrieval-x/), [`prj--rag-hierarchy-graph-rag`](../prj--rag-hierarchy-graph-rag/). The correction loop already exists as a *fixed* strategy: [`prj--rag-selfheal`](../prj--rag-selfheal/). This project is the **runtime that sits on top**: session state, memory-store schema, tool-selection policy, and a failure/fallback ladder when a tool or a retrieval is wrong. It is the synthesis of everything in Tier 1. It is also the most expensive, least deterministic project in the portfolio so far. The write-up exists to show *why* each layer costs what it costs before anyone wires a ReAct loop and calls it architecture.

A free-form agent that "just picks tools until it feels done" is the failure. A chain that always calls hybrid+rerank is a cheaper product that will win on 80% of traffic. **The documented answer is a bounded LangGraph runtime with a typed tool-selection policy, a typed grade as the stop condition, two-tier memory with extracted (not dumped) long-term writes, and a circuit breaker that can refuse even when the model wants another hop.**

## Docs

- [Scenario and Requirements](./_docs/01_scenario_and_requirements.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Scenario and Requirements](./_docs/01_scenario_and_requirements.md) for the three compounding traps (wrong strategy, no memory, unbounded loop), and the architecturally significant requirements.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and *why* the runtime — not a smarter retriever — is the product.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": tool-selection policy, the reformulate-grade-iterate loop, Redis/Postgres memory schemas, budget guards, circuit breakers, and named failure modes.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: the latency/cost multiplier vs naive RAG and vs `rag-selfheal`, when this is worth building (rarely), and how memory poisoning and eval theater will kill you if Phase 0 is skipped.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout — Phase 0 is a labeled mix with *correct-strategy* tags and multi-turn memory probes, not a LangGraph demo.

## Related

- Source scenario: [AI Engineering Portfolio Roadmap — §2.3 Agentic RAG with Self-Correction & Memory](../../04_challenges/ai-engineering-portfolio-roadmap.md)
- Tools this runtime calls, it does not reimplement:
  - Naive retrieve-generate: [`prj--docqa-basic-naive-rag`](../prj--docqa-basic-naive-rag/)
  - Hybrid + rerank: [`prj--retrieval-x`](../prj--retrieval-x/)
  - Hierarchical / graph: [`prj--rag-hierarchy-graph-rag`](../prj--rag-hierarchy-graph-rag/)
  - Fixed-strategy corrective loop this *generalizes* (and must not silently replace on every query): [`prj--rag-selfheal`](../prj--rag-selfheal/)
- Context-window budget this runtime should consume, not reinvent: [`prj--context-forge`](../prj--context-forge/)
- Eval backbone this should plug into: [`prj--rag-metrics`](../prj--rag-metrics/), [`prj--prompt-lab`](../prj--prompt-lab/)
- What this is **not**: MCP tool transport and a general ReAct agent ([roadmap §2.2 `agent-core`](../../04_challenges/ai-engineering-portfolio-roadmap.md)), multi-agent orchestration ([§2.5](../../04_challenges/ai-engineering-portfolio-roadmap.md)), or a production harness with sandboxing ([§3.5](../../04_challenges/ai-engineering-portfolio-roadmap.md)). Those are later projects. This runtime has three retrieval tools, a grader, a memory extractor, and a budget. That is already too many moving parts.
