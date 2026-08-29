# Trade-offs and Honest Assessment
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

This document answers the scenario in the form it is actually asked. Architecture and mechanics live in [Architecture](./02_architecture_document.md) and [System Design](./03_system_design.md). This is the briefing you give a stakeholder — and yourself — before anyone wires `AbortController` to a mail SDK.

The trap, once: **an LLM chain is not a database transaction.** Plan tokens, a CRM GET, an email POST, and a streamed synthesize are four vendor conversations. Cancel is a fifth. They do not share a rollback log. The Stop button that "just works" in a demo is a Stop button that has never lost a race with `send_email`.

## 1. What I would build

A **durable run with a step ledger**, not a request-scoped task.

- **Run + four step rows + a set-once `cancel_requested_at`**, written before any vendor call. The orchestrator takes a lease. A second worker cannot "help."
- **Checkpoints**, not kills. Before each step, and between LLM chunks, read the flag. If set, drain. For `send_email` already on the wire, wait for the ACK or time out into `unknown`. Show the user **Stopping…** during that wait. Instant "Cancelled" is a lie while HTTP is outstanding.
- **Dispatch-first tool adapter.** Insert `tool_dispatches` with `idempotency_key = hash(run_id, step_id, attempt, body)` **then** call the vendor, then record the outcome. Crash in the gap retries the *same* key or reconciles. It never mints a new key to "be safe."
- **An append-only billing ledger.** Tokens and tool calls are facts as they occur. Cancel stops new facts. Invoice policy is a credit applied to those facts, not a `DELETE`.
- **A terminal frame** with a four-way cancel outcome: clean, partial, with side effects, unknown side effects. The client is not allowed to infer completion from "the stream ended."
- **A reconciliation worker** for `unknown` and expired leases. If the mail API cannot be queried by key, this worker is a human queue. Budget it or do not put send-email on a cancelable agent.

Streaming is a projector. The database is the system. Anyone who implements cancel only in the SSE `close` handler has not implemented cancel.

If Phase 0 finds that every tool is a read and the product is a chatbot without mutations, this whole design is heavier than the problem. Build a subset (ledger + terminal frame + LLM abort) and **do not** invent irreversible-tool machinery for sport. The inventory is the fork.

## 2. What I would give up

Be explicit. These are not "later." They are not in v1, and some of them are never in this design.

**Instant cancel.** Observed at the next checkpoint. During `send_email`, that can be seconds. If the SLA is "UI disables within 50ms," that is the `stopping` frame, not the drain.

**Rollback of side effects.** The email stays sent. The CRM audit log stays. Tokens stay billed by the LLM vendor. Stop is not Ctrl-Z.

**A single boolean `cancelled`.** That boolean is how you hide an email. The designed outcomes are four, plus completed and failed.

**Exactly-once across our app, the LLM, and the mail API.** Ceiling is at-least-once with idempotency keys. Anyone quoting exactly-once in the design review has not called a mail API.

**Automatic "please disregard" / saga undo.** A second email is another side effect. Default is no. See [ADR-005](./04_architecture_decision_records.md#adr-005).

**Treating disconnect as Stop.** Trains, lids, and idle timeouts are not user intent. The default is reconnectable runs. Product can opt in later, still as a flag, still not as a kill of in-flight send.

**Free cancelled runs as an architecture invariant.** Vendor cost is real. "We don't charge if you hit Stop" is a *promo* implemented as credits. If we ship that promo without a ledger, cancelled-during-email is how we leak money or how we silently charge and get caught.

**Resuming synthesize after a crash as a free retry.** A new LLM call is new tokens. Default: do not auto-resume. The user can start a new run (and possibly send a new email — which is why the post-cancel UI must not look like a innocent retry).

**Parallel tool calls, sub-agents, fan-out.** They multiply in-flight irreversible races. Out of scope. Sequential is not a v1 apology; it is how you keep the drain function understandable.

**Trusting the LLM planner as a dispatcher.** After cancel, a plan sitting in memory is not permission to send. The checkpoint is permission.

**A general workflow product (Temporal/Cadence) on day one** unless the company already runs one. The state machine is four steps. If you already have Temporal, its cancellation *still* must not abort irreversible activities; you would model `send_email` as an activity that ignores cancel and a local activity that records dispatch first. The workflow engine does not dissolve the trap. It just gives you better timers.

## 3. What I would ask for, even though I expect a no (or a fight)

Ask **once, in writing, at the start of Phase 0**. A no must not block the ledger. A yes changes copy, invoice policy, or whether `send_email` belongs on this path.

Ask the **mail/CRM vendors** (read the docs; "ask" might be "we measured"):

1. **Idempotency-Key (or equivalent) support, documented behavior on retries, retention window of the key.** Expected: maybe. If no, local fuse only.
2. **Lookup by that key** (did this send exist?). Expected: often no. If no, unknown is human-resolved.
3. **A real cancel/unsend after accept.** Expected: no for email. If yes, drain can call it — still a forward action.

Ask **finance / product**:

4. **Invoice policy for partial and cancelled runs.** Charge actuals; waive cancelled-clean; credit 50%; never charge tools that ended unknown until resolved — pick one. Expected fight. Silence means we charge actuals and they will complain later, which is still better than deleting rows.
5. **Whether Stop is allowed at all once an irreversible tool is in the plan.** The honest alternative: after plan, show the user "I'm about to email X" and require confirm, and only then enable a Stop that is *unlikely* to win the race. Two-step confirm does not need a saga. Expected: product wants one-click magic.
6. **Whether "Send again" after a cancelled-with-side-effects run is allowed without extra confirm.** Default in this design: new run can send again. If that is unacceptable, the client must block or re-confirm.

Ask **support / ops**:

7. **SLA for `unknown`.** 15 minutes paged? Next business day? If they will not staff it, do not offer send-email on cancelable runs.

Ask **legal / privacy** (because ledgers keep email metadata):

8. **Retention of dispatch rows vs chat logs.** Finance usually needs billing longer than chat. Do not cascade-delete the proof of a send.

What I would **not** ask for: that the LLM vendor refund aborted streams as a contract, that the mail API join our distributed transaction, that users "just not cancel." Those asks burn time and do not change the race.

## 4. Complexity, priced honestly

This is not a large distributed system. It is a small system with a *nasty* consistency problem. The code for four steps is a day or two. The code for dispatch-first, leases, unknown, terminal frames, and reconnect is the actual project. Most of the failure modes are races you will not see in a local demo unless you test them on purpose (Phase 1–2 gates).

| Approach | What you save | What you pay later |
| --- | --- | --- |
| In-memory abort, bill at end, no keys | Weeks of engineering | Double email, "I cancelled" tickets, unbillable or unprovable usage, an incident postmortem that rediscovers this document |
| This design, but skip unknown/recon | A worker and a support view | The one crash window you shipped to production |
| This design, plus a saga/retraction email | Nothing in v1 | Two emails, more races, users who think the robot is unhinged |
| Full workflow engine + this design | If you already have the engine, maybe some timers | If you don't, a platform project that still needs ADR-001 |

The overkill line: **read-only chatbot, no tools, Stop means stop streaming.** Then you need the terminal frame and LLM abort, not the dispatch ledger. The moment `send_email` (or charge-card, or create-user, or post-to-Slack) is a tool, the full design is justified. Slack-post is the same trap with a funnier screenshot.

## 5. How the answer changes for other tools

The architecture does not change. The **compensation and unknown-resolution** story does.

| Tool | Irreversible? | Typical vendor idempotency | Compensation exists? | Cancel-during-flight |
| --- | --- | --- | --- | --- |
| CRM GET | Usually no | N/A | N/A | Abort |
| Send email | Yes | Sometimes | Almost never (unsend is not a contract) | Wait / unknown |
| Create ticket | Yes | Sometimes | Delete/close ticket — a *new* call, opt-in | Wait / unknown |
| Charge card | Yes | Often (Stripe keys) | Refund / void — different API, money, timing | Wait / unknown; **do not** put this behind a casual Stop without a confirm step |
| Post Slack | Yes | Rare | Delete message if you stored `ts` — still opt-in | Wait / unknown |
| Write file in a sandbox you own | Reversible if you own the FS | You | Delete the file | Abort *and* delete is actually possible — the exception that proves the rule |

Card charge is where people will demand a saga. Fine: that is a payments design, not a generic cancel framework. Do not generalize this project's `send_email` into "we undo tools."

## 6. Brutal summary

Cancellation in an agentic pipeline is an **accounting problem wearing a UX feature's clothes.** The interesting artifacts are the step ledger, the dispatch row written *before* the side effect, the four-way terminal outcome, and the billing log. The Stop button is a writer of `cancel_requested_at`.

If you remember one sentence for the interview: **you cannot roll back an email, so you must not design cancel as rollback — you design it as "stop the future" plus "tell the truth about the past," and you treat in-flight writes as unknown until the provider says otherwise.**

If product wants Stop to mean "nothing happened," they need to remove irreversible tools from the chain, or put a confirm *in front* of them so cancel is unlikely to lose the race. Architecture cannot invent a time machine because the button is red.
