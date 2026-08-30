# Agent Pipeline Cancellation: Scenario and Requirements
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

## Problem Statement

A user starts a request that runs a 4-step agent chain:

1. **Plan** — an LLM call that decides what to do.
2. **Tool call 1** — a tool invocation (in this scenario: a CRM lookup; read-shaped, no external mutation).
3. **Tool call 2** — a tool invocation with an irreversible side effect (in this scenario: send an email).
4. **Synthesize** — an LLM call that streams tokens back to the user.

The user hits cancel mid-way. The design must answer, concretely:

1. How cancellation is signaled, persisted, and observed by in-flight work — not just how a button looks.
2. What is cleaned up, what is left running on purpose, and what is left in an explicit unknown state.
3. How billing is computed for a partial run: tokens already generated, tools already invoked, work that was in flight when cancel arrived.
4. What happens if tool call 2 (send email) has already been dispatched — or is in flight — when the cancel arrives, and how a later retry of that step does not send the email a second time.
5. What the client is told: a clean stop, a partial answer, or "we already did something in the world and we cannot take it back."

This is the cancel-is-not-rollback trap. The naive answer — abort the task, close the socket, refund the run, pretend nothing happened — is the failure. It treats a distributed pipeline with LLM calls and third-party side effects as if it were a database transaction. **LLM calls have side effects that do not roll back.** Tokens already billed by the provider stay billed. An email that left the mail API stays sent. Closing our socket does not unsend either.

The correct shape is: **cancellation is a durable, cooperative request to stop *future* work, plus mandatory honest accounting for whatever *already* happened — never a claim of clean undo.**

That sentence is the whole architecture. Everything else in this project is the honest cost of making it true under the race where cancel and a committed tool call cross in flight.

## The Trap, Stated Directly

"Cancel" in a UI is a *request*. It is not a distributed transaction abort. There is no two-phase commit between:

- the user's browser,
- the streaming gateway,
- the orchestrator,
- the LLM provider (plan / synthesize),
- and the email API (tool call 2).

Those are independent systems with independent clocks. The cancel and the email ACK can arrive in either order. No amount of careful coding on *our* side can guarantee that cancel wins. Designing as if it can is how you ship a Stop button that sometimes still emails the customer, then a support ticket that says "I cancelled, why did they get the email," then an engineer who tries to "fix" it with a harder kill — which makes the next failure *worse*, because now the email *might* have sent and the local state says "cancelled, nothing happened."

The load-bearing distinctions:

| What people think cancel does | What it can actually do |
| --- | --- |
| Roll back the run | Stop *starting* new steps |
| Unsend the email | Record that the email was (or may have been) sent |
| Zero the bill | Stop appending *new* billable events; keep the ones that already occurred |
| Mean the user saw nothing | The user may have seen streamed tokens; the world may have been mutated |
| Be instantaneous | Be observed at the next checkpoint, which may be after an in-flight HTTP call returns |

A hard `kill -9` of the worker, or an immediate TCP close to the LLM / email provider, converts a known in-flight call into an **unknown outcome**. Unknown is more expensive to operate than "we waited 800ms and the email API said 200." See [ADR-001](./04_architecture_decision_records.md#adr-001) and [ADR-004](./04_architecture_decision_records.md#adr-004).

## Current State (Assumed Starting Point)

A typical first version of this pipeline looks like:

1. Client opens an SSE/WebSocket stream and POSTs the prompt.
2. A request-scoped async task runs the four steps in memory.
3. Tokens are forwarded as they arrive. Tool calls fire when the planner says so.
4. The Stop button closes the client socket. The server notices `req.on('close')` (or equivalent) and `abort()`s the in-process task.
5. Billing is computed at the end: if the run "didn't complete," charge 0 — or charge the full estimated cost, because the metering code only ran in the `finally` of a successful synthesize.

That version will appear to work in a demo: cancel during plan, no tools have fired, the stream stops, nobody is billed, nobody got an email. It will fail in production the first time:

- cancel arrives while `send_email` is already on the wire,
- the client disconnects (laptop lid, network blip) and is indistinguishable from an intentional cancel,
- the worker is killed after the email API accepted the message but before the step row is marked succeeded,
- the user retries the same prompt and the planner sends the same email again because nothing was keyed,
- finance asks why cancelled runs cost money, and engineering has no ledger, only a vibe.

This project documents the replacement, not a patch of that `abort()`.

## Concrete Chain Used Throughout These Docs

One pipeline, one product-shaped example, so the sequences are not abstract. The architecture is the same if the second tool is "create ticket" or "charge card"; only the compensation story changes.

| Step | Name | Side-effect class | Billable? | Cancellable mid-flight without creating unknown? |
| --- | --- | --- | --- | --- |
| 1 | `plan` | None (LLM text). Output is a structured plan consumed by the orchestrator. | Yes — input + output tokens | Yes, with the caveat that the provider may still bill tokens already generated. Closing *our* stream does not always stop *their* bill. |
| 2 | `lookup_customer` | Read. CRM GET. No mutation if the CRM is honest. | Maybe a per-call tool fee; usually cheap | Yes — aborting a GET is usually safe. Confirm in Phase 0; some "lookups" write audit rows. |
| 3 | `send_email` | **Irreversible write.** Mail API accepts and the message is in the recipient's future. | Per-send fee and/or provider cost | **No.** Once the HTTP request has left, the only honest options are: wait for the ACK, or mark `unknown` and reconcile. |
| 4 | `synthesize` | None (LLM text streamed to the user). Partial text may already be on the user's screen. | Yes — tokens | Yes, same provider-billing caveat as plan. The UX caveat is different: the user already *saw* tokens. The terminal frame must say the answer is incomplete. |

Cancellation may be requested:

- before step 1 starts (queued, not yet running),
- during step 1 (plan streaming internally; user sees a spinner or a short "planning…" status),
- after step 1, before step 2,
- during step 2,
- after step 2, before / during step 3 (**the interview case**),
- after step 3, during step 4 (user is reading a streaming answer and hits Stop),
- after the run has already completed (late cancel; must be a no-op).

The interesting cases are not "cancel before anything started." They are cancel-vs-side-effect races, and cancel-during-stream with tokens already rendered.

## Target Users

- **Owning engineer**: implements the orchestrator and the Stop path; needs a state machine they can defend when an email went out after cancel.
- **On-call / support**: needs to answer "did we send it?" from the step ledger, not from guessing at logs. `unknown` must be a first-class, alertable state, not a missing row.
- **Finance / billing**: needs a ledger of what was actually consumed, not a boolean `completed`. Partial runs are the common case under cancellation, not an exception.
- **The end user**: needs the stream to *stop*, and needs not to be lied to about whether an action in the world already happened.
- **The tool owner** (email, CRM): needs this system not to retry a send just because our process crashed or the user cancelled.

## Architecturally Significant Requirements

These are the requirements that *shape* the architecture. Ordinary product requirements (which model, the email template, the CRM schema) are out of scope.

1. **Cancellation is cooperative and durable.** A cancel is written to the run record (`cancel_requested_at`) and observed at checkpoints. It is not solely an in-memory `AbortSignal` that dies with the process. A restarted worker must still see that the run was cancelled and must not start the next step.
2. **In-flight side-effecting calls are not hard-killed by default.** For `send_email` (and any tool classified as irreversible), the executor waits for a bounded provider response or a timeout into `unknown`. Assuming failure after abort is forbidden. See [ADR-001](./04_architecture_decision_records.md#adr-001).
3. **Tool side effects are idempotent on retry, not undoable on cancel.** Every dispatched tool call carries a per-attempt idempotency key (`run_id + step_id + attempt_number`). A cancel does not "reverse" the call. A retry of the same attempt must not send a second email. See [ADR-002](./04_architecture_decision_records.md#adr-002).
4. **Billing is append-only and event-sourced.** Cancellation stops *new* billable events from being appended. It never deletes or zeros events that already occurred. "User cancelled" is not a billing product; it is a UX product sitting on top of a usage ledger. See [ADR-003](./04_architecture_decision_records.md#adr-003).
5. **The client is told an honest terminal outcome.** The stream ends with an explicit frame: `cancelled_clean` | `cancelled_partial` | `cancelled_with_side_effects` | `cancelled_unknown_side_effects` (plus `completed` / `failed` for the non-cancel paths). A cut-off synthesize must never be presented as a complete answer. Socket close alone is not a protocol. See [ADR-006](./04_architecture_decision_records.md#adr-006).
6. **Unknown is a real state, resolved by reconciliation, not by optimism.** A call interrupted with no ACK is `unknown` until a worker (or a human) determines whether the provider accepted it. Support must be able to read that state. See [ADR-004](./04_architecture_decision_records.md#adr-004).
7. **Client disconnect is not automatically an intentional cancel** unless product explicitly says so. A dropped laptop lid during synthesize is a different policy from a Stop click. The architecture supports both; the default in this scenario is: intentional cancel is an explicit client frame; disconnect without that frame is "abandon stream, keep the run policy" — documented, not implied. See System Design.

## Success Criteria for the Design (Not Implementation Metrics)

1. Cancel before any step starts: no LLM call, no tool call, no billable events, terminal frame `cancelled_clean`.
2. Cancel during `plan` or `synthesize`: no further tokens forwarded after the cancel is observed; no subsequent tool step starts; billed tokens ≥ tokens the provider actually generated (we may over-count slightly if the provider does not stop instantly; we must not under-count); synthesize terminal frame marks the visible text incomplete.
3. Cancel while `send_email` is in flight: the email is not retried as a *new* attempt; the step ends `succeeded` or `unknown`, never a silent `skipped`; the run terminal outcome is `cancelled_with_side_effects` or `cancelled_unknown_side_effects`; the client is told an email may have been / was sent.
4. Cancel after `send_email` succeeded, during `synthesize`: email stays sent; synthesize stops; billing includes plan + lookup + email + partial synthesize tokens; terminal outcome `cancelled_with_side_effects`.
5. User retries the same prompt after a cancelled run that sent email: a *new* `run_id` may send a new email (that is a new user action). Retry of the *same* run / same attempt must not. The distinction is load-bearing and must be in the client contract ("Stop then Send again" is a new run).
6. A crash after the mail API returns 200 and before the step row is committed: on restart, reconciliation or the in-flight waiter must not produce a second send. The idempotency key of that attempt is still the key.
7. Finance can reconstruct the charge for a cancelled run from the billing ledger without reading application logs.

## Business Rules (Cancellation-Scoped)

1. The Stop control is a *request to halt future steps*. It is not a warranty that no side effect occurred.
2. A 2xx (or equivalent success) from a side-effecting tool is durable truth in the step ledger, even if cancel was already requested.
3. Idempotency keys are derived by this system and sent to the tool provider when the provider supports them. When the provider does not, the local dispatch ledger is the only guard — and it cannot prevent a double send if we never recorded the dispatch. Record *before* the HTTP call, not after. See System Design.
4. Billing events are immutable. Credits / refunds / "don't charge cancelled runs" are a *separate* product policy applied at invoice time, reading the ledger. They are not implemented by deleting rows. Stakeholders must pick the policy; the architecture must not pretend a policy was picked if it was not. See [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
5. Automatic compensating actions (a follow-up "please disregard" email, a refund of a charge, a ticket deletion) are **opt-in per tool**, never default, never silent. An auto-retraction email is itself a side effect the user did not ask for. See [ADR-005](./04_architecture_decision_records.md#adr-005).
6. `lookup_customer` is treated as read-only in this scenario after Phase 0 confirms it. If Phase 0 finds it writes, it is reclassified and joins the irreversible path.

## Non-Goals

- **Not a general multi-agent mesh.** One chain, four sequential steps, one user, one run. Fan-out, sub-agents, and parallel tool calls are explicitly out. Parallelism makes the race *worse*; do not add it to look complete. If a later product needs parallel tools, each child run gets this same ledger; that is a new project.
- **Not exactly-once across independent vendors.** Exactly-once delivery between our orchestrator, an LLM API, and an email API does not exist. At-least-once with idempotency keys is the ceiling. Claiming more is a lie.
- **Not a distributed transaction / saga framework as v1.** Compensating actions, if any, are per-tool and explicit. A generic saga engine that "undoes the pipeline" is how you send a second email that says "ignore the first email," which is often worse than the first email.
- **Not an implementation.** No TypeScript orchestrator, no SSE server, no Stripe/SendGrid/OpenAI client. Numbered steps and diagrams only.
- **Not a promise of instant cancel.** Observed-at-next-checkpoint is the contract. The UI may show "Stopping…" for the duration of an in-flight `send_email`. That spinner is honest. A spinner that says "Stopped" while the HTTP call is still out is the trap.
- **Not a claim that this is cheap.** The honest alternative — in-memory abort, bill at the end, hope — is cheaper to ship and will survive a demo. This design is justified when side-effecting tools are in the chain *and* users are allowed to cancel *and* incorrect billing or double-sends are expensive. It is overkill for a read-only chatbot with no tools. That distinction is load-bearing; see [Trade-offs](./05_tradeoffs_and_honest_assessment.md).
