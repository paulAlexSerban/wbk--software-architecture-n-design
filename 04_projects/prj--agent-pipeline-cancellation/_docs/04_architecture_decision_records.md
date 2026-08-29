# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Cooperative, Checkpoint-Based Cancellation over Hard Task/Socket Kill

**Status**: Accepted

**Context**: The obvious implementation of Stop is `AbortSignal` / `task.cancel()` / `socket.destroy()` on every outbound call. That is correct for *our* stream to the user and for read-shaped work. It is wrong for an in-flight irreversible tool call. Killing the HTTP request to the mail API does not kill the mail API's work; it only kills *our knowledge of the result*. The step then looks cancelled and skippable, and a retry looks justified. That is the double-send (or the "we told the user it was cancelled and the customer still got the email") incident.

LLM streams sit in the middle: stopping our read is usually fine, but the provider may still generate and bill tokens. A hard kill that also drops the usage trailer just makes billing worse.

**Decision**: Cancellation is a durable flag (`runs.cancel_requested_at`) observed at checkpoints (before each step; between LLM chunks). Read tools and LLM streams may abort their HTTP reads when the flag is seen. Irreversible tools that have already been dispatched run to a provider response or to `IRREVERSIBLE_WAIT`, then enter `succeeded` / `failed` / `unknown`. They are not aborted to make the UI faster. The UI shows `stopping` during drain.

**Consequences**:
- (+) "Did we send it?" remains answerable in the common case (we waited for the 200).
- (+) Worker crash is not required to interpret cancel; a restarted worker still sees the flag and does not start the next step.
- (–) Stop is not instant when an email is in flight. Users will wait up to the wait budget. That wait is the feature.
- (–) An in-memory-only AbortController is insufficient; the flag must be in the database.
- **Alternative rejected**: kill everything, mark the run cancelled, let reconciliation sort it out. Reconciliation then becomes the *primary* path instead of the crash path, and unknown becomes the typical cancel outcome. Support will not scale.
- **Alternative rejected**: two-phase commit with the mail API. They do not offer it.
- **Revisit trigger**: a tool provider adds a real, documented, working cancel-send API that can be invoked *after* accept. Then drain can call it. That is still a forward action, not a rollback. Do not assume Gmail/SendGrid/etc. have this; Phase 0 checks.

## ADR-002: Per-Attempt Idempotency Keys on All Tool Calls (Prevent Duplicates, Do Not Implement Undo)

**Status**: Accepted

**Context**: Cancel, crash, and retry are three names for "we might call the tool twice." Users also hit Send again after Stop, which is a *fourth* name and a *new run*. The system must distinguish "same attempt" from "new user action." Without a key, every recovery path is a potential second email. With a key, cancel still cannot unsend; it can only avoid a second send of the *same* attempt.

**Decision**: Every tool dispatch is keyed by `sha256(run_id : step_id : attempt : request_fingerprint)`, persisted in `tool_dispatches` *before* the HTTP call, and sent to the vendor if they support an idempotency header. A new `attempt` is allowed only after a *known non-apply*. Timeouts do not increment attempt. A new user message creates a new `run_id` and therefore new keys — sending again is allowed because the user asked again.

**Consequences**:
- (+) Crash-between-200-and-row-write can be recovered without a second email if the vendor honors the key, or at least without *us* issuing a different key.
- (+) Cancel-during-flight cannot spawn attempt 2 "because the first one was cancelled."
- (–) Keys do not undo. Product must not market Stop as undo.
- (–) Vendors without idempotency + without lookup make `unknown` unresolvable by machine. Then this ADR is a local fuse only; dual writers still double-send. Lease discipline remains mandatory.
- (–) `request_fingerprint` in the key makes "retry same attempt with fixed recipient" a deliberate new attempt, which is correct and annoying.
- **Alternative rejected**: use only `run_id` as the key. Then a legitimate second attempt after a hard 4xx cannot fire. Attempt belongs in the key.
- **Alternative rejected**: "the LLM's tool-call id is the idempotency key." Planner retries produce new ids; that is how you double-send with a clean conscience.

## ADR-003: Event-Sourced, Append-Only Billing Ledger over Compute-Cost-at-Completion

**Status**: Accepted

**Context**: The naive meter runs in `finally` after synthesize: if the run did not complete, charge 0 (user cancelled) or charge a flat "run fee." Both are wrong. Providers bill generated tokens whether or not we consumed the rest of the stream. Tools bill on accept. Completion is a UX state, not a cost state. Computing a single number at the end also fails when the process dies before `finally`.

**Decision**: Append a billing event when the fact is known (LLM usage trailer, tool dispatch/outcome). Cancel does not delete events. Invoice policy (charge cancelled runs in full, credit a percentage, waive cancelled-clean only) is a *read model* / credit adjustment, signed off by finance in Phase 3. True-ups are additional events, not in-place edits of amounts.

**Consequences**:
- (+) Finance can reconstruct a cancelled run from the ledger without logs.
- (+) Engineering cannot "fix" an angry customer by deleting rows and desynchronizing invoices.
- (–) The Stop button will not mean "free." Someone has to tell the user. If product refuses, they are choosing to eat vendor cost or to lie; the ledger still exists so the lie is a policy, not a bug.
- (–) Unconfirmed LLM usage needs an estimate + true-up path. Slight over-charge then credit is preferable to systematic under-charge of cancelled runs.
- **Alternative rejected**: bill a fixed price per run at start (prepay). Simpler accounting, hostile UX, still needs refunds on cancelled-clean. Possible later as a product; not this design's meter.
- **Revisit trigger**: the LLM vendor exposes a reliable "cancelled request billed 0" which none currently do as a contract you can bet an invoice on.

## ADR-004: Explicit `unknown` Outcome plus Reconciliation, not Assumed Success or Failure

**Status**: Accepted

**Context**: After dispatch, the possible facts are: it happened, it did not, we do not know. Timeouts, RSTs, 5xx, and process death are "we do not know." Assumed failure → retry → double email. Assumed success → skip reconciliation → support tells the user "it sent" when it did not (or we skip a retry that *should* happen for a read). The only honest third state is `unknown`.

**Decision**: Irreversible tool timeouts and crash-interrupted dispatches are `unknown`. The chain does not proceed to synthesize as if the email were a known fact. A reconciliation worker looks up by idempotency key / message id, or escalates to a human. Unknown is alertable. Resolution appends; it does not pretend the original terminal frame did not say unknown.

**Consequences**:
- (+) Retry logic has a real precondition: `failed` with known non-apply.
- (+) Support has a queue instead of a mystery.
- (–) Some fraction of cancelled runs will show a worse UX ("we could not confirm"). That fraction is the price of not lying. Drive it down by waiting out in-flight calls (ADR-001), not by guessing.
- (–) If the vendor cannot be queried, humans are in the loop. Budget that or do not offer the tool on a cancelable path.
- **Alternative rejected**: "optimistic success on timeout." Calms the dashboard, infuriates the recipient or the user unpredictably.
- **Alternative rejected**: "optimistic failure on timeout and auto-retry." The double-send.

## ADR-005: No Default Automatic Compensating Action

**Status**: Accepted

**Context**: Once the trap is understood, the next clever idea is a saga: if cancelled after send, automatically send a second email "please disregard," or pull a message from Gmail, or refund a charge. That second action is another irreversible side effect the user did not request, with its own cancel/crash races, and it often makes the situation *more* visible (two emails instead of one). Some tools have a real compensation API (void a hold, delete a draft). Many do not. "Email" in this scenario does not.

**Decision**: Compensation is opt-in, per-tool, explicit, and never the default for `send_email`. v1 records the side effect and tells the user. If a future tool is `create_draft` (not send), compensation might be `delete_draft` and can be a later ADR. If product insists on a retraction email, it is a *new* step with its own key, its own billing, and its own confirmation copy — and it should probably be a human/support action, not an automatic one on Stop.

**Consequences**:
- (+) v1 complexity stays on prevention of duplicates and honesty, which is the actual problem.
- (+) We do not send mail as a side effect of Stop.
- (–) Users who cancelled too late still have an email out. Product/support handle that with policy (apology, manual retraction), not with a hidden robot.
- **Alternative rejected**: generic saga framework in v1. It will be used once, for the retraction email, and it will misfire.

## ADR-006: Explicit Terminal-Frame Protocol; Socket Close Is Not Cancel

**Status**: Accepted

**Context**: Many streaming demos treat `req.on('close')` as cancel. Mobile networks close constantly. Users background tabs. CDNs idle-timeout. If close means cancel, runs become cancelled-by-tunnel while tools still fire (or get aborted into unknown) without user intent. Conversely, if the server dumps the TCP connection on cancel with no last frame, the client cannot distinguish error, complete, and cancelled, and will render a partial synthesize as a finished assistant message.

**Decision**: Cancel is an authenticated, explicit request that sets the durable flag. Connection drop does not set it (default). The stream always ends with a `terminal` frame whose `outcome` is one of the designed enums (or `completed` / `failed`). A `stopping` frame is sent as soon as cancel is persisted. Clients must render incomplete synthesize from the terminal frame. Reconnect by `run_id` + sequence is supported so a drop is not a Stop.

**Consequences**:
- (+) A train tunnel does not email-or-not based on TCP.
- (+) The client can show "An email was sent" instead of a generic error.
- (–) A user who closes the tab and *meant* that as Stop will not cancel until they reopen or until a product opt-in (`cancel_on_disconnect`). Document the default in UX copy.
- (–) SSE-only cancel is insufficient if the stream is stuck; a sidecar `POST /cancel` is required. Two channels must write the same flag.
- **Alternative rejected**: WebSocket ping as liveness-implies-cancel. Same as close, with extra failure modes.
- **Revisit trigger**: product explicitly wants "closing the tab stops the agent" as a workspace setting. Implement as setting the same flag from a short disconnect grace timer — still not a hard kill of `send_email`.
