# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone opens a DynamoDB table.

The expected answer is a microservices slide: sharded inventory, Redis, Kafka, multi-region active-active, PCI in a box. Parts of that slide are correct. Most of it is how you spend four quarters and still oversell, because the problem was never "too few services." It is **one hot key, an unshaped 50× spike, and a lock held across payment**.

## 1. What I would build

A **shaped write path** whose only seller is an atomic conditional decrement, and a **deliberately dumb read path**.

- **Waiting room + origin QPS ceiling** on checkout/reserve, before any new store. [ADR-001](./04_architecture_decision_records.md#adr-001).
- **Availability as a cache.** CDN + Redis `available_approx`. The page cannot sell. [ADR-002](./04_architecture_decision_records.md#adr-002).
- **Cell counters** for sale SKUs only, in a conditional-write store (DynamoDB as the default), K sized from a load test, not from a blog post. [ADR-003](./04_architecture_decision_records.md#adr-003).
- **Reservation + reaper**, add-to-cart as a no-op for stock, TTL signed by product. [ADR-004](./04_architecture_decision_records.md#adr-004).
- **Saga + webhook inbox**, payment off the reserve p99. Reuse [prj--payment-webhook-ingestion](../../prj--payment-webhook-ingestion/README.md). [ADR-005](./04_architecture_decision_records.md#adr-005).
- **Hosted fields / tokens.** No vault project. [ADR-006](./04_architecture_decision_records.md#adr-006).
- **Cart active-active; inventory single-writer, fail closed.** [ADR-007](./04_architecture_decision_records.md#adr-007).

I would not shard Postgres as the fix. I would use lock wait events in Phase 0 so I know the incident is the hot tuple, then stop treating replica count as architecture.

If Phase 0 shows the last "flash sale" was 2× QPS, no tuple waits, and oversell came from decrement-on-replica-read, this whole cell-sharded engine is overkill. **Admission + stop selling from the read path + stop payment-inside-the-transaction** may be the whole fix. Cell sharding is for when the remaining bottleneck is still one key at sale-level QPS. Be honest about which incident you are in.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Seamless checkout when the inventory home region dies.** Fail closed is the price of zero oversell. Anyone promising "active-active inventory, never oversell, 100 ms" is promising CAP-complete. They will ship last-writer-wins on a counter and finance will find it.

**A truthful "N left" on the product page.** The badge is stale. Checkout is the truth. If product needs a live ticker, they are asking to put the cell store on the page path. Refuse or drop the 30 ms read requirement.

**Add-to-cart as a hold.** The cart is a wish. Conversion UX that says "it's in your cart so it's yours" is a lie unless you pay reservation-at-add-to-cart QPS and TTL griefing. Not v1.

**Zero false sold-out.** Cells will strand units. You can gather at the tail or raise retries (p99). You will not get both perfect leftover extraction and a single-digit-millisecond single-hop reserve at the end of a 500-unit drop. Gather to K=1 at the tail is an ops play.

**Payment in the 100 ms write budget.** If "write" in the prompt was meant to include capture, the requirement is incompatible with 3DS and with any processor p99 you do not own. This design interprets write as **reserve**. Argue that in the first meeting.

**An in-house payment switch and a self-built vault.** Wrong problem.

**A general microservices platform** as a prerequisite. Inventory, cart, admission, webhook apply. Not a rewrite of CMS, search, and reviews.

**Fairness in the waiting room.** Lottery vs FIFO vs "logged-in users first" is product. The architecture caps QPS.

**Cheapness and speed.** This is multiple quarters if you are on the monolith in the scenario. A sprint can ship Redis `DECR` in front of Postgres. That sprint is how you get a second incident with a nicer diagram.

**The fantasy that 15 million DAU is the scaling number.** It sizes CDN and cart. The sale sizes cells and the waiting room. Designing for DAU on the decrement path is wasted money.

**Postgres as the lock manager for hero SKUs.** It can remain the order ledger. If it is still `FOR UPDATE` on qty after Phase 3, the project failed.

## 3. What I would ask for, even though I expect friction

Ask **once, in writing, in Phase 0**, in parallel with lock diagnostics. Silence must not block diagnosis.

Ask product / finance:

1. **Confirm that "zero oversell" outranks "checkout stays up in a dead inventory region."** Expected: they want both. Make them sign the 503 window. If they refuse to sign, they have not accepted the problem.
2. **TTL vs 3DS p99.** A number in minutes, with late-capture = refund. Expected: "make TTL an hour." That is hostage stock. Push back with last sale's cart-abandonment vs payment-duration histogram.
3. **Which SKUs are actually finite and hot.** If the next "flash sale" is a warehouse of 200,000 identical units, you need admission, not 256 cells.
4. **Is "in stock" then sold-out at checkout acceptable?** If no, they are asking for consistent page reads. Show them the 30 ms requirement and the last oversell. Make them pick.

Ask SRE / platform:

5. **Can we run a production-like load test with the real SKU working set and the real spike shape?** If the answer is no (no env, no budget, no traffic replay), Phase 3 is a live bet. Say that.
6. **Waiting-room product vs homegrown.** Buy unless there is already one. Building a fair queue is a second project.
7. **Regional failover fence story** with the chosen store vendor. If nobody can explain fencing, do not automate promote.

Ask compliance:

8. **Is hosted fields already approved, or is PAN still on the monolith?** If PAN is on the monolith, Phase 5 is a program, not a ticket. The inventory engine should not wait to *design*, but **cutover of checkout that still handles PAN** is a PCI change, not just an inventory change.
9. **SAQ target and whether a QSA is booked.** Architecture cannot self-certify.

Ask the processor:

10. **Idempotency keys, webhook at-least-once, 3DS duration, sandbox that can simulate late webhooks.** Expected: docs that lie about ordering. Design as if they do.

What I would **not** ask for: a Kafka platform, Kubernetes, a new language, a multi-cloud inventory abstraction, "event sourcing everything." Those asks spend calendar that belongs to admission, the invariant test, and the reaper.

## 4. Complexity inventory (what the microservices slide costs)

| You take on | You shed |
| --- | --- |
| Waiting room, ceilings, bot fight | Unshaped stampede on the primary |
| Read projection + "badge is a lie" UX | Replica-as-seller, `SELECT qty` on the page |
| Cell store, K, pick, retries, rebalance/gather | `FOR UPDATE` on one tuple |
| Reservation Transact, reaper, TTL policy | Decrement-on-cart hostage stock |
| Saga, inbox, late-capture refunds | Payment inside the DB transaction |
| Hosted fields, token hygiene, QSA | Homegrown CDE scaled with checkout |
| Cart CRDT/LWW and support for weird carts | Cart in the inventory transaction |
| Fence + fail-closed drills | Fairy-tale active-active stock |
| Invariant metrics and load tests that can fail the release | Hope + oversell tickets after the drop |

Net: **more parts, in the right places.** The old design was operationally familiar *and wrong at this spike.* The new design is the standard one for limited drops (see every company that has publicly discussed hot-key inventory), and the standard one is still **quarters**, not a rewrite weekend.

### What is not worth building

- Cell-sharding the entire catalog on day one. Sale SKUs only.
- Live cell split during a sale.
- CRDT global counters to dodge ADR-007.
- 2PC/XA with the processor.
- A custom waiting-room fairness thesis.
- Kafka as the decrement.
- Redis as truth "until we need DynamoDB."
- OMS, tax, fraud as blockers for Phase 1 admission.

## 5. When I would not do this

- **Phase 0 shows no tuple waits, and oversell is the page selling replica qty.** Fix authorization (page cannot sell), maybe add a cache. Do not buy DynamoDB to punish Postgres for a bug in the app.
- **The sale is deep stock, slow ramp, 2× QPS.** Admission + connection hygiene + payment out of the transaction. Stop.
- **There is no finite stock** (always-on catalog, backorder allowed). This engine is for finite allocatable qty. Oversell as backorder is a business mode, not a bug; do not install cells to prevent a policy.
- **Compliance forbids a third-party hosted field and also forbids a real CDE program.** Then you do not have a flash-sale PCI story; you have a company-level block. Do not "temporarily" log cards in the monolith to make the date.

When I **would** do this: the last drop had `Lock:tuple` on a handful of SKUs, 504s, and a measurable oversell, and the next drop is the same shape or worse. Then cells + admission are the design, and this document is the bill. If you only have budget for one thing before the next sale date, **ship admission and get payment out of the Postgres transaction.** That is the highest-leverage slice. Cells without admission is résumé-driven capacity.

## 6. CAP, in money terms

| You insist on | You pay |
| --- | --- |
| Zero oversell | During inventory-region death, you **do not sell** those SKUs. Lost GMV is the insurance premium. |
| p99 reserve < 100 ms | Writes stay **in-region**. Cross-region consensus is not in the budget. |
| Cart survives region death | Cart may **diverge** (duplicate lines). You do not lose the basket. |
| All three of: oversell=0, 100 ms, never-fail checkout globally | **Not offered.** A vendor slide that offers it is selling last-writer-wins or a 100 ms lie. |

Finance understands insurance. Fail-closed is insurance. Fail-open is uninsured GMV plus customer-trust burn when orders cannot ship.

## 7. What still goes wrong after you build it

These remain after a "successful" implementation. They are not a reason to keep `FOR UPDATE`; they are the new ops list.

- **Uneven cells / false sold-out** at the tail. Gather. Live with a few stranded units or a human grant.
- **TTL tuning.** Too short: refunds. Too long: empty site, full reservation table. Revisit after the first real sale's histograms — not before, not from a guess in this doc.
- **Processor outage.** Conversion zero, stock returns via TTL. Executives will ask to "just take orders and charge later." That is oversell or unpaid warehouse risk. Get a written policy.
- **Reaper / Transact bugs.** Phantom stock is the inverse oversell. The invariant metric is the detection. If you do not staff to look at it during the sale, you will notice at warehouse.
- **Shadow mode comfort.** Two truths until someone cuts over. Time-box or kill.
- **PCI log leak.** One engineer dumps a webhook body. Scope expands on a Friday.
- **Load test theatre.** A test at 20k QPS with 1,000 SKUs uniformly hashed is not the incident (3 SKUs, 250k offered). If the test does not look like the incident, it is a green dashboard.

## 8. Brutal summary

The clever design is not more Postgres replicas. The clever design is **refusing to serialize a sale on one row, refusing to let a cache sell, refusing to hold a lock (or a connection) across a payment processor, and refusing a second writer for the same stock.**

"Microservices plus Redis" is three words. The fourth through four-hundredth are admission, cells, Transact, reaper, fence, refund-on-late-capture, and a product team that signed the 503.

If the last sale did not actually hot-key the database, do not build this. If it did, do not pretend `max_connections` is a strategy. Either way, Phase 0 is wait events and a spike graph — before anyone provisions a global table.
