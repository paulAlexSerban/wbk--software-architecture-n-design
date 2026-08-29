# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Effectively-Once via Durable Intent Reservation, Not Exactly-Once Messaging

**Status**: Accepted

**Context**: Duplicate payouts come from treating a timeout as a failure and sending a second money instruction. The scenario asks for "exactly-once execution via robust distributed idempotency." Exactly-once delivery over an unreliable network to 35 institutions we do not control is not a property messaging systems actually provide (they provide at-least-once or at-most-once; "exactly-once" in brokers is *processing* semantics inside *their* transactions, not "the bank credited once"). A cache of seen request ids without a payload is also insufficient: it cannot be audited, it fails open on cache eviction, and it does not record what was accepted.

**Decision**: The source of truth is an ACID row in the regional shard, uniquely keyed by `(principal_id, idempotency_key)`, created **before** any provider call, with a payload fingerprint. Client retries with the same key return that row. Provider execute uses a **stable** `provider_request_id` derived from `intent_id` (per rail). Automatic re-execute is forbidden while an execute attempt is `unknown`. Where a provider offers an idempotency field, we send that stable id. The honest name for the guarantee is **effectively-once payout** of a client intent. See [System Design — Idempotency at Three Layers](./03_system_design.md#8-idempotency-at-three-layers).

**Consequences**:
- (+) Concurrent client retries collapse to one intent without a distributed lock service.
- (+) Worker crashes and accept timeouts are safe if the client reuses the key.
- (+) Audit can show the reservation that existed before the wire call.
- (–) Clients that mint a new key per retry still double-pay. The SDK/contract change is mandatory; the ledger cannot save a client who lies about identity of the command.
- (–) Providers that ignore idempotency and execute twice on one HTTP call are not preventable; they are detectable via statements.
- (–) `unknown` delays settlement. Product will hate it. It is cheaper than millions in duplicates.
- **Alternative rejected**: "exactly-once" Kafka / transactional messaging as the payout guarantee. The bank is not in the Kafka transaction.
- **Alternative rejected**: Redis SETNX of keys as the ledger. Failover, eviction, and missing payload are duplicate or drop.
- **Alternative rejected**: longer client timeouts instead of idempotency. Reduces some races; does not remove them; trains everyone to wait, then retry anyway.
- **Revisit trigger**: a rail offers a real, contractual, end-to-end idempotent payout API *and* a reliable status query. Still keep the intent row; you can be less conservative on `unknown` for that rail only, with evidence.

## ADR-002: Regional Shard as the ACID Boundary; No Global Serializable Ledger

**Status**: Accepted

**Context**: The scenario asks for "strict ACID properties across distributed datacenters" and a sub-100ms SLA. A single globally-replicated, linearly serializable ledger (multi-region Paxos/Raft, or a single primary on one continent for the world) cannot deliver both. Inter-region RTT alone can consume the latency budget. 20,000 TPS on one write-ahead log is a hotspot. The uniqueness of `(principal_id, idempotency_key)` must still be **one** writer; two writable copies of that unique index are a split-brain duplicate.

**Decision**: Each intent is owned by exactly one **regional shard primary**. ACID (atomic reserve of intent + journal + outbox, isolation of claims, durability of commit) is guaranteed **inside that primary** (and its synchronous in-region standby if RPO-zero intra-region is required). Cross-region replication is **asynchronous** for disaster recovery and reads. Accept in a non-owning region **forwards** to the owner; it does not insert a second copy. Cross-border settlement between our books and a bank is **not** one ACID transaction ([ADR-003](#adr-003)). Shard key is `principal_id` (with a documented split mechanism for platform principals who are themselves marketplaces). See [Architecture Document — Latency Budget](./02_architecture_document.md#latency-budget).

**Consequences**:
- (+) Accept p99 < 100ms is *plausible* when client, API, and primary are in-region and the principal is not a pathological hotspot.
- (+) Unique index cannot fork across regions under normal operation.
- (+) Shard split is a known (painful) operational path; a global singleton is a dead end at 20k TPS.
- (–) Cross-region clients see extra latency or must use regional endpoints.
- (–) Disaster recovery: promoting a replica to primary must be **fencing** of the old primary (STONITH, lease, or equivalent). Dual primaries = dual payouts. This is the actual HA design.
- (–) There is no single serializable history of all PayGlobe money worldwide. Reporting is a merge of shards. Finance must accept this; it is how every large processor works.
- **Alternative rejected**: one global Spanner-like database for *all* writes "so ACID is everywhere." Even if the product is bought, commit latency and cost at 20k TPS need a Phase 0 proof; it still does not put the *bank* in the transaction, and it still does not make bank calls 100ms. Revisit only with measured commit p99, not a vendor slide.
- **Alternative rejected**: active-active accept on the same keyspace in two regions with conflict CRDTs. Money is not an "LWW register."
- **Revisit trigger**: a single principal's TPS saturates a shard after splitting tricks are exhausted; then shard by `(principal_id, corridor)` or hashed sub-key, with uniqueness still covering the idempotency key (the unique tuple must remain global *for that principal*, which may require a dedicated principal cluster).

## ADR-003: Settlement Saga with Compensating Entries, Not 2PC with Banks

**Status**: Accepted

**Context**: Cross-border payout looks like "debit merchant, credit beneficiary" as one atomic action. Two-phase commit would hold locks while a bank in another country decides. Banks do not speak XA. They time out. They maintain on Wednesdays. A 2PC coordinator waiting on a participant that has gone to lunch is a stuck ledger and a stuck customer.

**Decision**: Use a **saga** owned by the settlement orchestrator. Local ACID steps: reserve, record attempt, post or reverse. The bank is an **unreliable participant** whose outcome is learned immediately, via status query, or via statement. Compensation is a reversing journal entry, never an in-place edit, never an XA rollback at the bank (we cannot un-pay a rail that already paid; we can only request recall, which is a new business process and often fails). See [System Design — Intent State Machine](./03_system_design.md#2-intent-state-machine).

**Consequences**:
- (+) Timeouts do not hold a distributed lock across institutions.
- (+) Unknown can be represented in the books (suspense) without blocking all other intents on the shard.
- (–) Customers observe intermediate states. Product copy cannot say "paid" on `201`.
- (–) Recall/compensation when we *did* pay in error is operationally ugly and sometimes impossible. Prevention (no blind retry) is worth more than a clever saga diagram.
- **Alternative rejected**: 2PC/XA including the adapter "resource manager." Fiction.
- **Alternative rejected**: choreography-only (events flying with no owner). Money sagas without a single orchestrator state per intent become undebuggable. Orchestrator + events for integration is fine; "pure choreography" is not.
- **Revisit trigger**: none for 2PC with external banks. Internal 2PC between two shards we own is still discouraged; if a payout must debit shard A and credit shard B, that is two local sagas and a clearing account, not XA.

## ADR-004: Reconciliation Is a Runtime Control Loop, Not "Retry Harder"

**Status**: Accepted

**Context**: After send, a timeout means the money may already have moved. Retrying execute is the current production bug. Waiting forever without a closer is also a bug (suspense grows, customers rage, auditors ask). Many of the 35 networks have weak or no status APIs. Webhooks will be at-least-once and delayed. Statements arrive on banking calendars.

**Decision**: `unknown` is a first-class intent state. The only automatic exits are: provider status confirming executed or not executed; webhook processed through the same state machine; statement match at acceptable confidence; or promotion to manual review when SLO on `unknown_since` is breached. There is **no** "retry execute from the timeout handler." Reconciliation jobs are a Phase 3 **gate**, not a backlog item. See [System Design §6.3 and §6.5](./03_system_design.md#63-provider-timeout-after-send-the-actual-hard-case).

**Consequences**:
- (+) Duplicate execute from our side becomes a bug in the state machine (testable), not an accident of HTTP.
- (+) Unmatched statement lines catch the other disaster: money left that we did not intend.
- (–) Rails without status APIs impose ops load and slower customer confirmation. That is a **rail selection / commercial** issue as much as an engineering one.
- (–) Fuzzy matching will mis-assign. Confidence thresholds and a human queue are part of the design. Anyone who promises fully automatic recon on 35 rails is lying.
- **Alternative rejected**: exponential backoff on execute until 200. That is the loss function.
- **Alternative rejected**: "the webhook is the source of truth, skip the attempt log." Webhooks drop; the attempt log is what we know we sent.
- **Revisit trigger**: a rail adds a strong status API; tighten the unknown SLO for that rail; do not remove the state.

## ADR-005: Provider Adapters Isolate Rails; Failover Is a Gated Business Transition

**Status**: Accepted

**Context**: "Dynamically failover between volatile banking providers" sounds like a load balancer. Cross-border corridors are not EC2 instances. Provider B may not reach the same beneficiary, may require different KYC fields, may quote a different FX, may be closed today. A circuit breaker that dumps in-flight *unknown* work onto B is a duplicate payout machine. 35 protocols will not share one HTTP client wrapper without an anti-corruption layer.

**Decision**:
- One **adapter** per provider (or per rail product). The orchestrator speaks one internal command (`execute`, `query_status`). Classification tables are per adapter ([System Design §5](./03_system_design.md#5-outcome-classification)).
- Circuit breakers stop **new** dispatches to a sick rail. They do not re-route an `unknown` intent.
- Failover (send this *same* customer intent to a different provider) requires: (1) original execute classified as not-executed or terminal-failed, (2) corridor actually served, (3) fee/FX policy (quote, bound, or block), (4) a new `provider_request_id` scoped to the new rail, (5) a recorded reason. Automatic failover may be enabled **per corridor** after Phase 5 evidence, default **off** until then. Manual/ops failover uses the same transition.

**Consequences**:
- (+) Core ledger does not absorb 35 XML/ISO20022 dialects.
- (+) Failover cannot hide in a retry loop.
- (–) Adapter work dominates calendar time. Full 35-network coverage is a multi-year rollout, not an epic.
- (–) Many corridors have one viable rail; "dynamic failover" is empty there. Say so in the corridor matrix.
- (–) Product must decide who eats a worse FX on failover. Engineering will not pick silently.
- **Alternative rejected**: a generic "payments SPI" with reflection-driven mapping on day one, and failover as `catch (TimeoutException) { otherProvider.send(same) }`.
- **Alternative rejected**: treating all 35 as a single pool with health scores. Health is not interchangeability.
- **Revisit trigger**: a corridor with two contractually interchangeable rails, identical beneficiary schema, pre-agreed FX band, and proven classification. Then automatic failover can be switched on for **that corridor only**.

## ADR-006: Consistency Model Per Data Class

**Status**: Accepted

**Context**: A system that claims one consistency level for everything will either be slow (everything linearizable worldwide) or wrong (everything eventual, including "did we reserve this key"). Different data have different costs of being stale.

**Decision**:

| Data class | Consistency | Notes |
| --- | --- | --- |
| Intent reservation + journal + balances on a shard | Strict (ACID, primary) | The money we have acknowledged |
| Intent state as seen by GET after accept | Read-your-write on the primary; replicas may lag | GET for the payer should hit primary or a sync replica |
| Cross-region replica | Eventual | Not writable for reserve |
| Settlement vs bank reality | Eventual, converged by recon | `unknown` is the honest lag |
| Circuit breaker / rate-limit counters | Eventual, bias to *more* closed | Duplicate opens are worse than a false-closed that delays dispatch |
| Reporting / trial balance across shards | Eventual snapshot | Not a 100ms path |

See [Architecture Document](./02_architecture_document.md).

**Consequences**:
- (+) We can talk to finance and to latency stakeholders without using one word for two things.
- (–) On-call must know which store they are looking at. A replica `GET` showing `Reserved` while primary is `Settled` is not a payout bug.
- **Alternative rejected**: "eventual consistency everywhere" including the unique key.
- **Alternative rejected**: "linearizable global state" including settlement confirmation.
- **Revisit trigger**: a regulator demands a single worldwide snapshot at time T. That is a reporting job (stop-the-world snapshot of shards, minutes), not a change to accept-path consistency.

## ADR-007: Table-as-Queue Outbox First; Dedicated Broker When Measured

**Status**: Accepted

**Context**: Dispatch must not dual-write. A broker is the fashionable queue. It does not provide idempotency. At 20k TPS *accept*, the outbox publisher can become a bottleneck, but a broker on day one does not remove the need for the ACID outbox row (or an equivalent transactional publish).

**Decision**: Phase 1–4: transactional outbox table on the shard, workers with `SKIP LOCKED` (or a mature CDC publisher to a broker **from that table**). Introduce a dedicated broker as the *fan-out* mechanism when polling/CDC lag is the measured bottleneck — not because "payments should use Kafka." The intent row remains the source of truth. Broker delivery is at-least-once. See [Phased Implementation Plan — Phase 5](./06_phased_implementation_plan.md#phase-5--conditional-scale-out-multi-region-dr-failover-policy-and-broker).

**Consequences**:
- (+) Accept commit is one system.
- (–) Tables make mediocre queues under huge backlog. Gated.
- **Alternative rejected**: publish-only to a broker, `201` after broker ack, journal "later." Later may not come; `201` would be a lie.
- **Revisit trigger**: Phase 5 entry gates (lag, lock wait, CDC delay) in the implementation plan.
