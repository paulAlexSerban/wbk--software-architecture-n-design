# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Edge Admission Control / Load Shedding Is Mandatory

**Status**: Accepted

**Context**: Offered write traffic jumps from 5,000 QPS to 250,000 QPS in about five seconds. That is not "a busy day." It is a stampede: retries, bots, marketing-push synchronized clients, and honest humans. No inventory store, including a well-sharded cell table, has a p99 < 100 ms story if that wave is delivered unshaped to origin. Connection tables, TLS, orchestrator compute, and per-item DynamoDB (or equivalent) ceilings all fail in some order. The current incident already includes LB 504s, which are admission failure with extra steps.

The tempting line is "the new database is fast enough." That line is how the last database was sized.

**Decision**: Sale-scoped checkout and reserve paths go through **queue-based leveling** (waiting room or equivalent) plus a **hard origin QPS ceiling**. The orchestrator verifies an admission token. Unadmitted traffic never calls cells. Admission ships in Phase 1, *before* the cell service is authoritative. See [Architecture — Admission](./02_architecture_document.md#1-admission--edge).

**Consequences**:
- (+) Origin sees a number you chose. Latency budgets become falsifiable instead of decorative.
- (+) Bots and retries consume waiting-room slots, not cell capacity (they still consume slots — bot management is required, not implied).
- (–) Conversion is gated by the queue. Product will ask to "open the ceiling for this drop." That request is how you recreate the incident. The ceiling is a product-signed number, not an SRE secret.
- (–) Waiting-room UX is out of scope as fairness design; someone still has to implement *a* UX. A raw 429 is allowed. A delightful queue is not a Phase 1 gate.
- **Alternative rejected**: "Autoscaling will absorb it." Five-second ramps beat scale-out. Cold compute and cold database partitions are the first victims.
- **Alternative rejected**: Admission only at the cell layer (reject when hot). By then you have paid TLS, auth, and a stampeded orchestrator. Shed at the edge.
- **Revisit trigger**: a sale whose offered QPS is already below the store's comfortable ceiling *and* whose ramp is slow. Then a waiting room may be optional; a rate limit should remain. Do not remove admission because the last sale was small.

## ADR-002: CQRS Split — Stale Availability Reads vs Authoritative Inventory Writes

**Status**: Accepted

**Context**: p99 read < 30 ms and p99 reserve write < 100 ms cannot share a locked Postgres row. Serving `SELECT qty` from the primary on the product page during a sale recreates primary load. Serving it from a replica during a write storm is how the page sells stock the writer already exhausted. The page wants a number to render. The ledger wants a condition that cannot go negative.

**Decision**: **Reads** (product page, "N left") come from a **projection** (CDN + Redis `available_approx`) updated via CDC from cells/reservations. **Writes** that authorize a sale are only the cell conditional decrement. The read model is allowed to be wrong. It is not allowed to decrement. See [Architecture — Catalog Read](./02_architecture_document.md#2-catalog-read-service).

**Consequences**:
- (+) Read p99 is a cache problem. Sale traffic on a tiny SKU set is the best-case cache working set.
- (+) Primary/cell store is protected from browse traffic.
- (–) Users will see "in stock" and then sold-out at checkout. That is the correct failure. Product copy must say so or support will file it as a bug in the cache.
- (–) A future client or BFF that "optimizes" by skipping reserve when the cache says 0 (or the opposite: skipping when it says >0) will oversell or undersell. API design: no sell method on the read service.
- **Alternative rejected**: strongly consistent reads from the cell store on every product page. Misses the 30 ms budget under load and turns the cell store into the old primary.
- **Alternative rejected**: read-your-writes via the primary for logged-in users only. The sale is anonymous until checkout; the spike is the page.
- **Revisit trigger**: none for the sale path. Non-sale catalog can keep today's origin model.

## ADR-003: Cell-Sharded Counters in a Conditional-Write Store, not Postgres and not Redis-as-Truth

**Status**: Accepted

**Context**: The hot SKU is one row. Postgres row locks serialize that row at transaction-hold time. Sharding the cluster by `sku_id` leaves one row. Redis `DECR` is fast and, if it is the only truth, can enforce non-negative with `DECR` + check or Lua. Redis as truth fails this design's durability and region story unless the team is prepared to own persistence, replica promotion, and split-brain (Redis Cluster failover is not a fence). Two truths (Redis decrement *and* Postgres qty) is oversell with extra hops.

DynamoDB-style stores offer conditional `UpdateItem`, multi-AZ durable writes, and per-item partitioning. One item is still too hot at admitted sale QPS; **cells** split the item.

**Decision**: Finite-stock sale SKUs use **K cells** in a **quorum-consistent, conditional-write KV** (working default: DynamoDB). Decrement is `qty >= n` then `qty = qty - n`. Postgres is not on that path. Redis may front the *read projection*, not the decrement. See [System Design — Cell Geometry](./03_system_design.md#2-cell-geometry-and-pick-algorithm).

**Consequences**:
- (+) Per-key contention drops by ~K, modulo imbalance.
- (+) Zero oversell is a condition in the store, not a check in the app.
- (–) False sold-out when retries miss remaining qty in other cells. Operational gather/rebalance is extra machinery.
- (–) New store, IAM, capacity pre-warm, backup, and on-call skills. This is a large fraction of the program cost.
- (–) Cold SKUs should not all move on day one. Dual running (Postgres for tail, cells for sale SKUs) is a strangler, not a failure, if the *same SKU* is never decremented in both.
- **Alternative rejected**: "bigger Postgres, shorter transactions, PgBouncer." Necessary hygiene; insufficient for 250k-offered hot-key QPS.
- **Alternative rejected**: Redis as the authoritative counter with Postgres async follow. Fast until failover/split-brain. Durability of money-adjacent stock is not a cache problem.
- **Alternative rejected**: Kafka / event sourcing as the decrement (append events, project qty). Correctness requires a single-threaded apply per SKU or optimistic versioning equivalent to the conditional write, plus a compaction story, for worse latency. Use the store that already does conditional writes.
- **Revisit trigger**: vendor per-item ceiling still missed after K is large and admission is tight. Then the problem is admission, not K=4096. If the vendor cannot meet in-region p99, change vendor or region topology — do not return to `FOR UPDATE`.

## ADR-004: Two-Phase Reservation with TTL; Add-to-Cart Does Not Decrement

**Status**: Accepted

**Context**: Decrement-on-add-to-cart prevents oversell by treating a wish as a sale. Abandoned carts then hold the drop. Flash sales "sell out" in seconds to people who never pay. Decrement-only-on-paid-capture oversells because many checkouts race through payment. The third way is a **reservation**: decrement at checkout-start (or equivalent hold), expire if payment does not complete.

A decrement without a durable reservation record is a leak if the process dies. A reservation without a transactional pairing to the decrement is the same leak.

**Decision**: **Add-to-cart does not touch cells.** **Reserve** at checkout: one `Transact` (or equivalent) that decrements a cell and writes `reservation status=held` with `expires_at`. A **reaper** expires `held` rows and increments the **same** cell under a condition on status. Payment success sets `confirmed` (no increment). See [System Design — TTL](./03_system_design.md#4-reservation-ttl-and-reaper).

**Consequences**:
- (+) Oversell bound is the atomic condition; abandonment bound is TTL.
- (+) Cart remains a UX object and can be multi-region without being a ledger.
- (–) Users lose a hold if they pay slower than TTL (3DS). Late capture must refund, not confirm. Product must own TTL.
- (–) Griefing: admit + reserve + abandon holds stock for TTL. Mitigate with admission, bot control, per-user reserve caps — not by decrementing on page view.
- (–) Reaper bugs (double increment) create phantom stock. Reaper is not a cron one-liner; it is a correctness component.
- **Alternative rejected**: decrement on add-to-cart with a 24h cart TTL. Holds the sale in carts. Support nightmare. Also explodes write QPS to *add-to-cart* QPS, which is larger than checkout QPS.
- **Alternative rejected**: decrement only after `payment_succeeded`. Classic oversell window.
- **Alternative rejected**: vendor TTL delete on the reservation item as the release mechanism. Delete does not increment. Forbidden.
- **Revisit trigger**: product requires "hold at add-to-cart" for UX. That is this same reservation, moved earlier, with a *shorter* TTL and a much higher write rate. It is a new capacity plan, not a flag. Do not do it for the first sale.

## ADR-005: Order/Payment as a Saga, not a Distributed Transaction (2PC/XA)

**Status**: Accepted

**Context**: Reserve, persist order, charge processor, fulfill — four systems. 2PC/XA across OmniShop and a payment processor is not on offer. 2PC across DynamoDB and Postgres is how you couple availability and add a coordinator that fails at sale volume. The latency budget forbids holding cell operations open across processor RTTs.

**Decision**: **Choreographed/orchestrated saga**: (1) reserve commits independently; (2) payment is requested with **idempotency key = reservation_id**; (3) **webhook inbox** applies success/failure asynchronously — HMAC, durable persist, `202`, async apply, as in [prj--payment-webhook-ingestion](../../prj--payment-webhook-ingestion/README.md); (4) compensate by incrementing if still `held`. No XA. Postgres order rows are a projection, not a participant in the cell transaction. See [Architecture — saga diagram](./02_architecture_document.md#reserve--pay--confirmcompensate).

**Consequences**:
- (+) Each step has a timeout and a compensation. Processor slowness does not hold a cell lock (there is none) or a 100 ms budget.
- (+) Webhook retries cannot double-confirm if apply is status-gated.
- (–) Windows exist: paid but apply-lag (user-visible delay); expired then paid (refund). These are the saga's honest failures. They replace oversell and 504 storms.
- (–) Engineers will want to "just await the processor in the reserve request." That blows p99 and reintroduces pool occupancy. Rejected even if the processor is usually fast.
- **Alternative rejected**: 2PC between cells and Postgres. Coordinator, locks, and a new outage mode.
- **Alternative rejected**: synchronous payment inside the client-facing reserve call. Misses ASR-3.
- **Revisit trigger**: a processor that cannot webhook and cannot be polled. Then an OmniShop poller is still async, still saga, still not 2PC.

## ADR-006: PCI-DSS via Tokenization / Hosted Fields, not an In-House Card Vault

**Status**: Accepted

**Context**: PCI-DSS is a requirement. Building a card vault, PAN-encrypting monolith, and a CDE that scales with flash-sale checkout is a payments company. It also makes every checkout host in-scope, so horizontal scale is a compliance change. The flash-sale program would otherwise drag PCI into every capacity ticket.

**Decision**: **PAN/CVV never reach OmniShop servers.** Client uses a **Level-1 processor's hosted fields/SDK**. OmniShop stores tokens/references, amounts, and reservation ids. Refunds and captures use the processor API. SAQ level is determined by a QSA against the implemented client (A vs A-EP is not claimed here). Scale-out of checkout does not expand CDE if the constraint holds. See [System Design — PCI](./03_system_design.md#6-security-mechanics-pci-and-otherwise).

**Consequences**:
- (+) Checkout fleet is not a cardholder-data environment (if the implementation stays clean).
- (+) Processor owns vault, 3DS, and much of fraud tooling.
- (–) Processor outage is a sale outage for paid conversion. Inventory invariant still holds (holds expire). Do not fail-open stock because payments are down.
- (–) Tokens and hosted-field integration are a real client project. Logging discipline is part of architecture: one "log full processor response" reopens scope.
- (–) Not a multi-processor abstraction. A second processor is a new PCI review.
- **Alternative rejected**: in-house vault "so we are not dependent." Wrong company, wrong timeline, wrong risk for this incident.
- **Alternative rejected**: pass PAN through OmniShop to the processor (old API style). Keeps OmniShop in CDE. Forbidden for this design even if the processor allows it.
- **Revisit trigger**: regulatory requirement to use a local acquirer that has no hosted fields. Then a certified iFrame or a dedicated CDE enclave is a new program — still not "put PAN in the monolith."

## ADR-007: Cart Is AP Multi-Region; Inventory Is CP Single-Writer per SKU Home Region

**Status**: Accepted

**Context**: The scenario requires zero overselling, write p99 < 100 ms, cart surviving regional dropout, and global users. **CAP is not optional here.** Active-active writers on the same stock counter cannot guarantee zero oversell under partition (both sides decrement remaining qty). Sync cross-region writes on every reserve miss the 100 ms p99 (or make it luck). Cart divergence is a duplicated line, not a double sale, if checkout still reserves.

**Decision**: **Cart**: active-active, eventually consistent, conflict-tolerant (per-line LWW or union). Availability over cart consistency. **Inventory cells**: **single writer in a home region** per SKU, sync multi-AZ in region, async replica for DR. On home-region loss: **fail closed** (503) until a **fence** then promote. Never two writers. See [System Design — regional failover](./03_system_design.md#34-regional-failover-of-a-skus-home-region-fail-closed).

**Stated plainly:** you cannot have zero overselling, sub-100 ms writes, *and* seamless active-active multi-region writes on the same counter. This design picks **correctness + in-region latency**. It pays with **bounded checkout unavailability for SKUs pinned to a dead region**. Cart does not pay that price.

**Consequences**:
- (+) Oversell invariant holds across a partition. Cart is still there after a region death.
- (+) Reserve p99 is an in-region DynamoDB (or equivalent) hop, not a transatlantic consensus.
- (–) A region loss is a partial checkout outage. Product and comms must treat 503 as "try again," not "we will sell from the other region immediately."
- (–) Home-region pin implies SKU→region mapping (often "where the FC is" or "where the sale is hosted"). Global drops still have a home. Cross-region customers pay an extra edge hop to that origin; that is acceptable if it is not a cross-region *write protocol*.
- **Alternative rejected**: DynamoDB global tables (or equivalent) as *active-active inventory*. Conflict resolution on counters is last-writer-wins or additive merge — both can oversell or phantom-increment under concurrent decrements. Global tables may be acceptable for **cart**. They are not the inventory ledger.
- **Alternative rejected**: "CRDT counter" as a way to have both. PN-counters do not encode `qty >= 0` under partition the way a sale needs; you still centralize or you oversell. Research-grade CRDTs are not a Phase 3 plan.
- **Revisit trigger**: a vendor offers a true serializable global counter with <100 ms p99 worldwide. Believe measurements, not the slide. Until then, this ADR stands.
