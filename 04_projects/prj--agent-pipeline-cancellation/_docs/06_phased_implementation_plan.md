# Agent Pipeline Cancellation — Phased Implementation Plan
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each phase has an **Objective**, **Deliverables**, and an **Exit Gate** that must pass before the next phase begins. **Phase 0 is not optional and is not a streaming demo.** Building Stop against an uninventoried tool list is how you ship a button that sometimes emails people. Phase 4 is ongoing operations, not a calendar day.

Rollback/kill criteria at the bottom apply at every phase. In particular: **never ship a client `cancelled` state that cannot distinguish "nothing left the building" from "the email may have sent."**

Calendar assumptions: one small team, sequential phases. LLM-only cancel (Phase 1) can ship in front of irreversible tools if the product can feature-flag `send_email` off. Do not enable `send_email` on a cancelable run until Phase 2's gate is green.

## Phase 0 — Inventory Side Effects and Vendor Contracts (Days 1–2)

**Objective**: Classify every tool the planner is allowed to call, and write down what the vendor actually guarantees. Guessing that "the SDK is idempotent" is how attempt 2 is born.

**Deliverables**:
- A table, one row per tool (start with `lookup_customer` and `send_email`): side-effect class (`read` | `irreversible`), idempotency header/body support, lookup-by-key support, documented timeout behavior, whether a 5xx might still have applied, any cancel/unsend API, typical latency.
- Evidence, not vibes: a redacted successful response, a timeout test, a **double POST with the same key** (did the vendor send twice?), a double POST with different keys (baseline double-send).
- LLM provider notes: does aborting the client stream stop generation? Is usage returned on abort? What is billed? Record a cancelled-stream invoice/usage sample.
- Product questions sent in writing: invoice policy for cancelled runs; Stop-after-send copy; whether disconnect means cancel; support SLA for `unknown`. See [Trade-offs §3](./05_tradeoffs_and_honest_assessment.md#3-what-i-would-ask-for-even-though-i-expect-a-no-or-a-fight). Do not wait for replies to *start* Phase 1, but **do not enable send_email** until the mail row of the inventory exists.
- Feasibility call: if `send_email`'s vendor has neither idempotency nor lookup, either (a) keep the tool off the cancelable path, (b) accept human reconciliation as the design, or (c) put a user confirm *before* dispatch so Stop rarely races. Write down which.

**Exit Gate**:
- [ ] Inventory table exists with evidence links for both tools and the LLM.
- [ ] `lookup_customer` is confirmed read or reclassified.
- [ ] A written choice for the no-idempotency-no-lookup case, if that is what was measured.
- [ ] Asks to finance/product/support have been sent. Replies are not required to pass this gate except: **finance policy is required before Phase 3**, not before Phase 1.
- [ ] Kill/proceed: proceed to Phase 1 regardless; proceed to *enabling* irreversible tools only under Phase 2's gate.

## Phase 1 — Durable Run/Step Ledger, Cooperative Cancel for LLM Steps, Client Protocol (Days 3–6)

**Objective**: Make cancel real for `plan` and `synthesize` with no tools enabled (or tools hard-disabled). Prove the stream protocol and the durable flag without the mail race.

**Deliverables**:
- `runs` + `steps` schema as in [System Design §1](./03_system_design.md#1-data-model). Run created before any LLM call.
- Orchestrator loop with lease + checkpoint before step and between chunks ([System Design §4](./03_system_design.md#4-checkpoints-and-the-executor-loop)).
- Gateway: SSE or WS, tagged chunks, `POST /cancel`, `stopping` + `terminal` frames, disconnect ≠ cancel ([ADR-006](./04_architecture_decision_records.md#adr-006)).
- Drain for LLM: stop forwarding, `output_partial`, skip remaining steps, `cancelled_clean` or `cancelled_partial`.
- Reconnect by `run_id` + seq (chunk log or equivalent).
- Minimum metrics: cancel-to-terminal latency; runs cancelled vs completed.

**Exit Gate**:
- [ ] Cancel before start: zero LLM calls (assert on a fake provider), `cancelled_clean`.
- [ ] Cancel during plan: no synthesize, terminal `cancelled_partial`, client does not show a complete answer.
- [ ] Cancel during synthesize: last tokens plus terminal incomplete; a test client that treats "stream ended" as complete **fails** this gate on purpose — the product client must use the terminal frame.
- [ ] Duplicate cancel POSTs are idempotent.
- [ ] Kill orchestrator after cancel flag is set, restart: worker does **not** start the next LLM step.
- [ ] Drop the SSE without cancel: run **continues** (or completes). If this surprises product, that is a Phase 0 question, not a silent flip of the default.
- [ ] `send_email` is still feature-flagged off.

Do not start Phase 2 until the restart-after-cancel test is green. That test is the whole point of a durable flag.

## Phase 2 — Tool Adapter, Dispatch Ledger, Unknown, the Email Race (Days 7–11)

**Objective**: Put `lookup_customer` and `send_email` on the path without inventing rollback. The gate is the in-flight cancel test, not a pretty adapter interface.

**Deliverables**:
- Tool adapter: classify, insert dispatch, call, record outcome ([System Design §6.3](./03_system_design.md#63-send_email-irreversible-tool--the-load-bearing-step)).
- Unique `idempotency_key`; vendor header when Phase 0 found one.
- Drain behavior: abort reads; **do not abort** in-flight `send_email`; `IRREVERSIBLE_WAIT` → `unknown`.
- Terminal outcomes `cancelled_with_side_effects` and `cancelled_unknown_side_effects` with `side_effects[]` on the frame.
- Client copy for those two outcomes (not "Cancelled").
- Tests that force the race: delay the mail API in a fake; cancel after `recorded` commit; assert a single POST body/key. Restart orchestrator between commit and 200; assert no second key.

**Exit Gate**:
- [ ] Cancel after lookup, before email: email not sent, `cancelled_partial`.
- [ ] Cancel while mail fake is blocked: exactly one POST with one key; outcome succeeded or unknown depending on whether 200 arrives before wait; **never skipped**.
- [ ] Fake 200 after wait-timeout: no second POST; dispatch resolvable to succeeded without a new key.
- [ ] Fake timeout forever: `unknown`, synthesize **not** run (we do not claim we emailed).
- [ ] Known 4xx reject: step failed/not-sent; new attempt policy documented; cancel then does not send.
- [ ] User "Send again" creates a new `run_id` and *may* send a new email — asserted, and the UI after side-effect-cancel is reviewed so this is not a surprise click.
- [ ] Lease contention test: two orchestrators, one run, one send.

If the real mail vendor failed the Phase 0 double-POST-same-key test, this gate includes a written ops procedure for unknown and a product acknowledgement. Shipping anyway without that acknowledgement is a kill criterion.

## Phase 3 — Billing Ledger and Signed-Off Partial-Run Policy (Days 12–14)

**Objective**: Charge what happened. Stop arguing from logs. Do not implement this phase as "if cancelled, amount = 0."

**Deliverables**:
- `billing_events` appends from LLM usage and tool dispatch ([ADR-003](./04_architecture_decision_records.md#adr-003)).
- Estimate + true-up path for aborted LLM streams, using whatever Phase 0 measured.
- Invoice-job read model that applies the **written** finance policy (actuals, waive cancelled-clean, etc.). Credits are extra events or a separate credit table, not deletes.
- Optional `billing_preview` on the terminal frame, clearly labeled if unconfirmed.
- A finance-readable export of a cancelled-with-side-effects run that matches the ledger.

**Exit Gate**:
- [ ] Finance (or the owner playing finance) has signed the policy in the repo or ticket. If they have not, **do not** invent `amount=0`.
- [ ] Cancelled-clean run: events match policy (likely zero or admission fee only).
- [ ] Cancel during synthesize: token events ≥ 0 and match provider sample within the documented estimate error; `usage_confirmed` distinguished.
- [ ] Cancel during/after email: tool_call event present; a later not-sent reconciliation produces a correction, not a deleted row.
- [ ] Killing the orchestrator after a billing append does not lose that event or duplicate it (event ids / unique on provider_request_id + kind).

## Phase 4 — Reconciliation, Support View, Alerts (ongoing)

**Objective**: Close the crash and timeout windows without "retry the send to be sure."

**Entry Gate**: Phase 2 is green. Phase 3 may still be in flight (unknown has operational cost even before invoices are pretty).

**Deliverables**:
- Worker: expired leases, `unknown` / `awaiting_provider` older than TTL ([Architecture — Reconciliation](./02_architecture_document.md)).
- Lookup by key against the mail API if Phase 0 said it exists; otherwise a support ticket template that includes `idempotency_key`, timestamp, recipient hash, run_id.
- Support view: timeline of steps, dispatches, terminal outcome, later resolution. "Did we send?" reads the dispatch row.
- Alerts: unknown age; open unknown count; dispatch-insert failures; dual-orchestrator lock failures.
- Runbook line: **do not resend from the dashboard.** Resolution is succeeded/failed, not "click send."

**Exit Gate** (re-checked):
- [ ] Chaos: kill orchestrator during send; recon ends at most one message at the vendor (measured with the fake, and once with the real vendor in a staging inbox).
- [ ] Unknown older than SLA pages a human, not a retry bot.
- [ ] A resolved-late 200 does not emit a second user-facing `completed` terminal; it updates dispatch and optionally a `side_effect_update`.
- [ ] The scrape/debug "just retry the tool" button does not exist. If someone added it, delete it.

This phase has no calendar end. Unknown rate should fall as wait-out (ADR-001) does its job. If unknown is common in steady state, the wait budget is too short or the vendor is too flaky — tune, do not guess outcomes.

## Standing Rollback / Kill Criteria (apply at every phase)

Stop and escalate — do not keep the Stop button green — if any of the following hold:

1. **Client shows a generic Cancelled** after an irreversible dispatch. Roll back the UI behind a flag; keep the ledger.
2. **A retry or a second orchestrator issued a new idempotency key** for the same user-visible send. Kill the retry path. Staging inbox will tell you; look.
3. **Disconnect was flipped to cancel** to "fix" abandoned cost, causing surprise emails or surprise unknowns. Revert to default; make it an explicit workspace setting if product insists.
4. **Invoice job zeros cancelled runs by deleting ledger rows.** Revert the job. Restore from backup if needed. Policy is credits.
5. **Automatic retraction email** added to "handle" Case C. Disable it. That is a product conversation, not a hotfix.
6. **Pressure to skip Phase 0** because a demo is Friday. Demo plan+synthesize cancel only. Do not demo send-email+Stop until Phase 2 is green.
7. **Unknown ignored** ("we'll assume it failed"). That assumption is the double-send. Treat as a sev.

Rollback is always to the last phase whose exit gate was honestly green, with `send_email` feature-flagged off if Phase 2 was the failure. After a kill, users still get a Stop that works for LLM steps. They do not get a confident "nothing happened" we could not defend.

## Suggested Test Matrix (bind to gates)

| # | Scenario | Phase gate | Expected terminal | Email POSTs | Billing |
| --- | --- | --- | --- | --- | --- |
| T1 | Cancel before start | 1 | `cancelled_clean` | 0 | 0 |
| T2 | Cancel during plan | 1 | `cancelled_partial` | 0 | plan tokens |
| T3 | Cancel during synthesize, no email in chain | 1 | `cancelled_partial` | 0 | plan+partial synth |
| T4 | Disconnect, no cancel | 1 | `completed` (run finishes) | n/a | full |
| T5 | Cancel after lookup, before send | 2 | `cancelled_partial` | 0 | plan+lookup |
| T6 | Cancel during send, 200 arrives | 2 | `cancelled_with_side_effects` | 1 | +email |
| T7 | Cancel during send, timeout | 2 | `cancelled_unknown_side_effects` | 1 | +email dispatch |
| T8 | Crash after dispatch commit, before 200 | 2+4 | unknown then resolved | 1 (same key) | +email |
| T9 | Late cancel after completed | 2 | stays `completed` | 1 | full |
| T10 | Cancel during synthesize after email 200 | 2 | `cancelled_with_side_effects` | 1 | plan+lookup+email+partial synth |
| T11 | New run after T6 ("Send again") | 2 | new run | +1 (new key) | new events |
| T12 | Duplicate cancel POST | 1 | idempotent | — | — |

T6, T7, T8 are the tests that decide whether the team understood the scenario. If they are missing, the rest is theater.
