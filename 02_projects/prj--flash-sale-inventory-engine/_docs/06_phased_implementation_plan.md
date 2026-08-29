# Flash Sale Inventory Engine — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not "we already know it's Postgres."** Building DynamoDB cells against a guessed root cause is how you ship a second ledger on top of an untouched `FOR UPDATE`. Phase 5 closes PCI gaps; cutting over checkout that still handles PAN is a compliance event, not just an inventory event.

Rollback/kill criteria at the bottom apply at every phase.

Calendar is not a two-week death march unless the next sale is. A realistic Phase 0–1 before the *next* drop is possible (admission + read-path + payment out of the transaction). Cells + saga + shadow + pilot is longer. Do not compress Phase 2 by skipping the invariant test. Do not skip Phase 0 because a date is fixed — then ship only what Phase 0 says is justified, even if that is "admission only."

## Phase 0 — Diagnose and Confirm (before any store rewrite)

**Objective**: Name the layer(s) that actually failed last sale (or in a faithful replay), with evidence, and decide whether this project is a cell-sharded inventory engine or a cheaper mitigation. Replace "Postgres fell over" with a partitioned fault tree. See [Scenario — What to Check First](./01_scenario_and_requirements.md#what-to-check-first-and-why-that-one-first).

**Deliverables**:
- Spike graph: offered QPS vs origin QPS vs 504/429 vs checkout success, at 1s resolution if possible, for the sale window.
- Postgres wait events / lock graphs: confirm or reject **tuple waits on a small SKU set**. List the SKUs that ate 95% of inventory writes.
- Whether checkout holds a DB connection/transaction across the payment SDK (trace).
- Whether add-to-cart decrements; whether the product page qty can authorize a sale (replica or cache).
- Oversell arithmetic: payments captured vs fulfillable units vs warehouse, for that sale.
- Cart storage location and region-failure behavior (today).
- PCI as-is: PAN on OmniShop hosts yes/no; hosted fields already yes/no.
- Product numbers: next sale's SKU working set, finite qty, expected offered QPS, 3DS/payment duration histogram if it exists.
- A one-page unknowns log: each failure mode `observed`, `ruled out`, or `still open`. Open items that change the design (e.g. "oversell was only replica-read") flagged immediately.
- Written asks from [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-friction): especially oversell vs regional 503, and TTL.

**Exit Gate**:
- [ ] Root cause(s) named with evidence — wait event, trace, replica-as-seller — not "probably need microservices."
- [ ] Go/no-go:
  - **Hot-key / lock / unshaped spike / payment-in-transaction class → proceed, but Phase 1 first even if cells are eventually required.**
  - **Replica-sold / page-authorized oversell, no tuple wait → do not start a cell service. Fix authorization and caching. Re-evaluate cells only if a later sale still hot-keys.**
  - **Low multiplier, deep stock → admission + transaction hygiene; stop this project.**
  All three outcomes are a successful Phase 0.
- [ ] If proceeding toward cells: SKU working set, finite qty, offered vs target admitted QPS are written down.
- [ ] Home-region / fail-closed vs "we must never 503" is signed or explicitly unresolved (unresolved means Phase 4 cannot claim active-active inventory).
- [ ] Load-test capability: yes, with spike shape; or **no**, in which case Phase 3 is labeled a live bet in writing.

Do not "start DynamoDB in parallel" before this gate. Parallel is how the wrong system gets a head start.

## Phase 1 — Admission + Read-Path CQRS + Transaction Hygiene (Postgres may still write)

**Objective**: Highest leverage, lowest coupling to a new ledger. Shape the spike, stop the page from selling, stop holding locks/connections across payment. Can ship before the next sale even if cells are not ready.

**Deliverables**:
- Waiting room or equivalent + hard ceiling on checkout/reserve. Admission metrics (offered, admitted, depth, 429).
- Product-page / badge reads from cache/CDN; **checkout still decrements on the server write path** (Postgres is allowed). No client-side "if qty > 0 POST order."
- Payment SDK **outside** the inventory transaction; connection returned before processor RTT. If tokenization is not ready, this still means "do not hold `FOR UPDATE` during charge" — even if PAN is still a Phase 5 problem.
- Add-to-cart **stops decrementing** if it currently does (feature flag). Cart is a wish. This will surface as "sold out at checkout" and is intended.
- Idempotency key on checkout POST (even against Postgres) so client retries do not double-decrement as easily.
- Baseline dashboards that Phase 0 lacked.

**Exit Gate**:
- [ ] A rehearsal or smaller sale (or load test) shows origin checkout QPS capped; 504-from-pool-exhaustion down vs Phase 0 baseline at similar offered load.
- [ ] Page cannot complete a purchase without a server reserve/decrement.
- [ ] Traces: no inventory row lock held across processor calls.
- [ ] Add-to-cart decrement is off for flagged traffic, or was already off.
- [ ] Product signed the "badge can lie" UX.
- [ ] This phase does **not** claim zero oversell under a 250k hot-key. Claiming that is a failed gate. Postgres may still serialize the hero SKU; you have removed the *amplifiers*.

If admission cannot ship before the next sale, **do not skip to cells and call that Phase 1.** Run the sale with a manual ceiling (CDN rule, disable anonymous checkout, stagger SKU drop times) as a stopgap. Document it as debt.

## Phase 2 — Cell Reservation Service in Shadow (not authoritative)

**Objective**: Prove conservation and latency against production-shaped load **without** selling from two ledgers. Postgres remains the seller.

**Deliverables**:
- Cell table seeded from the same numbers Postgres uses, for **shadow SKUs**.
- On each real (or replayed) reserve, perform the cell Transact **in parallel** (or on a copy of the request). Cell outcome must **not** affect the user. Compare: would_cell_oversell, would_false_sold_out, latency.
- Reaper running against shadow reservations (synthetic TTLs in a non-prod sale, or a shadow clock).
- Invariant job: `sum(cells)+held+confirmed` vs shadow seed.
- Load test: admitted QPS at target, **real working-set cardinality** (3 hot SKUs, not 10,000 uniform keys). Include imbalance and retry metrics.
- Runbook draft for sold_out, reaper, invariant alert.

**Exit Gate**:
- [ ] Shadow invariant holds at 0 drift across the load test (modulo intentional test faults).
- [ ] Reserve p99 in shadow (cell Transact only) < 100 ms in the home region on the happy path.
- [ ] False sold-out rate quantified; gather/K/R parameters chosen, not hoped.
- [ ] Double-reaper test does not increment twice.
- [ ] Crash between decrement and reservation persist cannot happen (Transact) or is compensated in a drill.
- [ ] Postgres is still the only production seller. Any dual-sell in production is a **kill**.

If the load test cannot reproduce the spike shape, **do not green this gate.** Stay in shadow or reduce the next sale's offered load with admission.

## Phase 3 — Pilot Cutover (cells authoritative for a bounded SKU set)

**Objective**: One pilot sale or a canary SKU set sells **only** from cells. Postgres qty for those SKUs is not decremented (or is a projection). Time-boxed.

**Deliverables**:
- Flag: SKU in `{cell_authoritative}` vs `{postgres_authoritative}`. **Never both.**
- Production reservation + saga + webhook apply for the pilot (processor sandbox first, then real).
- Reaper on for real TTLs.
- Invariant alert paged during the sale.
- Rollback: flag back to Postgres for those SKUs **only if no in-flight held reservations** or after draining/expiring them (otherwise you double-stock or lose holds).
- Support/ops comms: sold-out may be false at tail; badge may lie; 503 if home region sick.

**Exit Gate**:
- [ ] Pilot completed with **zero oversell** vs seed (invariant).
- [ ] Late-capture-after-expire path tested in sandbox (refund, not confirm) before or during a controlled drill — not discovered on a celebrity drop.
- [ ] Admission stayed on. If someone "opened the ceiling" mid-sale, that is a process fail even if the store lived; do not call the architecture proven at unshaped 250k unless that was the test.
- [ ] Rollback drill performed in pre-prod: flag off without dual decrement.
- [ ] Time-box for expanding SKU set or for reverting is on a calendar.

**Do not** expand to the whole catalog here. Cold SKUs can wait.

## Phase 4 — Multi-Region Cart + Inventory Fail-Closed Drill

**Objective**: Prove ADR-007 with chaos, not slides. Cart survives region loss. Inventory does not fail open.

**Entry Gate**: Phase 3 pilot green. Do not use Phase 4 to hide an unproven single-region cell service.

**Deliverables**:
- Cart active-active (or equivalent) with a documented merge policy; partition-then-heal test (duplicate lines acceptable).
- Inventory: async DR replica, **fence** procedure, promote runbook. Automated promote **disabled** until a fence drill passes.
- Chaos: kill inventory home region (or simulate) during a synthetic sale. Expect 503, **zero** decrements in the other region before fence+promote. After promote, decrements continue without oversell vs remaining qty.
- RTO measured, compared to the number product signed in Phase 0.
- Multi-AZ (vendor) is not this drill. Do not confuse AZ loss with region loss.

**Exit Gate**:
- [ ] Cart readable in a surviving region during the drill.
- [ ] No inventory write in a second region without fence (audited).
- [ ] Post-promote invariant holds.
- [ ] If product now refuses the 503 window, **do not** enable dual writers. Re-litigate product, not the ADR.

## Phase 5 — PCI Tokenization and Legacy Card Path Removal

**Objective**: Make the payment path match [ADR-006](./04_architecture_decision_records.md#adr-006). This phase may **run in parallel from Phase 1** as a separate program; it is listed last because **removing** the PAN path is the gate, not starting hosted fields.

**Entry Gate**: QSA/compliance engaged. Hosted-field design reviewed. Do not "just put Stripe.js on checkout" without the data-flow diagram.

**Deliverables**:
- Hosted fields/SDK in checkout; OmniShop receives tokens only.
- Server capture/refund with processor idempotency key = reservation_id.
- Webhook inbox as specified (if not already from Phase 3).
- Log/APM redaction tests; no PAN in processor raw logs.
- Legacy PAN route 410'd or removed; CDE diagram updated; SAQ path started.
- If Phase 0 found PAN never touched OmniShop, this phase is **short**: confirm, document, decommission any leftover debug endpoints.

**Exit Gate**:
- [ ] Packet/log review of app hosts during a test checkout: no PAN/CVV.
- [ ] Legacy card-on-server route gone or 410.
- [ ] Compliance written acceptance (or residual risk if SAQ still in progress — then the PAN route still cannot be "left for emergencies").
- [ ] Processor outage policy written: no fail-open inventory.

If tokenization is blocked for months, **inventory Phases 1–4 may still proceed** for oversell/504, but checkout scale-out remains PCI-sensitive. Do not pretend otherwise.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop, roll the flag back, or kill the cell program — do not "keep shadow on to see if it settles" — if any of the following hold:

1. **Phase 0 says the cheaper mitigation.** Building cells anyway is résumé-driven. Kill cells; keep admission if it helps.
2. **Dual decrement in production** (Postgres and cells for the same SKU). Immediate kill of one path. This is an oversell factory.
3. **Invariant drift ≠ 0** during a test or sale and not explained by a documented adjustment. Halt expansion. Fix reaper/Transact.
4. **Pressure to skip admission** because cells are "fast." Kill the expansion; restore ceiling.
5. **Pressure to fail-open inventory** in a region event. That request is a kill criterion for the oversell invariant, not an HA suggestion.
6. **Reaper implemented as TTL-delete without increment.** Stop shipping. Stock leak.
7. **Load test not shaped like the incident** used to green Phase 2. Invalid gate. Do not cut over.
8. **PAN in logs or a new proxy of hosted fields through OmniShop.** PCI incident; do not expand checkout fleet.
9. **Shadow never time-boxed.** After the agreed date, either cut over a pilot or delete the shadow writer. Endless dual running is two bugs.

Rollback is always to the last phase whose exit gate was honestly green — typically "Postgres still sells, admission on, page cannot sell." After a kill of the cell program, the honest output is Phase 0 evidence plus Phase 1 mitigations. The output is not a Redis `DECR` left in production undocumented.
