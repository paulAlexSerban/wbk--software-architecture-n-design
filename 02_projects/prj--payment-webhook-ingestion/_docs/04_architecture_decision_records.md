# Architecture Decision Records

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Async Processing + `202 Accepted` vs Synchronous Business Write + `200`

**Status**: Accepted

**Context**: The endpoint receives payment-provider webhooks. The provider retries on any non-2xx, with a short timeout. The naive handler verifies the request, writes payment business state (and maybe fires side effects), then returns `200`. That couples the provider's retry clock to downstream work. A timeout after commit looks like non-delivery and produces a retry of an already-applied event. A slow fulfillment call turns one event into a retry storm. The problem statement also asks what happens if a DB write fails *after* 2xx — which, if the business write is on the request path, is an unrecoverable split: the provider will not retry, and there is no durable copy except whatever committed (or did not).

**Decision**: The HTTP handler verifies the request, persists the raw event to a durable inbox, and returns `202 Accepted`. Payment-state mutation and side effects run in an async worker. `202` is returned only after the inbox insert commits. 5xx is used only when that insert cannot be completed. See [Architecture Document — Status-Code Policy](./02_architecture_document.md#status-code-policy).

**Consequences**:
- (+) Provider retries stop as soon as we have a durable copy. Internal failures are retried by us.
- (+) Handler latency is bounded by verify + one insert, independent of payment-state contention or outbound APIs.
- (+) The post-ack failure case is well-defined: the inbox row is the recovery handle.
- (–) Payment state is eventually consistent with the provider. Product flows that assumed "webhook 200 means we have updated the order" are now wrong and must be changed.
- (–) More components (inbox, worker, DLQ, reconciliation) than a 40-line handler. Operational cost is real; see [Brutal Honesty](./02_architecture_document.md#brutal-honesty).
- **Alternative rejected**: synchronous write + `200` with "we will make every write idempotent." Idempotency is still required in this design; it does not fix timeouts, retry storms, or the lack of a recovery handle when 2xx is sent after a write that later needs replay without the payload.
- **Revisit trigger**: none for the accept-and-defer shape while this remains a payment webhook. A non-financial, low-volume webhook may choose the rejected alternative explicitly.

## ADR-002: Idempotency Key = Provider `event_id` (Unique Constraint), Payload Hash Secondary

**Status**: Accepted

**Context**: Duplicate delivery is guaranteed by the provider's contract (retries, at-least-once). Application-level "check if we have seen this ID" races under concurrent duplicates. Some providers have historically shipped missing or recycled IDs; hashing the payload is a common backup. Using only a payload hash fails when the same business event is re-sent with a different envelope (timestamp, request id) — those would look new and double-apply.

**Decision**: Primary idempotency key is `(provider, event_id)` enforced by a unique constraint on the inbox. A payload hash is stored and may be used as a *secondary* collision check or forensic signal when `event_id` is missing (those requests are `400`, not silently hashed) or when investigating suspected provider bugs. Process-time idempotency still checks whether this `event_id` was already applied, because worker retry is a different duplicate class than HTTP duplicate delivery. See [Architecture Document — Idempotency Guard](./02_architecture_document.md#4-idempotency-guard) and [System Design — Worker](./03_system_design.md#3-worker-claiming-and-applying).

**Consequences**:
- (+) Concurrent HTTP duplicates collapse to one row without a distributed lock.
- (+) Worker retries of the same row do not create a second row; they re-enter apply, which must itself be idempotent.
- (–) If the provider reuses `event_id` for a *different* payload, the second event is dropped. That is a provider bug; the payload hash mismatch should alert, not silently overwrite.
- (–) Unique-violation handling must be coded as success (`202`), not as `409`/`500`.
- **Alternative rejected**: Redis SETNX of event IDs without storing the payload — acks without replay capability.
- **Revisit trigger**: a provider with no stable event IDs. Then a documented hash-of-canonical-payload key might become primary, with the known double-apply risk if envelopes differ.

## ADR-003: Ordering via State-Machine Apply-If-Newer, Not Assumed Delivery Order

**Status**: Accepted

**Context**: Events arrive out of order. Two common designs: (a) force a total order (global queue, or FIFO per resource) and apply in arrival-made-sequential order; (b) treat each event as a candidate update to an object and apply only if it advances version / is a legal transition. FIFO does not actually guarantee the *provider sent* in order, and DLQ re-drives plus reconciliation reintroduce disorder.

**Decision**: Reconstruct order from data on the event: apply a snapshot when its version/timestamp is newer than `payment_state.last_applied_version`; mark stale events `ignored_stale`. Maintain a legal transition graph so skipped states still drive the right side effects. Per-resource FIFO is an optional later enhancement to reduce stale applies, not the correctness mechanism. See [System Design — Ordering Strategy](./03_system_design.md#4-ordering-strategy).

**Consequences**:
- (+) Correct final state even when `refunded` arrives before `succeeded`, provided side effects are status-driven.
- (+) Workers can process different `resource_id`s in parallel without a global lock.
- (–) A switch/case on `event_type` is insufficient. Side-effect logic is harder. Teams will under-implement this and only update a status column.
- (–) `ignored_stale` must be a first-class outcome, not an error, or on-call will treat correct behavior as failure.
- **Alternative rejected**: "buffer until we have a contiguous sequence." Predecessors that never arrive deadlock the buffer; the provider's retrieve API is the way to fill gaps, via reconciliation, not an in-memory wait.
- **Revisit trigger**: if a provider documents a strict per-resource sequence number *and* never violates it *and* never requires reconciliation inserts, FIFO can be added as an optimization. The apply-if-newer guard stays.

## ADR-004: Durable Inbox as a Database Table First, Dedicated Broker Later

**Status**: Accepted

**Context**: The raw event must be durable before `202`. Options: (a) insert into the same relational database that holds `payment_state`, poll with `SKIP LOCKED`; (b) publish to SQS/Kafka/NATS and use the broker as the inbox; (c) both (transactional outbox). A broker is the usual "serious" answer and is also more infrastructure, more failure modes (publisher vs consumer vs broker outage), and does not provide idempotency by itself (at-least-once consumers still need the unique key).

**Decision**: Phase 1–4 use a relational table as the inbox and as the worker's queue. Move to a dedicated broker only when measured thresholds are hit (polling contention, depth, latency) — [Phase 5](./05_phased_implementation_plan.md#phase-5--conditional-scale-out-to-a-dedicated-broker). The unique constraint remains on the inbox table even after a broker is introduced; the broker is a delivery mechanism, not the source of truth for "have we seen this event."

**Consequences**:
- (+) One transactional system for "insert event" and, later, "apply payment_state + mark applied." No dual-write on the accept path.
- (+) Operable with skills the Express/Postgres (or equivalent) team already has.
- (–) Tables make mediocre queues. A large backlog will punish a naive `WHERE status = 'received'` query. This is accepted and gated.
- (–) No native pub/sub to fan out to many independent consumers. A second consumer in Phase 1 means a second poller or an explicit outbox. Fine for one worker pool.
- **Alternative rejected**: broker-only accept path with no inbox table — acking SQS is not the same as recording `event_id` for exactly-once apply, and poison-message handling without a queryable store is worse for reconciliation.
- **Revisit trigger**: Phase 5 entry gates in the implementation plan (depth, lock wait, handler insert latency under retry storm).

## ADR-005: HMAC Over Raw Request Body; No Parse-Then-Restringify

**Status**: Accepted

**Context**: Payment providers sign the exact bytes they sent. Express's default `express.json()` parses and discards those bytes. Re-serializing with `JSON.stringify` produces a different byte string (key order, whitespace, unicode escaping) and HMAC verification fails — either always (outage) or, worse, only for some payloads (intermittent, "works in tests with fixtures we stringified ourselves"). Computing HMAC on parsed fields is not what the provider signed.

**Decision**: This route captures the raw body (Buffer) *before* JSON parsing. HMAC is computed on those bytes (plus timestamp, per provider canonical string). JSON parse happens *after* verification, from those same bytes. App-wide JSON middleware is skipped or overridden for this path. Tests use provider-signed fixtures (or a local signer over unmodified bytes), never a round-tripped object. Secret rotation verifies against current then previous key.

**Consequences**:
- (+) Signatures match production traffic.
- (+) Replay window can include the timestamp that was actually signed.
- (–) Easy to break with a one-line middleware change. This is a recurring production incident class; the Phase 1 exit gate requires a real signed-payload test.
- (–) Raw-body capture has a size limit (DoS). Enforce a max body size on this route.
- **Alternative rejected**: "verify on JSON.stringify(parsed)." It will fail against real providers. It may pass in tests. That combination is how this bug ships.
- **Revisit trigger**: none. If a future provider signs a parsed canonical JSON (JWS over claims), that is a different verifier, still not "stringify our object."
