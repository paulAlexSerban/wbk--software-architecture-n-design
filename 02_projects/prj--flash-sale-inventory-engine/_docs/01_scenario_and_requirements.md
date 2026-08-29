# Flash Sale Inventory Engine: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

OmniShop is migrating its legacy monolithic e-commerce core to a distributed microservices model. The platform serves 15 million daily active users globally. During scheduled flash sales, write traffic surges from a baseline of 5,000 QPS to over 250,000 write QPS within a 5-second window.

The primary product catalog and inventory state currently reside in a primary-replica PostgreSQL cluster. During peak events, connection pool exhaustion and row-level locking on popular SKU records cause transaction deadlocks, cascading HTTP 504 timeouts to clients, and critical inventory overselling.

The design must answer, concretely:

1. Why the Postgres cluster dies at *this* kind of spike, and why "shard it / add replicas" does not fix it.
2. How a sale is authorized so that **zero overselling** is a mechanical invariant, not a monitoring hope.
3. How catalog/availability reads stay under p99 30 ms while inventory writes stay under p99 100 ms, *including* during the spike.
4. How payment stays PCI-DSS compliant without putting card data on OmniShop's write path.
5. What happens to cart state and checkout when a regional datacenter drops, and what is *not* promised.

This is the hot-key trap. The naive answer — shard the Postgres cluster, add more read replicas, raise `max_connections` — is the failure. It treats a *single-row write-contention* problem as a dataset-size problem. The replicas do not take writes. Sharding by SKU does not split contention on *one* SKU that 250,000 QPS all want to decrement in the same five seconds. Row-level locking serializes at disk/WAL speed, not memory speed.

The correct shape is: **meter the spike at the edge; serve availability reads from a stale cache that is not allowed to sell anything; split each hot SKU's stock into independently decremented cells in a lock-free conditional-write store; authorize a sale only by an atomic cell decrement with a TTL; confirm or compensate via a saga that never spans a distributed transaction; keep cart AP and inventory CP.**

That paragraph is the whole architecture. Everything else in this project is the honest cost of making it true under a 50× spike, a payment processor that is slower than the latency budget, and a regional dropout that must not invent stock.

## The Trap, Stated Directly

A flash sale is not "more traffic." It is a **fan-in onto a handful of keys**. Fifteen million DAU is a red herring for capacity planning of *this* incident. The catalog has millions of SKUs. The sale has dozens. Those dozens absorb almost all of the 250,000 write QPS. The working set of contended rows is tiny. The lock manager, the WAL, and the connection pool all queue behind those rows.

What fails, in order:

1. **Row-level `SELECT … FOR UPDATE` (or an `UPDATE … SET qty = qty - 1 WHERE qty > 0`)** on the hot SKU. Postgres is correct: it will not oversell *if the transaction commits*. It will also not complete 250,000 of those in five seconds. The lock wait queue grows. Lock timeout and deadlock-detector aborts start. Clients retry. Retries make the queue worse.
2. **Connection pool exhaustion.** Every in-flight checkout holds a connection for the duration of the lock wait plus the rest of the transaction (which, in the monolith, often includes payment or a call that looks like payment). The pool is sized for 5,000 QPS of mixed work, not for 250,000 QPS of the same row. New checkouts wait for a connection, then 504.
3. **Cascading 504s.** The load balancer idle-times out the client. The client retries. The original transaction may still be running. Two checkouts for one user, two decrements, or one decrement and one timeout that the user reads as "failed" while stock is gone. This is how overselling and "I paid and have no order" happen in the *same* incident.
4. **Read replicas do not help the write path.** Serving `SELECT qty FROM inventory` from a replica (or from a cache without a separate authorization step) is how you sell stock the primary already exhausted 200 ms ago. Replica lag during a write storm is not milliseconds; it is "whatever the WAL apply is behind," which is worst at the exact moment the number on the product page matters most.

Sharding the cluster by `sku_id` is the interview-complete answer and the production-incomplete one. After the shard, the hot SKU is still one row on one primary. You have moved the deadlock onto a smaller, hotter machine. Horizontal scale of the *dataset* is the wrong axis. The axis that matters is **contention per key**.

The "absolute zero overselling" requirement makes the other naive fix — cache the counter in Redis and `DECR` it — incomplete unless that Redis is the *only* authorizer of a sale, is durable across AZ loss, and is not racing a still-authoritative Postgres row. Two sources of truth for stock is how you oversell with a clean architecture diagram.

## Current State (Assumed Starting Point)

A typical first version of this path looks like:

1. Product page reads `inventory.qty` from Postgres (primary or replica) on every request, or through a short TTL cache that is still allowed to drive "Add to cart" / "Buy now."
2. Add-to-cart writes a cart row and, in some versions, decrements inventory immediately so the item cannot be stolen. Abandoned carts then hold stock until a nightly job, or forever.
3. Checkout opens a DB transaction, locks the SKU row, checks qty, inserts an order, calls a payment SDK (card data on OmniShop servers or close enough to be in PCI scope), commits.
4. Flash-sale start is a cron that flips a flag. There is no waiting room. The spike is the internet arriving at the origin.

That version will appear to work in staging with 200 concurrent users and a SKU that has 10,000 units. It will fail in production the first time a limited drop (500 units, one SKU, celebrity-timed) meets a 5-second stampede. Overselling will be discovered by warehouse short-picks or by finance reconciling captured payments against fulfillable lines. The 504s will be discovered by Twitter.

This project documents the replacement, not a patch of `max_connections`, `deadlock_timeout`, or PgBouncer pool size. Those knobs are Phase 0 evidence. They are not the architecture.

## Layer-by-Layer Fault Tree (Flash Sale Specifically)

Walk the path. At each layer, name only what fails *because of the spike and the hot key*, or *because the spike makes a shared resource scarce*. Generic "the region is down" is in scope only where it intersects cart and inventory consistency.

### Edge / CDN / load balancer

- **No admission control.** 250,000 write QPS in five seconds is a thundering herd. Origin connection tables, TLS handshakes, and app thread pools fill before inventory is even touched. The inventory design never gets a chance to be the bottleneck; the edge is.
- **Retry amplification.** 504 at the LB looks like "try again" to the client and to mobile OS retry logic. The second wave is larger than the first and arrives while the first is still holding locks.
- **Global anycast to the wrong region.** Users land in a healthy edge POP whose origin path still funnels to one database primary. Edge scale is not origin scale.

### Application / monolith

- **Synchronous checkout that includes payment.** Payment authorization is hundreds of milliseconds to seconds, and is not in OmniShop's p99 budget. Holding a DB lock or a pool connection across that call is how a slow processor turns into a site-wide outage.
- **Thread/worker occupancy proportional to lock wait.** Same shape as the large-file-upload FPM problem, different resource: the scarce thing is connections and row locks, not temp disk.
- **Idempotency missing on checkout POST.** Double-submit and client retry create double orders, which create double decrements or double captures.

### PostgreSQL primary

- **Hot-row lock queue.** One `tuple` lock. Throughput of that key is ~1 / (lock hold time). If hold time is 5–20 ms in the happy path and seconds in the payment-in-transaction path, the key's ceiling is tens to a few hundred QPS, not 250,000.
- **Deadlocks** when checkout also locks related rows (reservations, warehouse allocations, user credit) in inconsistent order. The deadlock detector aborts one transaction; that client 504s; the survivor continues; stock accounting diverges from what users were told.
- **WAL and autovacuum** on a row updated hundreds of thousands of times per minute. Index and heap bloat, wraparound risk is a later problem; *latency* of each update is the now problem.
- **`max_connections` and pooler queue.** Even with PgBouncer, the primary's useful concurrency for *this row* is not the pool size. A large pool waiting on one row is a large pile of idle-in-transaction connections, which is worse than a small pool that sheds load.

### PostgreSQL replicas

- **Lag during write storm.** Availability numbers on the product page are from the past. If the page is allowed to sell, you oversell. If it is not allowed to sell, the replica was never the write path and adding more of them does not raise write QPS.
- **Connection storms from read traffic** (product page, "only 3 left") can still starve the primary if they share a cluster or a noisy neighbor on IOPS. This is secondary. The primary lock is the incident.

### Payment / PCI

- **Card data on OmniShop hosts** (even briefly) pulls the checkout fleet into PCI-DSS scope. A flash-sale scale-out of that fleet is a compliance event, not just a capacity event.
- **Processor timeout vs. inventory commit order.** Capture-then-decrement oversells on processor success + inventory fail. Decrement-then-capture leaves paid-for stock if you decrement after capture but the opposite order leaves reserved stock and angry users. Without a reservation TTL and a saga, both orders are wrong.

### Regional dropout

- **Cart in the monolith DB.** A region loss loses in-progress carts if they were primary-local. The requirement forbids that.
- **Split-brain inventory.** The temptation in a dual-region "active-active" rewrite is to decrement stock in both regions. That is how you sell 500 units 500 times twice. Fail-open multi-region writes on inventory are the oversell bug with better branding.

## What to Check First, and Why That One First

**Check first: Postgres lock and wait-event evidence for the flash-sale window, plus checkout path traces that show what is held while a connection is checked out of the pool.**

This is a read-only check against the incident you already had (or a load-test replica of it). It partitions the entire fault tree in hours, not a quarter.

| What you see | What it isolates | Why it is cheap |
| --- | --- | --- |
| `LockWaits` / `tuple` wait events concentrated on a few `inventory` (or equivalent) `ctid`s / SKUs | Hot-key lock, not "the database is too small." Stop blaming table size. | `pg_stat_activity` / `pg_locks` / RDS Performance Insights already have this. |
| Deadlock counts spiking in the same window, involving inventory + order/payment tables | Lock-order bug on top of the hot key | Deadlock reports in the Postgres log. |
| Pool wait time and `504` duration clustered on the LB idle timeout (often 60s) | Clients never reached a commit; retries in flight | LB access logs vs. app traces. |
| Checkout spans payment SDK inside the same DB transaction | Connection hold time is processor-bound | One trace. If this is true, no Postgres tuning fixes the pool. |
| Oversell count ≈ successful checkouts − stock, with replica-served qty on the product page | Read path was allowed to authorize | Compare page `qty` source to write source. |
| Spike shape: 50× in ≤5s, error rate following the spike not the absolute QPS | Missing admission control; the origin never had a chance | CDN/WAF/LB metrics. |

**Why not "add replicas" first.** Replicas are the trap. They make the product page faster and the oversell worse, or they do nothing for writes. Measure the wait event. If it is `Lock:tuple` on the SKU, replicas are off the table as a write fix.

**Why not "raise max_connections" first.** A larger pool waiting on one row is a larger outage: more idle-in-transaction, more WAL, more 504s that look like progress because more clients are "in checkout." Shed load; do not enlarge the queue.

**Second check, only after the lock partition:** whether add-to-cart decrements stock; whether checkout is idempotent; whether card data touches OmniShop servers; where cart is stored and whether it is region-local. Third: the actual SKU working set of the last sale (how many SKUs ate 95% of writes). That number sizes cell sharding and tells you whether this is a 3-SKU problem or a 3,000-SKU problem. Both are hot-key problems; the operations differ.

## Target Users

- **Owning engineer / checkout platform**: implements reservation and saga; needs an invariant they can test (oversell = 0) and a latency budget they can fail a CI gate on.
- **SRE / on-call**: needs to know, from cell metrics and admission-queue depth, whether the site is correctly shedding or incorrectly selling; needs a regional-failover runbook that fails closed on inventory.
- **PCI / compliance**: needs a written data-flow that shows PAN/CVV never on OmniShop systems, and a scope diagram that does not expand when checkout horizontally scales.
- **Finance / inventory ops**: needs reconciliation between cell sums, reservations, captured payments, and warehouse stock; needs to know that the product-page number is not the ledger.
- **Product**: needs to know that "absolute zero overselling" plus "never lose a cart" plus "checkout never fails when a region dies" is not one system. They pick, in writing, which failure the customer sees during a regional outage.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which promo badges render, which wallets are offered) are out of scope.

1. **Zero overselling is an invariant of the write path.** A unit of stock cannot be reserved twice. The product-page count is not an authorization. Cache, CDN, and replica lag may lie about availability; they must not be able to complete a sale.
2. **p99 catalog/availability reads < 30 ms.** Product pages and "units left" badges are a read model. They will be stale. Stale-and-fast is required; consistent-and-locked is how the current primary dies.
3. **p99 inventory-reserve writes < 100 ms.** The reserve call (atomic cell decrement + persist reservation/saga state) must meet this. **Payment authorization is not in this budget.** If payment is on the reserve path, the requirement is already missed.
4. **A 5-second 50× write spike must not be delivered raw to the inventory store.** Admission control (waiting room / queue-based leveling, plus hard rate limits) is in scope as architecture, not as a WAF footnote. Without it, the latency budgets are fiction.
5. **PCI-DSS: no PAN/CVV on OmniShop systems.** Tokenization via a Level-1 processor's hosted fields/SDK. OmniShop handles tokens, order ids, and amounts. Checkout scale-out must not enlarge cardholder-data environment (CDE) scope.
6. **Regional datacenter dropout must not lose cart state.** Cart is a different consistency class than inventory. Cart may converge; inventory may not fail open.
7. **Checkout during inventory-home-region loss fails closed** for SKUs whose cells live in the lost region: no sale, no invented stock. Bounded unavailability for those SKUs is accepted. Fail-open is oversell.
8. **Abandoned checkout must not hold stock forever.** Reservations expire and re-increment. The TTL is a business parameter with operational teeth (too short: users lose items while paying; too long: sale looks sold out while stock sits in dead checkouts).
9. **Payment confirmation is at-least-once and must be applied idempotently.** Processor webhooks retry. Double capture-apply must not double-fulfill. This reuses the workbook's webhook-ingestion shape (HMAC, durable inbox, ack, async apply); it is not redesigned here.

## Success Criteria for the Design (Not Implementation Metrics)

1. A load test of the sale's real SKU working set, at 250k reserve QPS after admission, produces **zero** units reserved above seeded stock (cell sums + in-flight reservations never exceed seeded qty).
2. Product-page availability reads p99 < 30 ms during that test; they are allowed to show "in stock" for a SKU whose cells are already at zero, provided checkout then refuses.
3. Reserve-path p99 < 100 ms excluding payment; payment p99 is measured separately and is not a gate for the inventory invariant.
4. Admission: origin inventory-write QPS is capped at a configured ceiling; excess sits in the waiting room or is 429'd. Origin 504 rate from pool exhaustion is gone in the test, or the test is invalid.
5. A killed checkout that never reaches payment returns stock to cells within TTL + reaper interval.
6. Duplicate payment webhooks for one order do not double-confirm or double-release.
7. Chaos: kill the inventory home region for a SKU. Checkout for that SKU does not succeed against a second writer. Cart for users in other regions remains readable.
8. Card data does not appear in OmniShop logs, disks, or packet capture of app hosts in a scoped PCI review of the new path.

## Business Rules (Checkout-Scoped)

1. **Add-to-cart does not decrement inventory.** Cart is a wish. Stock moves only at reserve (checkout start, or an explicit "hold for payment" step that *is* checkout).
2. **A sale is authorized only by a successful conditional decrement of a cell.** Everything else is informational.
3. **One reservation per (order attempt, SKU, qty)** with an idempotency key from the client/session so retries do not eat two cells.
4. **Reservation TTL** is bounded (working default: 8–15 minutes, covering payment UX + 3DS, not a day). Payment that completes after expiry must re-reserve or fail; it must not confirm against an expired reservation.
5. **Cells of a SKU sum to the allocatable stock.** Warehouse receipts and manual adjustments land on the write path (rebalance into cells), not on the read cache.
6. **Oversell of a promotional "unlimited" SKU is out of scope** — if the business sets qty to a sentinel meaning unlimited, that SKU is not on this engine. This engine is for finite stock.
7. **PCI: OmniShop never stores, processes, or transmits PAN/CVV.** Tokens only. Refunds and captures use the processor's token/reference.

## Non-Goals

- **Not a full order management, warehouse, or returns platform.** Allocation to FC, split shipments, and returns put stock back through a different process. The engine exposes "reservation confirmed / released." OMS consumes that.
- **Not a fraud, tax, or pricing engine.** Those may sit on the checkout saga as additional steps. They must not hold the cell lock (there is no cell lock) or the reservation without their own timeout story.
- **Not a multi-processor payment abstraction.** One Level-1 processor for card-present-on-their-hosted-fields. A second processor is a new adapter and a new PCI review, not a plugin framework.
- **Not a fairness or UX design for the waiting room.** Admission is required. Whether the user sees a queue number, a lottery, or a 429 is product. The architecture requires a cap, not a delightful queue.
- **Not a general CQRS platform.** Catalog and inventory reads are the read model. Do not rebuild orders, customers, and CMS as event-sourced microservices to make this sale work.
- **Not a from-scratch card vault or in-house payment switch.** That is a company, not a phase.
- **Not an implementation.** No Terraform, no DynamoDB table definitions as code, no checkout UI. Numbered steps and diagrams only.
- **Not a claim that this is cheap or fast to ship.** The honest alternative — admission control + stop decrementing on add-to-cart + stop calling payment inside a Postgres transaction — is cheaper and will stop the *worst* of the 504s and some of the oversell. Cell sharding is justified when the remaining bottleneck is still one hot key at sale-level QPS. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
- **Not seamless active-active inventory writes.** Required to be said once: **you cannot have zero overselling, sub-100 ms writes, and seamless multi-region writes on the same stock counter.** This design picks correctness and latency. Regional failover of inventory is a bounded outage for affected SKUs, not a second writer.

## Numbers Used as Design Parameters (Not Marketing)

| Parameter | Value | Role |
| --- | --- | --- |
| DAU | 15 million | Context; does not size the hot-key path. |
| Baseline write QPS | 5,000 | Mixed checkout; not the sale. |
| Flash-sale write QPS | 250,000 in a 5s ramp | After admission, the *admitted* reserve QPS is lower; 250k is the *offered* load. |
| Read p99 | 30 ms | Read model + CDN. |
| Reserve write p99 | 100 ms | Cell conditional write + saga persist. Payment excluded. |
| Working default cells per hot SKU (K) | 64–256 | Sized so per-cell QPS is within the store's per-item ceiling with headroom. See [System Design](./03_system_design.md). |
| Reservation TTL | 8–15 minutes | Payment UX vs. stock hostage. |
| Cell-retry bound | 2–4 alternate cells | Tail latency vs. false sold-out. |
