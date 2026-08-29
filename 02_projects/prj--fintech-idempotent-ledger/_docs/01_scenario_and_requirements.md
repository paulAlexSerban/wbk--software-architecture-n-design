# FinTech Idempotent Ledger & Settlement Pipeline: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

PayGlobe is a cross-border remittance gateway. Peak load is 20,000 transactions per second across 35 regional banking networks. External banking APIs are slow, drop connections, and enter unannounced maintenance windows. Timeouts on outbound payment execution are therefore routine, not exceptional.

The current system relies on **client-side retries**. When a submit times out, the client resubmits. The first request often already executed at the bank. The retry executes again. Duplicate payouts have totaled millions in losses.

The platform requires a redesigned, immutable, double-entry financial ledger that:

1. Guarantees strict ACID properties across distributed datacenters.
2. Guarantees exactly-once execution via robust distributed idempotency.
3. Maintains a full audit trail.
4. Dynamically failovers between volatile banking providers.
5. Operates with a sub-100 millisecond end-to-end processing SLA.

This is the exactly-once / ACID / 100ms trap. The naive answer — a globally-replicated ACID ledger, a distributed idempotency store, and a 100ms clock that includes the bank call — is the failure. It treats mutually incompatible guarantees as a shopping list. Several of those sentences, taken literally, cannot be true together. This project documents the replacement that is actually buildable, and names every requirement that must be rewritten or refused.

## The Trap, Stated Directly

A timeout on an outbound payout is **not a failure**. It is an **unknown**. The bank may have:

- never received the request
- received it, queued it, and not yet responded
- executed it and failed to return a 2xx
- executed it twice because *they* retried internally

Client-side retry treats unknown as failed. That is how money is paid twice. Server-side "retry the same payload to a different provider" after a timeout is the same bug with a more impressive name: failover. Two providers, two payouts, one customer, one loss.

The second half of the trap is the SLA. Sub-100ms end-to-end, if "end-to-end" means "the beneficiary's bank has confirmed the credit," is not an architecture problem. It is a physics and counterparty problem. Inter-region RTT between major financial datacenters is often 30–80ms one way. A Raft/Paxos round for a globally-replicated write can consume most or all of a 100ms budget *before any bank is called*. The banking APIs themselves are frequently hundreds of milliseconds to tens of seconds, when they answer at all.

The correct shape is:

**A client-supplied idempotency key reserves a single payout intent in a regional, strictly ACID ledger before any bank is called. The HTTP response that meets a sub-100ms SLA means "we have accepted and uniquely reserved this intent," not "the money has landed." Outbound execution is at-least-once toward the bank, made *effectively-once* by never blindly retrying an unknown outcome. Cross-datacenter and cross-border movement is a saga with compensating entries, not a distributed ACID transaction. Failover is a business decision with a new idempotency scope, not a retry of the same call.**

That paragraph is the whole architecture. Everything else in this project is the honest cost of making it true under 20,000 TPS, 35 hostile APIs, and a regulator who will ask for the audit trail of every retry.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Client `POST`s a payout (amount, corridor, beneficiary).
2. API layer calls a banking provider synchronously.
3. On HTTP 200 from the bank, write a row that says "paid" and return 200 to the client.
4. On timeout or 5xx, return 5xx / 504 to the client.
5. The client retries the same POST, often with a new request ID, because the first one "failed."

That version appears to work in a staging environment that delivers each call once, against a mock bank that always answers in 40ms. It fails in production the first time a bank holds the request for 12 seconds, the load balancer kills the connection at 10, the bank executes anyway, and the client resubmits. There is no durable intent. There is no unique constraint on "this customer meant this payout once." There is a log line that says `timeout` and a second payout.

This project documents the replacement, not a patch of that handler.

## What "Duplicate Payout" Actually Is

Three distinct bugs get collapsed into one incident ticket. They need three distinct designs.

| Mechanism | What happened | What does *not* fix it |
| --- | --- | --- |
| **Client retry of a completed (or in-flight) submit** | Same business intent, two HTTP requests, two bank executions | Faster servers, larger timeouts, "please don't retry" in the API docs |
| **Server retry after timeout without knowing the outcome** | One HTTP request from the client, two bank executions from us | Exponential backoff. Backoff retries *sooner or later*; it does not answer "did the first call land?" |
| **Failover to a second provider after unknown outcome** | One intent, two rails, two credits | A circuit breaker. A breaker decides *who* to call, not *whether the first call already paid* |

The architecture must make the first harmless (idempotency key), make the second a hold-and-reconcile (never blind retry), and make the third an explicit, separately-keyed business decision (new intent, or a documented compensation, never a silent second send).

## Target Users

- **Owning engineer**: implements the accept path and the settlement worker; needs a rule they can defend at 2 a.m. — "do I retry this timeout or not?"
- **Payments / treasury on-call**: needs to know, from intent status and the attempt log, whether money is reserved, in-flight-unknown, confirmed, failed, or in manual review — without reconstructing TCP history.
- **Finance / reconciliation**: needs a double-entry journal whose balances are explainable, and a path that does not depend on "the bank said 200" as the sole source of truth.
- **Compliance / audit**: needs an immutable trail of who requested what, which provider was called, what the response (or lack of one) was, and who authorized a failover or a reversal.
- **Product / client-platform**: needs to know that a 201 in 80ms does **not** mean the beneficiary has been paid, and must change UX and client retry policy accordingly.

## Requirements as Stated vs Requirements as Rewritten

The scenario's shopping list is architecturally significant. Taken literally, parts of it are false. The table is load-bearing; the rest of the documents implement the right-hand column.

| Stated requirement | Honest rewrite | Why the literal form fails |
| --- | --- | --- |
| Strict ACID across distributed datacenters | Strict ACID **inside a regional ledger shard** (single primary, synchronous local replica as required by RPO). Cross-datacenter *replication* may be asynchronous. Cross-border *settlement* is not one ACID transaction. | A synchronous cross-region commit cannot also be sub-100ms in the general case. See [Architecture Document — Latency Budget](./02_architecture_document.md#latency-budget). |
| Exactly-once execution | **Effectively-once payout**: at-least-once toward the bank, idempotent at our intent layer, never a second bank execution for the same intent unless a human or a reconciliation job has proven the first did not land. | Exactly-once over an unreliable network to a party we do not control is not a real distributed-systems guarantee. See [ADR-001](./04_architecture_decision_records.md#adr-001). |
| Sub-100ms end-to-end processing | Sub-100ms **p99 for intent accept** (authz + idempotency reserve + pending journal entries). Bank confirmation is a separate, much slower SLO. | The 35 banks are not inside our 100ms budget. Pretending they are is how the current system times out and retries. |
| Dynamic failover between volatile banking providers | Failover **only after a terminal failure on the original rail**, or after an unknown is reconciled as "not executed." A different rail is a **new attempt with a new provider-scoped idempotency key**, with FX/fee/corridor implications treated as a business decision. | Many corridors have one viable rail, not 35 interchangeable ones. Failover after unknown is a duplicate payout with extra steps. See [ADR-005](./04_architecture_decision_records.md#adr-005). |
| Immutable double-entry ledger | Append-only journal. Corrections are reversing entries, never `UPDATE amount`. Balances are projections. | Agreed. This one is kept. |
| Full audit trail | Every intent, reservation, journal entry, provider attempt (request id, timing, outcome class), reconciliation decision, and manual override is retained under a retention policy finance signs. | Agreed, and it is operationally expensive. It is not a logging afterthought. |

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which corridors exist, fee schedules, the customer-facing receipt copy) are out of scope.

1. **A payout intent is identified by a client-supplied idempotency key**, scoped to a principal (merchant / originating institution / API client). The same key with the same payload is a replay. The same key with a *different* payload is a client error, not a new payout. See [ADR-001](./04_architecture_decision_records.md#adr-001).
2. **Money does not move at a bank until the intent is uniquely reserved** in the ledger. Reservation is a durable, ACID write. Two concurrent submits of the same key produce one reservation.
3. **Unknown outcomes are a first-class state**, not a timeout error. After a provider call whose success cannot be determined, the system does not send another execute. It interrogates (status API), waits, or reconciles against statements. See [ADR-004](./04_architecture_decision_records.md#adr-004).
4. **The ledger is double-entry and append-only.** Every state change that represents money (hold, capture, payout, fee, FX, reversal) is a balanced journal entry. "Paid" is a projection of those entries plus intent status, not a boolean column that gets flipped.
5. **ACID is local to the shard that owns the intent.** The shard key is chosen so that an intent's reservation, its journal entries, and its attempt log can commit together. Cross-shard work is a saga. See [ADR-002](./04_architecture_decision_records.md#adr-002).
6. **Accept latency is independent of provider latency.** The HTTP response for a new intent is "reserved / accepted." Provider dispatch is asynchronous. The 100ms SLA applies to accept, not to settlement.
7. **Provider adapters are the anti-corruption layer.** Each of the 35 networks has its own idempotency story (none / request-id / end-to-end id / "we will duplicate under load"). The core ledger never speaks a bank's protocol. See [ADR-005](./04_architecture_decision_records.md#adr-005).
8. **Reconciliation is part of the architecture**, not an incident procedure. Provider retry budgets, dropped connections, and silent executes are expected. A job that matches our attempt log to bank statements / webhooks / poll APIs is how unknown becomes known.
9. **Auditability is not optional.** An investigator can reconstruct, for any `intent_id`, the sequence of reservations, entries, attempts, and decisions without reading application logs as the source of truth.
10. **Backpressure is a feature.** 20,000 TPS of *accepts* does not imply 20,000 TPS of *bank executes*. The banks cannot absorb that. Accept can succeed while execute is queued, rate-limited, or shed toward a retry schedule. A design that couples accept success to execute success reintroduces the timeout trap at the front door.

## Success Criteria for the Design (Not Implementation Metrics)

1. Two concurrent `POST`s with the same idempotency key result in **one** reserved intent, **one** set of pending journal entries, and **at most one** in-flight execute at a provider. The second POST returns the first intent's current representation (not a second payout).
2. A provider timeout after send leaves the intent in `unknown` (or equivalent). A subsequent automatic path does **not** call execute again. Chaos test: kill the response after the adapter has sent; assert attempt count for `execute` remains 1 until reconciliation classifies the outcome.
3. An intent whose provider later confirms "not found / not executed" may be retried or failed-over **once the unknown is closed**. An intent whose provider confirms executed is never sent again.
4. A reversing journal entry, not an in-place update, is the only way to correct a posted amount. The original entry remains readable.
5. After a crash between "journal pending committed" and "provider call started," recovery does not double-send. After a crash between "provider 200 received" and "journal posted," recovery posts (or the reconciliation path does) without a second execute.
6. Regional shard failure: intents whose shard is unavailable cannot be accepted in another region as a *new* shard copy of the same key (that is a split-brain duplicate). Failover of *compute* onto a promoted replica of the **same** shard is in scope. Creating a second ledger for the same key is not.
7. Accept-path p99 can be engineered toward 100ms **without** waiting on a bank. Settlement confirmation p99 is measured separately and is allowed to be seconds to hours depending on the rail.
8. An auditor can export the full trail for an intent without SSHing to a box.

## Business Rules (Ledger- and Settlement-Scoped)

1. The accept handler's durable side effects are: insert-or-return the intent, write the reservation / pending entries, return. It does not call a bank.
2. Idempotency keys are required. A missing key is 400, not "we will invent one." Inventing a key per request is how retries become new payouts.
3. Idempotency key uniqueness is `(principal_id, idempotency_key)`. Keys are not global across all merchants.
4. Payload fingerprint is stored with the reservation. A replay with a different fingerprint is `409 Conflict` (or equivalent), never a second payout and never a silent ignore that looks like success.
5. Provider execute is allowed only from a worker that has claimed the intent in a state that permits execute (`reserved` / `ready_to_dispatch`). Claim is exclusive.
6. Outcome classes for a provider attempt are: `succeeded`, `failed_terminal`, `failed_retryable_not_sent`, `unknown`. Only `failed_retryable_not_sent` (we can *prove* the request never left, or the provider acknowledged reject-before-execute) may automatically retry execute on the same rail.
7. Failover to another provider requires: original attempt not in `unknown`, corridor actually served by the target, and a recorded reason (circuit open + terminal failure, or ops override). FX and fee differences are quoted or bounded; a failover that silently changes the customer debit is a product bug.
8. Client-visible states must distinguish `accepted` from `settled`. Collapsing them is how product rebuilds the timeout trap in the mobile app.

## Volume and Bottleneck Honesty (20,000 TPS)

20,000 TPS peak is real as a **front-door** number. It is not a number the 35 banks will honor on the execute path.

- **Accept path** (idempotency lookup + reserve + pending journal): this is a distributed database problem. It is solvable with regional sharding, a hot unique index on `(principal_id, idempotency_key)`, and an append-only journal. 20k TPS of small ACID transactions is serious engineering (connection pooling, shard design, contention on popular principals) but is in the realm of known payment-switch work.
- **Execute path**: even if each of 35 networks could take 600 TPS of payouts — they cannot, uniformly, and not at 3 a.m. in a region whose RTGS is closed — the *shape* is a queue with business-hours calendars, cut-off times, and per-rail rate limits. Most remittance volume will sit in `accepted, queued for rail` for seconds to the next clearing cycle.
- **Design implication**: the system that must do 20k TPS is the **intent ledger**, not the provider adapters. Treating adapter throughput as 20k TPS is how you DDoS a bank and get your access revoked.

Peak 20k is also not "average 20k." Capacity planning that provisions 20k of *execute* workers will waste money and still lose during a retry storm, because retry storms are burstier than organic volume. The unique constraint on the intent is what makes a retry storm cheap on the accept path. Nothing makes a retry storm cheap on the execute path except **not executing twice**.

## Non-Goals

- **Not a core banking system.** PayGlobe is a gateway and a ledger of *our* obligations and nostro/vostro positions against partners. It is not the system of record for a licensed bank's customer deposits, loans, or card issuing. Do not design general-ledger product complexity (chart of accounts UI, period close, IFRS-16) into v1. Design the journal so a real GL can subscribe later.
- **Not a solution to FX rate risk.** Cross-border payouts involve FX. The ledger must *record* the rate used, the fee, and the resulting entries. It does not invent a market-making desk. Failover that changes the rail may change the rate; that is a quoted decision, not a hidden retry.
- **Not a real-time fraud / AML engine.** Fraud screening may gate dispatch (a "hold for review" intent status). Building the screening models is out of scope. The ledger must have a place to wait without having already paid.
- **Not exactly-once as a slogan.** See the rewrite table. Anyone selling "exactly-once across 35 banks" is selling a slide.
- **Not a single global ledger with one serializable timeline.** See [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Not 2PC with the banks.** We cannot run two-phase commit against an institution that offers a REST timeout and a weekly maintenance window. See [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Not an implementation.** No code, no SQL migrations, no adapter binaries. Numbered steps and diagrams only.
- **Not a claim that this is cheap.** The honest alternative — "tell clients not to retry, raise the timeout to 60s, hope" — is cheaper to ship and will keep losing millions. This design is justified *because those losses already exist*. It is overkill for an internal transfer tool that moves points between two databases we own. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not sub-100ms to "money arrived."** If a stakeholder requires that sentence in a contract with a customer, this architecture **cannot meet it** for cross-border rails. The product or the contract has to change. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
