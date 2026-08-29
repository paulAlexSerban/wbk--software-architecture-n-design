# Architecture Decision Records
> - **Document Status**: Draft
> - **Last Updated**: 2026 Aug 29
> - **Author**: Paul Serban

Each ADR follows: **Context → Decision → Consequences**. Status is `Accepted` unless noted otherwise.

## ADR-001: Server-Enforced Approval Gate Bound to a Content Hash; Never Trusted from LLM Output

**Status**: Accepted

**Context**: The obvious HITL implementation is a system prompt ("do not send until the user says approved") plus a `send_email` function the model may call, plus a UI confirm that sets a flag the next node reads. Research content, CRM notes, and the model's own chain-of-thought can all contain the word "approved" or a forged id. Prompt injection is not a theoretical add-on in an agent that *reads the web*. A UI flag the send path does not check is a decoration. A JSON field the model emitted is attacker-controlled.

**Decision**: `send_email` is not in the planner's tool list. The send adapter is a privileged operation. It may run only after loading an **effective** `approval_decisions` row for this `draft_version_id` whose stored `content_hash` equals the version that will be POSTed to the mail API. Approval records are inserted only by the approval service after authn/authz. The LLM cannot write that table. Model output that looks like an approval is ignored.

**Consequences**:
- (+) Injection that says "send now" cannot mint capability. The worst it can do is produce a draft a human still has to pass.
- (+) The send path has a single check to audit and to test.
- (–) The agent cannot "just send" for trusted power users without a second product. That is intentional.
- (–) Two systems (drafter and sender) instead of one chat loop. Slightly more wiring.
- **Alternative rejected**: keep `send_email` as a tool and "validate arguments." The model still chooses *when* to call it. Injection is about *when*, not only about recipient format.
- **Alternative rejected**: trust `approved: true` in the model's structured output. That is letting the prisoner write the parole letter.
- **Revisit trigger**: a future runtime with hardware-isolated tool permissions and a non-LLM policy engine already in front of every tool. Then this ADR is still the policy; the runtime becomes the enforcement. Do not skip the ledger because the runtime is new.

## ADR-002: Durable, Resumable Pause over In-Memory Await (or Engine Wait-that-Continues)

**Status**: Accepted

**Context**: Approval takes minutes to days. Process restarts, deploys, and n8n/Temporal worker crashes happen on that timescale. An in-process `await webhook` dies with the process: either the wait is lost (requester thinks it is pending; nothing is) or the engine retries the whole graph and sends. Default Wait-node behavior in several tools is **continue on timeout**, which is an automatic send.

**Decision**: `PENDING_APPROVAL` is a durable run status with an `approval_requests` row. The work lease is **released** while waiting. Restarted workers must not send. Timeout of the *request* is handled by [ADR-006](./04_architecture_decision_records.md#adr-006) as deny, not as resume-next-node. n8n or Temporal may host the graph only if the wait is a durable external state and the send node is the adapter (ledger check), not "the next node after Wait."

**Consequences**:
- (+) Deploys during a two-day wait are boring.
- (+) Duplicate notifications are possible and allowed; duplicate sends are not.
- (–) You need a wakeup (queue or poll) after decision. Polling every 30s is acceptable at this volume; hours-long poll is not (approver thinks Approve is broken).
- (–) You cannot "just use n8n Wait" as the design. The canvas is not the ledger.
- **Alternative rejected**: in-memory wait with a long HTTP timeout. Will not survive a deploy.
- **Alternative rejected**: engine-native Wait with continue-on-timeout. That is Sequence C's incident.
- **Revisit trigger**: the team already runs Temporal with `CancellationType`/`Wait` that cannot proceed to send without a signal, *and* send still goes through the adapter. The ledger remains; the host changes.

## ADR-003: Approval Binds to an Immutable Draft Version; Edits Mint a New Version

**Status**: Accepted

**Context**: Reviewers request changes. Agents rewrite. Approvers edit a textarea. If approval is a boolean on the run, the bytes that go out are "whatever is in memory at send time." That is how last week's draft, or an unreviewed fix-up, ships with a clean audit that says "approved."

**Decision**: Each draft is insert-only. `content_hash` covers the canonical send payload ([System Design §2](./03_system_design.md#2-content-hash-binding-contract)). An `approval_requests` row names a `draft_version_id` and stores a copy of the hash. Approve must present `expected_content_hash`. Send re-checks. There is no in-place edit. Redraft is version n+1 and a new request. v1 of this design does not "edit and approve" without creating a new version and re-running guardrails in the same transaction.

**Consequences**:
- (+) Audit answers "which bytes."
- (+) Stale UI tabs fail closed (hash mismatch).
- (–) Reviewer UX is stricter. Fixing a typo is a new version (and in v1, a new wait, unless we later add edit-and-approve as a guarded transaction).
- (–) Canonicalizer bugs change hashes; version the canonicalizer id.
- **Alternative rejected**: mutable `draft_text` column plus `approved_at`. The race is the product.
- **Alternative rejected**: hash only the subject line "because the body is long." Then the body is unreviewed for the purpose of the gate.

## ADR-004: Automated Guardrails Run Pre-Review and Are Non-Bypassable by Human Approval

**Status**: Accepted

**Context**: "A human is in the loop" is used to skip policy: dump the draft on a tired AE and call it compliance. Humans miss PII, header injection, and wrong domains, especially on phones. Conversely, sending a failing draft to a human trains them to click through warnings. Break-glass "send anyway" becomes the only well-worn path.

**Decision**: Guardrail check runs on every draft version **before** an approval request is created. Fail → no request, no notify (except maybe notify the *requester* that policy failed), no send. An approver cannot override a failed check in v1. There is no `override=true`. If a later product needs break-glass, it is a new ADR: a distinct role, a distinct audit event, a distinct cooling-off, and it still will not be the LLM.

**Consequences**:
- (+) Humans review only policy-passing drafts. Their job is tone, factual fit, "should we email this person," not catching `Bcc: press@`.
- (+) Policy has a testable, non-social enforcement point.
- (–) False positives block outreach until a rule is fixed. That is the point of fail closed; tune rules in Phase 2, do not add override to "unblock."
- (–) Guardrails will have gaps (especially PII). HITL is the remaining net, not a reason to skip the net you can automate.
- **Alternative rejected**: warn-and-continue in the approval UI. That is override with extra CSS.
- **Alternative rejected**: LLM-as-judge only, no deterministic rules. Models miss and can be injected. Deterministic rules first.

## ADR-005: Idempotent, Dispatch-Ledger-Based Send Keyed by Run / Draft Version / Attempt

**Status**: Accepted

**Context**: Approve is a button. Buttons double-fire. Two reviewers race. The send worker starts twice. The process crashes after the mail API 200. Without a key, every recovery is a second email. The approval unique index is necessary and not sufficient: send might still be invoked twice *after* a single effective approve.

**Decision**: Before any mail HTTP call, insert `send_dispatches` with `idempotency_key = sha256(run_id : draft_version_id : attempt : content_hash)`, persist, then call, then record outcome. Pass the key to the vendor when Phase 0 says they honor it. New `attempt` only after known non-apply. Timeouts stay `unknown` and do not mint a new key. Second Approve does not mint a new key.

**Consequences**:
- (+) Double-approve and double-wakeup collapse to one send in the common case.
- (+) Crash-between-200-and-row can be recovered without a second email if the vendor honors the key, or at least without *us* issuing a different key.
- (–) Keys do not unsend. The gate reduces sends that should not happen; it does not roll back those that did.
- (–) Vendors without idempotency + without lookup make `unknown` human-resolved. Lease discipline remains mandatory.
- **Alternative rejected**: "the approval_decision_id is unique so we don't need a dispatch table." The decision and the HTTP call are separated by a crash.
- **Alternative rejected**: use only `run_id` as the key. Then a legitimate send of v2 after reject of v1 cannot fire.

## ADR-006: Expiry-Denies-by-Default for Unactioned Pending Approvals

**Status**: Accepted

**Context**: The tempting SLA hack is: if no reviewer acts in N hours, send anyway, or "send the draft, it was probably fine." That is unsupervised send with extra latency. It also trains the org not to review. n8n's default wait-timeout-continue is this ADR's villain.

**Decision**: `expires_at` on the request. A worker (or the decision UPDATE's `expires_at > now()` predicate) closes `open` requests as `expired`. Run status `expired`. No send. A subsequent Approve is `stale`. TTL default in this scenario: 48 hours. Product may shorten or lengthen the TTL. Product may not add a "on timeout, send" flag to this architecture. Warning alerts fire *before* expiry so humans can still act.

**Consequences**:
- (+) "Nobody looked" cannot become a customer email.
- (+) Late clicks after a weekend do not silently send Monday's stale draft without a new hash/review.
- (–) Outreach dies if reviewers are away. That is a staffing/coverage problem. On-call for approvals is a product choice; auto-send is not the coverage plan.
- (–) Requesters will hate expired runs. They restart. Research tokens are spent again (or you add a "reopen with same version, new TTL, same hash, new request" — allowed, still no send without a fresh approve). Reopen-same-version is a small later feature; it must still require a new effective approve.
- **Alternative rejected**: timeout-send. Conflicts with the entire project.
- **Alternative rejected**: never expire (pending forever). Operationally a graveyard; also a late Approve of a draft written against stale CRM facts. Expiry forces a revisit.

## ADR-007: Role-Scoped Approver Authorization; Self-Approval Disallowed

**Status**: Accepted

**Context**: "Any authenticated user" means the requester clicks Approve on their phone. That is a confirm UX, not a second pair of eyes, and it will be sold as HITL. Slack channel membership is also not a role: channels accumulate spectators. Self-approval is the default failure mode of small teams.

**Decision**: The decision endpoint requires `actor_id` in `approver_bindings` (or equivalent role). `actor_id != run.requester_id`. Self-approval is 403 and audited. If the organization has one human, they do not get to call this HITL; they need a different, honest product (server-enforced confirm-before-send, still hashed, still no model-owned send) without claiming a reviewer existed.

**Consequences**:
- (+) Audit can show separation of duty.
- (+) Spectators in Slack cannot approve unless bound.
- (–) Solo founders / tiny teams cannot use this exact policy. Do not weaken the ADR to make the demo work with one login. Use two test identities in Phase 3.
- (–) Bindings can rot (ex-employees still in the table). Phase 5 includes deprovisioning. Stale bindings are an incident class.
- **Alternative rejected**: requester may approve "for drafts below risk X." v1 has one risk class: sending mail. Split later if needed.
- **Alternative rejected**: Slack reaction as approval without mapping to `actor_id`. Emoji are not identity.
- **Revisit trigger**: explicit product signature for self-approval on a personal sandbox workspace, clearly labeled, never the default for a shared workspace.
