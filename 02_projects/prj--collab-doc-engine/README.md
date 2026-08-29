# prj--collab-doc-engine

Architecture and system design documentation for a multi-region collaborative rich-text and document engine that must host **~500,000 concurrent editing sessions** across North America, Europe, and Asia, with a stated target of **p95 end-to-end propagation under 50 milliseconds globally**.

Documentation-only project: no CRDT library, no WebSocket server, no Redis cluster, no client editor lives here. This is the design specification a build phase would implement against.

The defining fact is physics, not a preference for CRDTs over Operational Transformation. Fiber in the ground travels at roughly two-thirds the speed of light (~200,000 km/s). New York to London is ~5,500 km: **~28 ms one-way physical minimum**, ~55 ms+ RTT before a single CPU cycle. New York to Singapore is ~15,000 km: **~75 ms one-way**, ~150 ms+ RTT. A p95 of 50 ms for *cross-continent* keystroke visibility is not a hard engineering problem. It is a sentence that contradicts the speed of light. The design is therefore not "stand up a bigger WebSocket cluster." It is a local-first CRDT engine with edge-relay intra-region fan-out, state-vector delta resync for hours-offline clients, and an honest SLO split: **local apply is instant, intra-region/edge p95 < 50 ms, cross-region convergence is a separate lag number bounded below by geography.**

The current architecture — a centralized WebSocket cluster, Redis Pub/Sub, and a relational database — is the root cause, not an implementation detail. Redis Pub/Sub is at-most-once with no replay. Every keystroke as a discrete message multiplies fan-out (`ops/sec × subscribers`) on a single broker. A relational write per op is lock contention the moment two people touch the same paragraph. Sequence drift, state corruption, Redis memory blow-up, and catastrophic reconnect-after-offline are the same bug wearing four costumes.

## Docs

- [Business Overview](./_docs/01_business_overview.md)
- [Architecture Document](./_docs/02_architecture_document.md)
- [System Design](./_docs/03_system_design.md)
- [Architecture Decision Records](./_docs/04_architecture_decision_records.md)
- [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md)
- [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md)

## Reading order

1. Start with the [Business Overview](./_docs/01_business_overview.md) for the speed-of-light ledger that makes "global p95 < 50 ms" a capacity lie, and the session-vs-document math that makes "500k sessions" the wrong unit for fan-out.
2. Read the [Architecture Document](./_docs/02_architecture_document.md) for *what* is built and why the system is a CRDT + edge relay + region-homed document, not a bigger centralized broker.
3. Read [System Design](./_docs/03_system_design.md) for the mechanical "how": local-apply-then-broadcast, state-vector resync, edge coalescing, home-region assignment, CRDT compaction, the millisecond budget, and what is *not* inside the 50 ms envelope.
4. Read [Trade-offs and Honest Assessment](./_docs/05_tradeoffs_and_honest_assessment.md) for the answers this scenario actually asks for: what to build, what to give up, why the 50 ms global SLO is the wrong contract, and how the design changes if 50 ms meant intra-region rather than Tokyo-sees-NYC.
5. [Architecture Decision Records](./_docs/04_architecture_decision_records.md) and [Phased Implementation Plan](./_docs/06_phased_implementation_plan.md) cover the locked decisions and the gated rollout that refuses to ship a broken global-latency promise, or to size an edge fleet off a guessed editors-per-document distribution.
