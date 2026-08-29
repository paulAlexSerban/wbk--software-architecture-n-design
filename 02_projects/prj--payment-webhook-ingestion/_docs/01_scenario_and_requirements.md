# Payment Webhook Ingestion: Scenario and Requirements

## Problem Statement

You own an Express endpoint that receives webhooks from a payment provider. The provider:

- retries on any non-2xx response
- sometimes delivers the same event twice
- occasionally delivers events out of order

The design must answer, concretely:

1. How the request is verified as genuine.
2. What happens *before* responding, and what is deferred.
3. Which status code is returned, and when.
4. How duplicate delivery is made harmless.
5. How events arriving out of order are handled.
6. What happens if a database write fails *after* a 2xx has already been returned, and how the system recovers.

This is the webhook trap. The naive answer — verify the signature, write the business-state update, then return `200` — is the failure. It couples the provider's retry clock to downstream work, makes timeouts look like non-delivery, and leaves no clean recovery when the write that mattered happens after the ack.

## The Trap, Stated Directly

Standard webhook design requires **immediate acknowledgement of receipt**, not of *processing*. If the handler writes to the business-state database (mark payment paid, fulfill order, send receipt) *before* responding, the design has already failed the problem:

- The provider's timeout is typically a few seconds. Any slow downstream write, lock contention, or third-party call turns a successful receipt into a retry storm.
- A timeout after the write committed but before the TCP response is observed by the provider produces a duplicate delivery of an event that was already applied.
- A crash between "write succeeded" and "response flushed" is indistinguishable, from the provider's point of view, from "never received."

The correct shape is: **validate HMAC, persist the raw payload to a durable inbox (queue or table), immediately return `202 Accepted`, process asynchronously using the provider's event ID as an idempotency key.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under retries, duplicates, out-of-order delivery, and post-ack failure.

## Current State (Assumed Starting Point)

A typical first version of this endpoint looks like:

1. Parse JSON body.
2. Look up the payment.
3. Apply the event (update status, maybe enqueue fulfillment).
4. Return `200`.

That version will appear to work in a staging environment that delivers each event once, in order, with a healthy database. It will fail in production the first time the provider retries, the first time two workers apply `charge.succeeded` twice, the first time `charge.refunded` arrives before `charge.succeeded`, or the first time the process dies after flushing `200` and before the write that the operator thought was "already done."

This project documents the replacement, not a patch of that handler.

## Target Users

- **Owning engineer**: implements and operates the endpoint; needs a status-code policy they can defend in an incident.
- **Payments/ops on-call**: needs to know, from logs and inbox status, whether an event was received, is in-flight, was applied, or is dead-lettered — without reconstructing TCP history.
- **Finance/reconciliation**: needs a path that does not depend on "the webhook arrived" as the sole source of truth when the inbox and the provider disagree.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which payment states exist, which emails get sent) are out of scope.

1. **At-least-once delivery must be tolerated.** The provider will retry. Duplicate delivery of the same `event_id` must not double-apply a side effect (double credit, double fulfill, double refund).
2. **Ordering is not guaranteed.** The system must produce a correct *final* state for a payment object even when events for that object arrive in the wrong order. Correctness must not depend on the network delivering a total order.
3. **Authenticity must be cryptographically verified** before any durable write that the system will later treat as trusted. HMAC over the *raw* request body, with a timing-safe compare, and a timestamp/replay window. Unverified payloads are rejected and never enqueued.
4. **Response latency must be independent of downstream processing time.** The HTTP response budget is "verify + one durable insert," not "apply business logic + call other services." The provider's retry timer must not be the system's processing SLA.
5. **Business-state mutation must be idempotent.** Applying the same event twice, or applying a stale event after a newer one, must leave the payment object in the same state as applying the intended sequence once, in order.
6. **Recovery from partial failure must not require manual data reconciliation as the primary mechanism.** A human looking at a DLQ is a last resort. The primary recovery path is: the raw event is already durable, the worker retries, and a reconciliation job can re-drive from the provider's retrieve/list-events API.

## Success Criteria for the Design (Not Implementation Metrics)

1. A duplicate delivery of an already-accepted `event_id` returns `202` (or equivalent 2xx) and does not create a second inbox row, and does not re-apply side effects.
2. An invalid signature never produces an inbox row and never returns 2xx.
3. The HTTP handler does not perform business-state mutation. If the worker is down, the endpoint still acks, and events accumulate as unprocessed inbox rows.
4. After a crash that occurs *after* `202` is returned and *before* business state is committed, replaying the inbox converges to the same business state as if the crash had not occurred.
5. An out-of-order pair such as `charge.refunded` before `charge.succeeded` (or a stale `pending` after `succeeded`) does not corrupt the payment object's state.

## Business Rules (Ingestion-Scoped)

1. The HTTP handler's only durable side effect is inserting (or detecting an existing) raw event. It does not update payment status, send email, or call fulfillment.
2. A 2xx is returned only after the raw event is durably persisted, or is already present (duplicate). A 2xx is never returned "optimistically" before the insert commits.
3. Signature verification failures and unparseable payloads are 4xx: the provider should *not* retry; retrying will not make a bad signature good.
4. 5xx is reserved for "we could not durably accept this event." That is the *only* case where asking the provider to retry is the right behavior.
5. The provider's `event_id` is the primary idempotency key. A payload-hash fallback exists for the case where a provider's IDs are missing or collide — see [ADR-002](./04_architecture_decision_records.md#adr-002).
6. Side effects that are not naturally idempotent (send email, call a fulfillment API with no idempotency key of its own) must carry *this system's* idempotency key derived from `event_id`, or be gated on a "first successful apply" flag stored with the event.

## Non-Goals

- **Not a payment ledger or accounting system.** No double-entry bookkeeping, settlement, or payouts. The payment object is a state machine plus the fields needed to apply events; it is not a general ledger.
- **Not a multi-provider abstraction.** One provider's webhook contract is assumed. A second provider would be a new inbox partition and a new verifier, not a plugin framework designed up front.
- **Not an implementation.** No Express code, no SQL migrations, no worker binaries. Numbered steps and diagrams only.
- **Not a replacement for the provider as source of truth.** Webhooks are a hint that something changed. The provider's retrieve API remains authoritative for reconciliation. Designing as if the webhook stream is complete and lossless is how money goes missing.
- **Not a claim that this is cheap.** The honest alternative — a synchronous handler with a unique constraint and a prayer — is cheaper to build and will work until it does not. This design is justified when lost or double-applied payment events are expensive. It is overkill for a low-volume, non-financial notification webhook. That distinction is load-bearing; see [Architecture Document — Brutal Honesty](./02_architecture_document.md#brutal-honesty).
