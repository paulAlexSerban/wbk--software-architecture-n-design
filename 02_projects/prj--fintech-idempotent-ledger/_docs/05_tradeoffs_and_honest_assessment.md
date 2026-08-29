# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone writes a ledger.

The expected answer is a cluster of slogans: **immutable double-entry, globally ACID, exactly-once, dynamic failover, sub-100ms, 20k TPS, 35 banks.** Those words are not all compatible. Passing the interview by drawing a box labeled "distributed ledger" is the anti-pattern. This page is the cost of a design that can be built and operated without paying out twice.

## 1. What I would build

A **regional ACID intent ledger** and an **async settlement pipeline**, not a globally serializable money computer.

- **Accept API** that refuses to call a bank. Idempotency key required. Unique `(principal_id, idempotency_key)`. Payload fingerprint. `201` after commit means reserved, not paid. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Append-only double-entry journal** in the same transaction as the reservation, with reversing entries as the only correction, and a suspense account for `unknown`.
- **Orchestrator** that claims exclusively, persists a stable provider request id **before** send, and treats timeout-after-send as `unknown`.
- **Per-rail adapters** with classification tables whose default is `unknown`. Circuit breakers that stop *new* work, not *retry the in-flight one elsewhere*.
- **Reconciliation** as a product: status poll, webhook inbox through the same state machine, statement match, manual queue. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Client SDK / API contract change**: retries reuse the key. This is not optional polish.

I would not build a multi-region Paxos ledger so that a payout can be linearizable in Virginia and Frankfurt in 100ms. I would not 2PC with banks. I would not enable automatic failover on timeout.

I would not tell the board that all 35 networks will be interchangeable next quarter. I would pick two or three rails that cause the current duplicate losses, put them behind the new path, and prove chaos tests before a fourth.

If Phase 0 shows the millions lost are *only* one buggy mobile client minting new UUIDs, and volume is hundreds of TPS not 20,000, I would still build the intent unique constraint and the no-blind-retry worker — that is the money — and I would **not** provision a 20k-TPS sharded planet. Scale the data layer to measured peak, with a written headroom policy. The scenario's 20k is a capacity **requirement to design for**, not a vanity cluster to buy on day one. But I would not skip sharding *design* (sticky owner, unique index, no dual-write) just because we deploy one shard first.

## 2. What I would give up

Be explicit. These are not "later." Some of them are never in this design.

**Literal exactly-once execution at the bank.** We give effectively-once of *our* intent. The wire is at-least-once. Unknown exists. Providers can still glitch. Anyone who needs the slogan in a press release is asking us to lie.

**Strict ACID across datacenters as one transaction.** We give strict ACID **per shard**. Cross-region is replica and DR with fencing. Cross-border settlement is a saga. [ADR-002](./04_architecture_decision_records.md#adr-002), [ADR-003](./04_architecture_decision_records.md#adr-003).

**Sub-100ms until the beneficiary is paid.** We give sub-100ms **accept** in-region, when the database is healthy. Settlement is per-rail and often not instant. Instant rails still will not be contracted as 100ms worldwide including last mile.

**Synchronous "provider reference in the HTTP response"** as the default product. Partners who demand it get a **slow, explicit, sync-wait route** with the 100ms SLA withdrawn in writing for that route — or they poll. They do not get a hidden exception that reintroduces timeouts-as-failures for everyone.

**Automatic, universal failover across 35 providers.** We give gated, corridor-specific failover after *known* failure, with FX/fee policy. Many corridors have one rail. [ADR-005](./04_architecture_decision_records.md#adr-005).

**A single worldwide serializable history.** Reporting is a merge. Intraday global trial balance is a snapshot job, not a 100ms read.

**The simplicity of POST-and-pray.** Ops now owns `unknown` aging, statement breaks, adapter classification bugs, and shard failover fencing. If treasury will not staff a queue, **do not take the 201**, or you have moved the loss from "duplicate payout" to "stuck suspense and angry customers" plus the occasional still-duplicate if someone "helps" by retrying execute from a runbook.

**Cheapness relative to a CRUD payout table.** This is more moving parts. Pay it because duplicates already cost millions. Do not pay it for an internal points transfer.

**The fantasy that client retries can stay stupid if the server is clever.** New idempotency keys are new money. I would give up compatibility with "retry POST with a fresh UUID" as default HTTP client behavior.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**. Silence must not be interpreted as "they agreed to 100ms global paid."

Ask product / commercial:

1. **May `201` mean accepted-not-settled, with client polling (or webhooks) for `settled`?** If no, they are asking for the bank on the request path. Then the 100ms SLA is refused or scoped to a toy corridor. Expected: product wants both. Make them pick.
2. **Will we break existing clients that retry with a new key?** Expected: "can we not?" No. Dual-run: old path for old clients with tighter rate limits and a kill switch, new path for new clients — but the old path **keeps losing money**. A date to shut it off is the actual ask.
3. **What is the real peak TPS, not the slide?** If peak is 2,000, say so. 20,000 changes shard count and cost. Still design the uniqueness model as if hot principals exist.

Ask finance / accounting:

4. **Sign the COA sketch:** reserve, suspense, clearing, fees, FX, reversals. When is revenue recognized? Expected: this meeting takes weeks. Do not let engineering invent `fee_income` on accept.
5. **What is the loss threshold that pages vs tickets?** Unknown aging SLO. Unmatched statement line SLO.

Ask banking-ops / partnerships:

6. **Per rail: status API? idempotency field? webhook? statement id echo? timeout contract? does 5xx ever mean paid?** Fill the classification table. Expected: half the rails will not answer in writing. Those rails default to `unknown` and slow recon. That is a commercial fact.
7. **Which corridors actually have two interchangeable rails?** Expected: fewer than the "35 networks" slogan. Failover matrix will be sparse. Do not promise density.

Ask compliance:

8. **Retention, immutability, access to journal and payloads, right-to-erasure vs AML.** PII in attempt blobs vs "full audit trail" will fight. Get a written retention and redaction policy. A blockchain will not resolve this.

Ask platform / SRE:

9. **Shard DR: who is allowed to promote a replica, and what fences the old primary?** If the answer is "we'll failover DNS and hope," the HA plan is a dual-pay plan.
10. **Will we fund 24/7 for the recon queue?** If no, cap the corridors launched.

What I would **not** ask for: a new consensus product, a rewrite in a more financial-looking language, a multi-cloud ledger abstraction, or "blockchain for immutability." Those asks spend calendar time that belongs to adapters, classification, and the client SDK.

## 4. Complexity inventory

| You take on | You shed |
| --- | --- |
| Intent + journal + outbox + attempts | "One payout row, status = last HTTP code" |
| Three-layer idempotency | Client-side retry as recovery |
| `unknown` + suspense accounting | Timeout = fail = retry |
| Per-rail adapters and classification | One HTTP client, 35 base URLs |
| Reconciliation jobs and ops queue | "The bank will callback" as a strategy |
| Sticky shard + fencing DR | Active-active dual write |
| Client SDK contract | Invisible compatibility with UUID retries |
| Eventual `settled` UX | Lie that `201` is paid |
| 20k TPS accept engineering (when real) | 20k TPS of bank HTTP (fantasy) |

Net: **more parts, in the right places.** The old design was simple *and losing millions.* The new design is the standard one at any serious processor, and the standard one is still **quarters to a year** to get core + a few rails + recon + SDK change into production, not an agile sprint labeled "exactly-once."

### What is not worth building

- Global linearizable ledger to satisfy the word "ACID" in the prompt.
- 2PC with providers.
- Automatic failover on timeout.
- A custom blockchain or hash-graph as the journal. Append-only tables plus permissions plus backups. If a regulator wants WORM, buy WORM storage.
- Homegrown "exactly-once" message bus.
- All 35 adapters before the state machine is proven on one rail (Phase 2 gate).
- Cross-session anything that mints a second intent for the same human click.
- Sync execute "just for VIP merchants" without withdrawing their SLA and isolating their code path — it will become the default.

## 5. When I would not do this

- Internal transfer between two accounts in **one** database we own, low volume, no client retries across a timeout boundary. **Unique constraint + one transaction. Stop.**
- The "millions in losses" cannot be evidenced, and volume is a demo. Do not build PayGlobe-scale sharding.
- Compliance forbids async accept (every response must be bank-confirmed). Then this architecture's 100ms claim is dead; you build a sync proxy with **idempotency still required** (otherwise you *still* duplicate) and an honest multi-second SLA. You do **not** skip the intent row.

When I **would** do this: duplicate payouts are real, rails timeout, clients retry, auditors exist, and you are actually a gateway. That is this scenario. Then the slogans get rewritten as in [Scenario — Requirements as Rewritten](./01_scenario_and_requirements.md#requirements-as-stated-vs-requirements-as-rewritten), and this document is the bill.

## 6. Brutal summary

The clever design is not a globally ACID, exactly-once, 100ms, 35-way failover diagram. The clever design is **refusing to treat a timeout as a failure, refusing to put the bank on the accept path, and refusing to run two writers for the same idempotency key.**

"Immutable double-entry ledger" is the right three words for the books. The fourth through four-hundredth words are idempotency keys, payload fingerprints, suspense, stable provider request ids, classification tables, reconciliation, shard fencing, and a client that retries **the same key**.

If the money does not leave your database, do not build this. If the money leaves through hostile APIs, do not pretend a longer timeout is a ledger. Either way, Phase 0 is the SLA rewrite and the rail questionnaire — before anyone shops for a consensus database.
